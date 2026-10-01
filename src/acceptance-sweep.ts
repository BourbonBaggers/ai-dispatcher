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
 *
 * Every read happens before the judge runs (#98). The judge call is the one expensive
 * step, so it is spent only on complete evidence; a failed read ends the attempt, and the
 * sweep backs off before trying again. A diff GitHub refuses as too large is not a failed
 * read: it is permanent for the PR, so the audit reads the PR's changed-file list instead.
 */

import {
  AUDIT_FOLLOWUP_LABEL,
  AUDIT_MAX_DEPTH,
  auditDepth,
  auditDepthLabel,
  decideAudit,
  followUpIssueBody,
  parentClosureComment,
  type AuditDecision,
  type CriterionVerdict,
} from "./acceptance-audit.ts";
import { extractAcceptanceCriteria } from "./acceptance-criteria.ts";
import { changedFilesEvidence, type AuditEvidenceKind } from "./acceptance-evidence.ts";
import { creationFailureSignature, type AuditFailure } from "./acceptance-retry.ts";
import type {
  GithubCreatedIssue,
  GithubLabelSpec,
  GithubPrDiff,
  GithubPrFile,
} from "./github.ts";
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
  prDiff(pr: number): Promise<GithubPrDiff>;
  prFiles(pr: number): Promise<GithubPrFile[] | null>;
  comment(issue: number, body: string): Promise<boolean>;
  createIssue(request: {
    title: string;
    body: string;
    labels: readonly string[];
  }): Promise<GithubCreatedIssue>;
  createLabel(label: GithubLabelSpec): Promise<boolean>;
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
    evidence: AuditEvidenceKind;
  }): Promise<CriterionVerdict[]>;
  logger: Logger;
  notifier: Notifier;
  /** Called once the audit is durably resolved, before any follow-up is filed. */
  markAudited(subject: AuditSubject, followUpIssue: number | null): void;
}

export type AuditOutcome =
  | { action: "skipped"; reason: string }
  // The sweep records this as a failed attempt; a signature marks a deterministic failure.
  | ({ action: "unavailable" } & AuditFailure)
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

/**
 * How the audit creates one of its own labels in a repository that lacks it (#98). Only
 * the constants `followUpLabels` produces have a spec, so nothing else can be created.
 * Colors and descriptions match the labels first created by hand for #85.
 */
