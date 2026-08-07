/**
 * The post-ship acceptance audit sweep (#85).
 *
 * Runs OUTSIDE the ship path, over issues that already shipped. That placement is the
 * whole design: ship never waits on the judge, so a judge outage delays an audit rather
 * than a deploy, and "the judge was unavailable" needs no special policy — the next sweep
 * picks the issue up. The predecessor ran before merge and could exhaust a run (#84).
 *
 * Idempotency is durable, not incidental. A sweep can revisit the same shipped run after a
 * restart, a reconcile, or a `finalizationPending` replay, so:
 *   - the run record carries the audit's own status and any issue it created;
 *   - the record is marked BEFORE the follow-up is filed, so a crash between the two
 *     cannot silently re-file on the next pass; and
 *   - an open follow-up referencing the same parent is found by label search as a backstop
 *     for records written before that marking landed.
 * A failed GitHub read is never treated as "no follow-up exists" — that would duplicate.
 */

import {
  AUDIT_FOLLOWUP_LABEL,
  auditDepth,
  auditDepthLabel,
  decideAudit,
  followUpIssueBody,
  parentClosureComment,
  type AuditDecision,
  type CriterionVerdict,
} from "./acceptance-audit.ts";
import { extractAcceptanceCriteria } from "./acceptance-criteria.ts";
import { DISPATCH_READY_LABEL } from "./labels.ts";
import type { Logger } from "./logger.ts";
import type { Notifier } from "./notify.ts";

/** Marker the dedupe search looks for; also the follow-up body's first line. */
export function followUpMarker(parentIssue: number): string {
  return `Audit follow-up for #${parentIssue}`;
}

export interface AuditGithub {
  issueBody(issue: number): Promise<string | null>;
  issueLabels(issue: number): Promise<string[] | null>;
  prDiff(pr: number): Promise<string | null>;
  comment(issue: number, body: string): Promise<boolean>;
  createIssue(request: {
    title: string;
    body: string;
    labels: readonly string[];
  }): Promise<number | null>;
  issuesWithLabel(label: string): Promise<{ number: number; body: string }[] | null>;
}

export interface AuditSubject {
  issueNumber: number;
  issueTitle: string;
  prNumber: number;
}

export interface AuditDeps {
  github: AuditGithub;
  judge(request: {
    issueTitle: string;
    issueBody: string;
    diff: string;
    criteria: readonly string[];
  }): Promise<CriterionVerdict[]>;
  logger: Logger;
  notifier: Notifier;
  /** Called once the audit is durably resolved, before any follow-up is filed. */
  markAudited(subject: AuditSubject, followUpIssue: number | null): void;
}

export type AuditOutcome =
  | { action: "skipped"; reason: string }
  | { action: "unavailable"; reason: string }
  | { action: "clean" }
  | { action: "filed"; issue: number }
  | { action: "commented"; issue: number }
  | { action: "notified"; reason: string };

/** Labels a follow-up carries. All are constants — never derived from judge output. */
export function followUpLabels(depth: number): string[] {
  // `dispatch:ready` admits the follow-up as ordinary work; it routes on its own
  // characteristics like any other issue. The depth label is what bounds generation.
  return [AUDIT_FOLLOWUP_LABEL, auditDepthLabel(depth), DISPATCH_READY_LABEL];
}

function followUpTitle(parentIssue: number, parentTitle: string): string {
  const base = `Audit follow-up for #${parentIssue}: ${parentTitle}`;
  return base.length > 240 ? `${base.slice(0, 237)}...` : base;
}

/**
 * Finds an already-open follow-up for this parent.
 *
 * Returns `undefined` for "none found" and `null` for "could not tell". The caller must
 * treat null as a reason to stand down, not as permission to file.
 */
async function existingFollowUp(
  github: AuditGithub,
  parentIssue: number,
): Promise<number | undefined | null> {
  const open = await github.issuesWithLabel(AUDIT_FOLLOWUP_LABEL);
  if (open === null) return null;
  const marker = followUpMarker(parentIssue);
  return open.find((issue) => issue.body.includes(marker))?.number;
}

export async function auditShippedIssue(
  deps: AuditDeps,
  subject: AuditSubject,
): Promise<AuditOutcome> {
  const { github, logger } = deps;

  const [body, labels, diff] = await Promise.all([
    github.issueBody(subject.issueNumber),
    github.issueLabels(subject.issueNumber),
    github.prDiff(subject.prNumber),
  ]);

  // An unreadable input is not evidence of an omission. Leave the run unmarked so the
  // next sweep retries; nothing about delivery depends on this completing now.
  if (body === null || labels === null || diff === null) {
    return { action: "unavailable", reason: "issue or PR evidence could not be read" };
  }

  const criteria = extractAcceptanceCriteria(`${subject.issueTitle}\n${body}`);
  if (criteria.length === 0) {
    deps.markAudited(subject, null);
    return { action: "skipped", reason: "issue states no acceptance criteria" };
  }

  const verdicts = await deps.judge({
    issueTitle: subject.issueTitle,
    issueBody: body,
    diff,
    criteria,
  });

  const found = await existingFollowUp(github, subject.issueNumber);
  if (found === null) {
    return { action: "unavailable", reason: "existing follow-up could not be checked" };
  }

  const decision: AuditDecision = decideAudit({
    parentIssue: subject.issueNumber,
    verdicts,
    parentDepth: auditDepth(labels),
    existingFollowUp: found,
  });

  switch (decision.action) {
    case "none":
      deps.markAudited(subject, null);
      return { action: "clean" };

    case "comment_existing":
      deps.markAudited(subject, decision.issue);
      await github
        .comment(
          decision.issue,
          [
            `A repeat audit of #${subject.issueNumber} still finds these criteria unaddressed:`,
            "",
            ...decision.omissions.map((omission) => `- ${omission.criterion}`),
          ].join("\n"),
        )
        .catch(() => false);
      return { action: "commented", issue: decision.issue };

    case "notify":
      // The depth cap is the one place this design involves a human, and only because two
      // independent agents plus the audit failed to converge on a stated criterion.
      deps.markAudited(subject, null);
      await deps.notifier
        .send(`Audit depth cap reached on #${subject.issueNumber}`, decision.reason, 4)
        .catch(() => undefined);
      logger.warn("audit: depth cap reached; not filing further follow-up work", {
        issue: subject.issueNumber,
        omissions: decision.omissions.length,
      });
      return { action: "notified", reason: decision.reason };

    case "file": {
      const created = await github.createIssue({
        title: followUpTitle(subject.issueNumber, subject.issueTitle),
        body: followUpIssueBody(
          subject.issueNumber,
          subject.issueTitle,
          decision.omissions,
          decision.depth,
        ),
        labels: followUpLabels(decision.depth),
      });
      if (created === null) {
        // Creation failed; leaving the run unmarked lets the next sweep try again.
        return { action: "unavailable", reason: "follow-up issue could not be created" };
      }
      deps.markAudited(subject, created);
      await github
        .comment(subject.issueNumber, parentClosureComment(created, decision.omissions))
        .catch(() => false);
      logger.info("audit: filed follow-up work for unaddressed criteria", {
        issue: subject.issueNumber,
        followUp: created,
        omissions: decision.omissions.length,
      });
      return { action: "filed", issue: created };
    }
  }
}
