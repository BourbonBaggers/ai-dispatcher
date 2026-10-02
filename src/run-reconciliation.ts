/**
 * Reconciling an interrupted or failed run with the work its branch already carries (#109).
 *
 * A launch can end without a clean PR-ready result while its work is finished and
 * published: the launcher may object to a file that is not part of the work, a restart may
 * kill the launcher while it waits for CI, or the provider may exit badly after its last
 * push. Relaunching such a run spends agent attempts on work that is done. In
 * internal-tools #773 eight relaunches of a green, mergeable PR were then presented as
 * model failures and held for an operator, who merged the PR unchanged.
 *
 * So before a run is relaunched or charged a model failure, the dispatcher gathers three
 * pieces of evidence -- GitHub's PR for the branch, the preserved checkout, and the plan --
 * and decides here, without IO:
 *
 *   - deliver:  the branch's PR already carries the finished work. Autoship takes it over
 *               and owns every remaining state: it ships green checks, parks pending ones,
 *               repairs red or conflicted PRs, and promotes a draft. No agent is launched
 *               and no repair budget is spent.
 *   - relaunch: there is no PR, the checkout holds work the PR lacks, or nothing proves the
 *               work finished. The saved checkout resumes exactly as before.
 *   - wait:     GitHub could not say. Unknown is never proof either way, so nothing is
 *               relaunched or charged; the next scan asks again.
 *
 * A green PR alone does not prove the work finished: the launcher opens a PR for whatever
 * commits a killed run left behind. Finished needs the agent's own clean exit or a plan
 * whose every milestone is [DONE] -- and never with local commits or edits the PR lacks.
 */

import type { GithubBranchPullRequest } from "./github.ts";

export type BranchPullRequest = GithubBranchPullRequest;

/** How far a plan has come: milestone headers, and how many carry a [DONE] marker. */
export interface PlanProgress {
  /** Checkout-relative path of the plan that was read. */
  path: string;
  total: number;
  done: number;
}

/** What the preserved checkout holds, read without changing it. */
export type CheckoutSnapshot =
  | {
      state: "present";
      /** Full SHA of the checkout's HEAD. */
      head: string;
      /** `git status --porcelain` lines for the agent's own work (bounded). */
      dirty: string[];
      plan: PlanProgress | null;
    }
  | { state: "missing" }
  | { state: "unknown"; reason: string };

/** Why a branch's PR may be delivered without another launch. */
export type DeliveryBasis = "merged" | "agent-finished" | "plan-complete";

export interface ReconcileEvidence {
  /** The PR chosen for the branch; null when it has none, `unknown` when unreadable. */
  pr: BranchPullRequest | null | "unknown";
  /** The preserved checkout; read only when the PR is open (null otherwise). */
  checkout: CheckoutSnapshot | null;
  /** Whether the PR head contains the checkout's HEAD; null when it could not be told. */
  published: boolean | null;
  /**
   * The last launch ended in the launcher's own unpublished-work recovery (exit 75). The
   * launcher can only reach that state with an unpublished commit or a dirty tail left by
   * a clean provider exit, so once the checkout shows neither, the agent had finished.
   */
  agentFinished: boolean;
}

export type ReconcileDecision =
  | { action: "deliver"; pr: BranchPullRequest; basis: DeliveryBasis; reason: string }
  | { action: "relaunch"; reason: string }
  | { action: "wait"; reason: string };

/**
 * A milestone header in the plan convention every launch prompt states: `## Milestone N:
 * Title`, completed by prepending `[DONE]`. A header must carry a number, so a section
 * called "Milestones" or a placeholder `Milestone N` is not mistaken for unfinished work.
 */
const MILESTONE_HEADER = /^#{1,6}\s.*\bmilestone\s+\d+/i;
const DONE_MARKER = /\[DONE\]/i;

export function planMilestoneProgress(text: string): { total: number; done: number } {
  let total = 0;
  let done = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!MILESTONE_HEADER.test(line)) continue;
    total += 1;
    if (DONE_MARKER.test(line)) done += 1;
  }
  return { total, done };
}

export function planIsComplete(progress: Pick<PlanProgress, "total" | "done">): boolean {
  return progress.total > 0 && progress.done === progress.total;
}

