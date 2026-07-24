/**
 * The allowlist that separates GitHub labels from the shell.
 *
 * Issue labels are untrusted input. Nothing from a label is ever passed to a
 * command: a label is only ever *looked up* in these frozen maps, and it is the
 * map's value — a constant defined in this file — that reaches the CLI. An
 * unknown label therefore cannot smuggle an argument through; it just fails to
 * resolve and the issue is skipped with a visible reason.
 *
 * Ported verbatim from the embedded dispatcher's config.ts (#188/#234/#249/#281) so
 * the label-driven contract #319 extends is preserved exactly. As of #319 the
 * `model:*` allowlist is *derived* from the data-driven registry in `models.ts` rather
 * than hand-maintained here, so model configuration lives in one place.
 */

import { dispatchableModels } from "./models.ts";

/** Agents we know how to launch. */
export const AGENT_LABELS = {
  "agent:codex": "codex",
  "agent:claude": "claude",
} as const;

export type DispatcherAgent = (typeof AGENT_LABELS)[keyof typeof AGENT_LABELS];

function isDispatcherAgent(cli: string): cli is DispatcherAgent {
  return cli === "codex" || cli === "claude";
}

/**
 * model:* label → the exact string handed to the CLI's --model flag, derived from the
 * curated registry. Each entry also records which agent it belongs to, so a Codex model
 * on a Claude issue (or vice versa) is rejected rather than silently mis-dispatched.
 *
 * Only enabled models on a live dispatcher agent appear here (see `isDispatchable`): a
 * disabled or future-provider entry in the registry is documentation, not a valid label,
 * so labelling an issue with one fails to resolve rather than mis-dispatching.
 */
export const MODEL_LABELS: Record<string, { agent: DispatcherAgent; cliModel: string }> =
  Object.freeze(
    Object.fromEntries(
      dispatchableModels()
        .filter((m) => isDispatcherAgent(m.cli))
        .map((m) => [m.modelLabel, { agent: m.cli as DispatcherAgent, cliModel: m.cliModel }]),
    ),
  );

/**
 * effort:* label -> exact per-agent CLI reasoning effort.
 *
 * Codex does not accept Claude's xhigh/max levels; `effort:max` deliberately caps
 * Codex at `high`, while Claude gets the highest supported non-experimental value.
 */
export const EFFORT_LABELS: Record<string, Record<DispatcherAgent, string>> = {
  "effort:low": { codex: "low", claude: "low" },
  "effort:medium": { codex: "medium", claude: "medium" },
  "effort:high": { codex: "high", claude: "high" },
  "effort:max": { codex: "high", claude: "xhigh" },
};

export const DEFAULT_EFFORT_LABEL = "effort:medium";

/** Optional labels that move otherwise eligible issues between dispatcher queue tiers. */
export const QUEUE_JUMP_LABEL = "queue jump";
export const TECHNICAL_DEBT_LABEL = "technical debt";

export const DISPATCHER_PRIORITY_TIERS = ["queue-jump", "regular", "technical-debt"] as const;
export type DispatcherPriorityTier = (typeof DISPATCHER_PRIORITY_TIERS)[number];

/** Labels the repo already uses to mean "an agent has this". */
export const WORKING_LABEL = "agent-working";

/**
 * Labels that mean "this issue is waiting on a human, not on an agent".
 *
 * An issue held for a decision is NOT eligible work — hold it, notify once, move on.
 */
export const HOLD_LABELS = ["needs-input", "blocked", "autoship-held"] as const;

/**
 * Legacy label retained for compatibility with existing repositories. It is deliberately
 * inert: autoship has no human-review gate and promotes/ships a green draft even when the
 * label is present. Only HOLD_LABELS affect eligibility.
 */
export const HUMAN_REVIEW_REQUIRED_LABEL = "human-review-required";

/** Statuses in which a run still owns its issue claim. */
export const ACTIVE_STATUSES = ["claimed", "running"] as const;
/** Statuses whose artifacts (branch, checkout, plan) must be preserved and reused; the
 * next scan RELAUNCHES THE AGENT to continue (a crash/timeout recovery). */
export const RESUMABLE_STATUSES = ["interrupted", "timed_out", "token_exhausted"] as const;
/**
 * Statuses parked on a PR whose CI has not resolved yet. Unlike RESUMABLE_STATUSES, the
 * next scan does NOT relaunch the agent — it only re-checks CI (`recheckParkedRun`,
 * dispatcher.ts). This is the fix for the #366 class of bug: a run that produced a PR
 * with CI still pending used to be marked "succeeded" outright, releasing the claim, so
 * the very next scan re-claimed the issue and reran the FULL agent from scratch even
 * though nothing had changed and CI just hadn't finished yet.
 */
export const PARKED_STATUSES = ["ci_pending"] as const;
/**
 * A completed PR handoff when autoship is disabled. No agent is working, but the run
 * retains the issue claim so the still-open issue cannot be dispatched from scratch on
 * every poll.
 */
export const PR_READY_STATUSES = ["pr_ready"] as const;
/**
 * Mid-ladder statuses that hold the claim but have no automatic recovery path of their
 * own via the scan loop — resolution happens synchronously, in-process, via
 * `evaluateAutoship`'s self-heal/escalate calls, never by a later scan picking this
 * status back up. Listed here only so a run that is (abnormally) still in this state
 * blocks a fresh claim rather than being silently double-dispatched.
 */
export const LADDER_STATUSES = ["ci_failed"] as const;
/**
 * Terminal-but-blocked: assigned-model repairs and the frontier attempt are exhausted.
 * Unlike the pre-#10 behaviour, a held run KEEPS its issue claim: clearing `autoship-held`
 * must RESUME autoship of the existing ready PR (`recheckHeldRun`, dispatcher.ts) — merge +
 * deploy the PR that is already there — not re-dispatch a fresh agent run from scratch over
 * work that is already done. Holding the claim is what stops that re-dispatch; the recheck
 * is what actually converges it.
 */