export function followUpLabelSpec(name: string): GithubLabelSpec | null {
  if (name === AUDIT_FOLLOWUP_LABEL) {
    return { name, color: "0E8A16", description: "Filed by the post-ship acceptance audit (#85)" };
  }
  if (name === DISPATCH_READY_LABEL) {
    return {
      name,
      color: "0E8A16",
      description: "Provider-neutral dispatcher admission using default workload characteristics",
    };
  }
  const depth = auditDepth([name]);
  if (depth > 0 && name === auditDepthLabel(depth)) {
    return {
      name,
      color: "C2E0C6",
      description:
        depth >= AUDIT_MAX_DEPTH
          ? `Audit follow-up generation depth; depth ${depth} may not file further follow-ups`
          : `Audit follow-up generation depth ${depth}`,
    };
  }
  return null;
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

/**
 * The PR's diff, or its changed-file list when GitHub refuses the diff as too large.
 * Returns what could not be read instead when neither is available.
 */
async function readPrEvidence(
  deps: AuditDeps,
  subject: AuditSubject,
): Promise<{ kind: AuditEvidenceKind; text: string } | { unread: string }> {
  const diff = await deps.github.prDiff(subject.prNumber);
  if (diff.state === "ok") return { kind: "diff", text: diff.diff };
  if (diff.state === "unavailable") return { unread: `PR diff (${diff.error})` };

  const files = await deps.github.prFiles(subject.prNumber);
  if (files === null || files.length === 0) {
    return { unread: "PR changed-file list (its diff is too large)" };
  }
  deps.logger.info("audit: PR diff too large; auditing its changed-file list", {
    issue: subject.issueNumber,
    pr: subject.prNumber,
    files: files.length,
  });
  return { kind: "changed-files", text: changedFilesEvidence(files) };
}

/**
 * Files the follow-up. gh resolves every label before it creates anything, so a repository
 * that never had the audit's labels fails every filing the same way — what kept #728's
 * audit retrying in production. Those labels are this module's constants, so the audit
 * creates whichever are missing (never altering one that exists) and files once more.
 */
async function createFollowUp(
  deps: AuditDeps,
  request: { title: string; body: string; labels: readonly string[] },
): Promise<GithubCreatedIssue> {
  const first = await deps.github.createIssue(request);
  if (first.ok || first.missingLabel === undefined) return first;
  const missing = first.missingLabel.toLowerCase();
  if (!request.labels.some((label) => label.toLowerCase() === missing)) return first;

  const notCreated: string[] = [];
  for (const label of request.labels) {
    const spec = followUpLabelSpec(label);
    if (spec === null || !(await deps.github.createLabel(spec))) notCreated.push(label);
  }
  deps.logger.info("audit: created missing follow-up labels before filing", {
    missing: first.missingLabel,
    ...(notCreated.length === 0 ? {} : { notCreated }),
  });

  const retried = await deps.github.createIssue(request);
  if (retried.ok || notCreated.length === 0) return retried;
  return { ...retried, error: `${retried.error} (could not create label ${notCreated.join(", ")})` };
}

export async function auditShippedIssue(
  deps: AuditDeps,
  subject: AuditSubject,
): Promise<AuditOutcome> {
  const { github, logger } = deps;

  // An unreadable input is not evidence of an omission. Leave the audit pending; the sweep
  // backs off and retries, and nothing about delivery depends on this completing now.
  const body = await github.issueBody(subject.issueNumber);
  if (body === null) return { action: "unavailable", reason: "could not read the issue body" };

  // Settled before any PR read: an issue without criteria needs no other evidence.
  const criteria = extractAcceptanceCriteria(`${subject.issueTitle}\n${body}`);
  if (criteria.length === 0) {
    deps.markAudited(subject, null);
    return { action: "skipped", reason: "issue states no acceptance criteria" };
  }

  // The follow-up search is read here too. It used to run after the judge, so its failure
  // threw away a verdict that every retry then paid for again.
  const [labels, evidence, found] = await Promise.all([
    github.issueLabels(subject.issueNumber),
    readPrEvidence(deps, subject),
    existingFollowUp(github, subject.issueNumber),
  ]);
  if (labels === null || "unread" in evidence || found === null) {
    const unread = [
      ...(labels === null ? ["issue labels"] : []),
      ...("unread" in evidence ? [evidence.unread] : []),
      ...(found === null ? ["existing audit follow-ups"] : []),
    ];
    return { action: "unavailable", reason: `could not read ${unread.join(", ")}` };
  }

  const verdicts = await deps.judge({
    issueTitle: subject.issueTitle,
    issueBody: body,
    diff: evidence.text,
    criteria,
    evidence: evidence.kind,
  });

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
      const created = await createFollowUp(deps, {
        title: followUpTitle(subject.issueNumber, subject.issueTitle),
        body: followUpIssueBody(
          subject.issueNumber,
          subject.issueTitle,
          decision.omissions,
          decision.depth,
        ),
        labels: followUpLabels(decision.depth),
      });
      if (!created.ok) {
        // The verdict is not kept, so a retry judges again. The sweep's backoff, and treating
        // the same creation failure twice as permanent, keep that to a few calls (#98).
        const signature = creationFailureSignature(created.error);
        return {
          action: "unavailable",
          reason: `follow-up issue could not be created: ${created.error}`,
          ...(signature === undefined ? {} : { signature }),
        };
      }
      deps.markAudited(subject, created.issue);
      await github
        .comment(subject.issueNumber, parentClosureComment(created.issue, decision.omissions))
        .catch(() => false);
      logger.info("audit: filed follow-up work for unaddressed criteria", {
        issue: subject.issueNumber,
        followUp: created.issue,
        omissions: decision.omissions.length,
      });
      return { action: "filed", issue: created.issue };
    }
  }
}