/**
 * The PR that represents a branch's delivery. A merged PR always wins: once a branch has
 * merged, that PR stays its delivery identity, exactly as the launcher reports it. Then
 * the PR the run already knows, if still open, then the newest open one. A branch whose
 * PRs were all closed unmerged has no delivery to resume.
 */
export function selectBranchPullRequest(
  prs: readonly BranchPullRequest[],
  knownPr: number | null,
): BranchPullRequest | null {
  const newestFirst = [...prs].sort((a, b) => b.number - a.number);
  const merged = newestFirst.find((pr) => pr.state === "merged");
  if (merged) return merged;
  const known = newestFirst.find((pr) => pr.number === knownPr && pr.state === "open");
  if (known) return known;
  return newestFirst.find((pr) => pr.state === "open") ?? null;
}

function relaunch(reason: string): ReconcileDecision {
  return { action: "relaunch", reason };
}

export function decideReconciliation(evidence: ReconcileEvidence): ReconcileDecision {
  const { pr, checkout, published, agentFinished } = evidence;
  if (pr === "unknown") {
    return { action: "wait", reason: "GitHub could not report the branch's pull requests" };
  }
  if (pr === null) return relaunch("the branch has no open or merged pull request");
  if (pr.state === "merged") {
    // Merged work is delivered regardless of what the checkout holds: deploying and
    // verifying that exact merge is autoship's job, and relaunching on a merged branch
    // could only produce a replacement PR for it.
    return {
      action: "deliver",
      pr,
      basis: "merged",
      reason: `PR #${pr.number} is already merged`,
    };
  }
  if (pr.state === "closed") return relaunch(`PR #${pr.number} was closed without merging`);

  if (checkout === null || checkout.state === "unknown") {
    return relaunch(
      `the preserved checkout could not be inspected${checkout?.state === "unknown" ? ` (${checkout.reason})` : ""}`,
    );
  }
  if (checkout.state === "present") {
    // Never let autoship ship a PR that lacks local work: the dirty tail or unpushed
    // commits would be silently dropped. The agent is relaunched to publish them.
    if (published === false) {
      return relaunch(`the checkout has commits that PR #${pr.number} does not contain`);
    }
    if (published !== true) {
      return relaunch(`could not prove that PR #${pr.number} contains the checkout's commits`);
    }
    if (checkout.dirty.length > 0) {
      const shown = checkout.dirty.slice(0, 3).map((line) => line.slice(3)).join(", ");
      const more = checkout.dirty.length > 3 ? `, and ${checkout.dirty.length - 3} more` : "";
      return relaunch(`the checkout has uncommitted changes (${shown}${more})`);
    }
  }

  if (agentFinished) {
    return {
      action: "deliver",
      pr,
      basis: "agent-finished",
      reason:
        checkout.state === "missing"
          ? `the agent ended its turn cleanly and PR #${pr.number} is the only remaining copy of its work`
          : `the agent ended its turn cleanly and PR #${pr.number} contains every commit in the checkout`,
    };
  }
  if (checkout.state === "present" && checkout.plan && planIsComplete(checkout.plan)) {
    return {
      action: "deliver",
      pr,
      basis: "plan-complete",
      reason: `every milestone in ${checkout.plan.path} is marked [DONE] and PR #${pr.number} contains every commit in the checkout`,
    };
  }
  if (checkout.state === "missing") {
    return relaunch("the checkout is gone and nothing shows the agent finished");
  }
  if (checkout.plan) {
    return relaunch(
      `${checkout.plan.path} still has ${checkout.plan.total - checkout.plan.done} milestone(s) without [DONE]`,
    );
  }
  return relaunch("no plan in the checkout marks its milestones [DONE]");
}

/** The issue comment posted when reconciliation hands a run's PR to autoship. */
export function reconciledDeliveryComment(
  run: { branch: string },
  decision: Extract<ReconcileDecision, { action: "deliver" }>,
): string {
  return [
    `## Dispatcher: finished work found on PR #${decision.pr.number}`,
    "",
    `The last launch on \`${run.branch}\` did not end with a clean PR-ready result, but its ` +
      `work is already delivered: ${decision.reason}.`,
    "",
    `Resuming autoship for PR #${decision.pr.number} instead of relaunching the agent. ` +
      "No model repair or frontier budget was spent; autoship re-checks CI and mergeability " +
      "and takes the matching path from here.",
  ].join("\n");
}
