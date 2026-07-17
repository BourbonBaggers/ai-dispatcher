/**
 * Issue selection and queue behaviour.
 *
 * Ported from the embedded dispatcher's selectEligibleIssue (#188/#249/#281). The
 * dispatcher is strictly serial; when no run is active, each scan walks the open
 * issues oldest-first, marks each eligible or ineligible, and chooses the next
 * eligible issue by priority tier (queue-jump, then regular, then technical-debt),
 * preserving oldest-first order within a tier.
 *
 * This module is deliberately pure: the caller supplies the already-resolved
 * suppression / deferral / claim facts (and their human reasons), so selection has no
 * dependency on the token-exhaustion or failure-policy internals and is trivially
 * testable.
 */

import {
  DISPATCHER_PRIORITY_TIERS,
  HOLD_LABELS,
  WORKING_LABEL,
  resolveAssignment,
  resolvePriorityTier,
  type DispatcherPriorityTier,
  type ResolvedAssignment,
} from "./labels.ts";
import type { GithubIssue } from "./github.ts";

export interface DispatcherCandidate {
  issueNumber: number;
  issueTitle: string;
  eligible: boolean;
  reason: string;
}

export interface SelectionTarget {
  issue: GithubIssue;
  assignment: ResolvedAssignment;
  staleWorkingLabel: boolean;
  priorityTier: DispatcherPriorityTier;
  issueIndex: number;
}

export interface SelectionContext {
  /** True when the given agent's provider is currently in a token cooldown. */
  providerSuppressed(agent: "codex" | "claude"): boolean;
  /** Human reason for a suppressed provider (e.g. "Claude is out of tokens — paused until …"). */
  suppressedReason(agent: "codex" | "claude"): string;
  /** issueNumber → status of an existing claiming run (claimed/running/interrupted/…). */
  claimedByIssue: Map<number, string>;
  /** issueNumber → human reason a failure deferral is currently blocking it. */
  deferredByIssue: Map<number, string>;
}

/**
 * Evaluates every issue, returning a per-issue eligibility verdict plus the single
 * highest-priority eligible target (or null).
 */
export function selectEligibleIssue(
  issues: GithubIssue[],
  context: SelectionContext,
): { candidates: DispatcherCandidate[]; target: SelectionTarget | null } {
  const candidates: DispatcherCandidate[] = [];
  const targets: SelectionTarget[] = [];

  for (const [issueIndex, issue] of issues.entries()) {
    const assignment = resolveAssignment(issue.labels);

    if (!assignment.ok) {
      candidates.push(ineligible(issue, assignment.reason));
      continue;
    }

    const agent = assignment.value.agent;

    if (context.providerSuppressed(agent)) {
      candidates.push(ineligible(issue, context.suppressedReason(agent)));
      continue;
    }

    const held = HOLD_LABELS.filter((label) => issue.labels.includes(label));
    if (held.length > 0) {
      candidates.push(
        ineligible(issue, `held for a human (${held.join(", ")}) — moving on to the next issue`),
      );
      continue;
    }

    const deferralReason = context.deferredByIssue.get(issue.number);
    if (deferralReason) {
      candidates.push(ineligible(issue, deferralReason));
      continue;
    }

    const existing = context.claimedByIssue.get(issue.number);
    if (existing) {
      candidates.push(
        ineligible(
          issue,
          `already has a ${existing} dispatcher run — resume it instead of starting over`,
        ),
      );
      continue;
    }

    const staleWorkingLabel = issue.labels.includes(WORKING_LABEL);
    const priorityTier = resolvePriorityTier(issue.labels);
    candidates.push({
      issueNumber: issue.number,
      issueTitle: issue.title,
      eligible: true,
      reason: `ready for ${agent} (${assignment.value.cliModel}, effort ${assignment.value.cliEffort})`,
    });

    targets.push({ issue, assignment: assignment.value, staleWorkingLabel, priorityTier, issueIndex });
  }

  const target =
    targets.sort((a, b) => {
      const priorityDelta =
        DISPATCHER_PRIORITY_TIERS.indexOf(a.priorityTier) -
        DISPATCHER_PRIORITY_TIERS.indexOf(b.priorityTier);
      return priorityDelta || a.issueIndex - b.issueIndex;
    })[0] ?? null;

  return { candidates, target };
}

function ineligible(issue: GithubIssue, reason: string): DispatcherCandidate {
  return { issueNumber: issue.number, issueTitle: issue.title, eligible: false, reason };
}