export const HELD_STATUSES = ["held"] as const;
/** Statuses that block a fresh run for the same issue. */
export const CLAIMING_STATUSES = [
  ...ACTIVE_STATUSES,
  ...RESUMABLE_STATUSES,
  ...PARKED_STATUSES,
  ...PR_READY_STATUSES,
  ...LADDER_STATUSES,
  ...HELD_STATUSES,
] as const;

/**
 * Run outcome semantics (ported from the #366 incident postmortem): a run is `shipped`
 * ONLY when autoship has actually merged the PR and completed the deploy — never merely
 * for opening a PR or observing green CI at agent hand-off, both of which used to be
 * called "succeeded" and release the claim, letting the dispatcher re-run the same issue
 * from scratch every ~15 minutes while a PR sat open or CI was still checking.
 *
 *   - "shipped"       TRUE success: PR merged, deploy completed, production healthy,
 *                      and the linked issue closed.
 *   - "pr_ready"      Clean agent exit with a PR and green CI at handoff. If autoship is
 *                      configured it immediately re-gates and ships; otherwise this is
 *                      the honest terminal ready-PR handoff and retains the issue claim.
 *   - "ci_pending"     Agent finished, PR open, CI has not resolved. Parked: the claim
 *                      is held, and the next scan re-checks CI ONLY (no agent relaunch).
 *   - "ci_failed"      CI is definitively red. Drives the repair -> frontier -> exhausted
 *                      ladder (`evaluateAutoship`, dispatcher.ts). Always resolved
 *                      further within the same finalize pass; a run should not be found
 *                      sitting in this status across a scan boundary in normal operation.
 *   - "held"           Terminal exhaustion only: assigned-model repairs and the final
 *                      frontier attempt failed for an owned delivery phase. A held run KEEPS its claim
 *                      (HELD_STATUSES ⊂ CLAIMING_STATUSES) so the issue is not re-dispatched
 *                      from scratch; clearing `autoship-held` RESUMES autoship of the ready
 *                      PR instead (`recheckHeldRun`).
 *   - "failed"         The agent itself crashed, gave up (zero commits), or exited
 *                      non-zero. Distinct from `ci_failed`: this is the agent's fault,
 *                      not the PR's content's fault. Enters the per-phase assigned-model
 *                      repair → frontier → exhausted ladder; it is not an operator handoff.
 */
export type DispatcherStatus =
  | "claimed"
  | "running"
  | "pr_ready"
  | "shipped"
  | "ci_pending"
  | "ci_failed"
  | "held"
  | "failed"
  | "timed_out"
  | "interrupted"
  | "abandoned"
  | "token_exhausted";

export interface ResolvedAssignment {
  agent: DispatcherAgent;
  modelLabel: string;
  cliModel: string;
  effortLabel: string;
  cliEffort: string;
}

export type AssignmentResult =
  | { ok: true; value: ResolvedAssignment }
  | { ok: false; reason: string };

/**
 * Resolves an issue's labels to an agent + CLI model, or explains why it can't.
 * Returns a reason string (never throws) so the scan can surface skips.
 */
export function resolveAssignment(labels: string[]): AssignmentResult {
  const agentLabels = labels.filter((l) => l in AGENT_LABELS);
  if (agentLabels.length === 0) return { ok: false, reason: "no agent:* label" };
  if (agentLabels.length > 1) {
    return { ok: false, reason: `conflicting agent labels (${agentLabels.join(", ")})` };
  }

  const modelLabelNames = labels.filter((l) => l.startsWith("model:"));
  if (modelLabelNames.length === 0) return { ok: false, reason: "no model:* label" };
  if (modelLabelNames.length > 1) {
    return { ok: false, reason: `conflicting model labels (${modelLabelNames.join(", ")})` };
  }

  const agent = AGENT_LABELS[agentLabels[0] as keyof typeof AGENT_LABELS];
  const modelLabel = modelLabelNames[0]!;
  const model = MODEL_LABELS[modelLabel];
  if (!model) return { ok: false, reason: `unsupported model label ${modelLabel}` };

  if (model.agent !== agent) {
    return {
      ok: false,
      reason: `${modelLabel} is a ${model.agent} model but the issue is labeled ${agentLabels[0]}`,
    };
  }

  const effortLabelNames = labels.filter((l) => l.startsWith("effort:"));
  if (effortLabelNames.length > 1) {
    return { ok: false, reason: `conflicting effort labels (${effortLabelNames.join(", ")})` };
  }

  const effortLabel = effortLabelNames[0] ?? DEFAULT_EFFORT_LABEL;
  const effort = EFFORT_LABELS[effortLabel];
  if (!effort) return { ok: false, reason: `unsupported effort label ${effortLabel}` };

  return {
    ok: true,
    value: {
      agent,
      modelLabel,
      cliModel: model.cliModel,
      effortLabel,
      cliEffort: effort[agent],
    },
  };
}

export function resolvePriorityTier(labels: string[]): DispatcherPriorityTier {
  if (labels.includes(QUEUE_JUMP_LABEL)) return "queue-jump";
  if (labels.includes(TECHNICAL_DEBT_LABEL)) return "technical-debt";
  return "regular";
}

/**
 * Deterministic branch name for an issue. The title is untrusted, so it is reduced
 * to [a-z0-9-] and truncated — the result is safe as both a git ref and a path
 * segment, and is stable across resumes of the same issue.
 */
export function branchNameFor(issueNumber: number, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/g, "");
  return slug ? `issue-${issueNumber}-${slug}` : `issue-${issueNumber}`;
}
