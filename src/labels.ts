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
export const HOLD_LABELS = ["needs-input", "blocked"] as const;

/** Statuses in which a run still owns its issue claim. */
export const ACTIVE_STATUSES = ["claimed", "running"] as const;
/** Statuses whose artifacts (branch, checkout, plan) must be preserved and reused. */
export const RESUMABLE_STATUSES = ["interrupted", "timed_out", "token_exhausted"] as const;
/** Statuses that block a fresh run for the same issue. */
export const CLAIMING_STATUSES = [...ACTIVE_STATUSES, ...RESUMABLE_STATUSES] as const;

export type DispatcherStatus =
  | "claimed"
  | "running"
  | "succeeded"
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
