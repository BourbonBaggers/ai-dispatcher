/**
 * The allowlist that separates GitHub labels from the shell.
 *
 * Issue labels are untrusted input. Nothing from a label is ever passed to a
 * command: a label is only ever *looked up* in these frozen maps, and it is the
 * map's value — a constant defined in this file — that reaches the CLI. An
 * unknown label therefore cannot smuggle an argument through; it just fails to
 * resolve and the issue is skipped with a visible reason.
 *
 * The label-driven contract is intentionally explicit and stable. The
 * `model:*` allowlist is *derived* from the data-driven registry in `models.ts` rather
 * than hand-maintained here, so model configuration lives in one place.
 */

import { dispatchableModels, modelByLabel, type ModelEntry } from "./models.ts";

/** Agents we know how to launch. */
export const AGENT_LABELS = {
  "agent:codex": "codex",
  "agent:claude": "claude",
  "agent:opencode": "opencode",
} as const;

export type DispatcherAgent = (typeof AGENT_LABELS)[keyof typeof AGENT_LABELS];

export function isDispatcherAgent(cli: string): cli is DispatcherAgent {
  return cli === "codex" || cli === "claude" || cli === "opencode";
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
 * OpenCode effort levels map to their CLI values (likely similar to Claude's).
 */
export const EFFORT_LABELS: Record<string, Record<DispatcherAgent, string>> = {
  "effort:low": { codex: "low", claude: "low", opencode: "low" },
  "effort:medium": { codex: "medium", claude: "medium", opencode: "medium" },
  "effort:high": { codex: "high", claude: "high", opencode: "high" },
  "effort:xhigh": { codex: "high", claude: "xhigh", opencode: "high" },
  "effort:max": { codex: "high", claude: "max", opencode: "high" },
  "effort:ultra": { codex: "high", claude: "max", opencode: "high" },
};

export const DEFAULT_EFFORT_LABEL = "effort:medium";

/** Provider-neutral queue admission. Assignment is derived later at pickup. */
export const DISPATCH_READY_LABEL = "dispatch:ready";

export const ISSUE_TYPE_LABELS = [
  "type:bug",
  "type:enhancement",
  "type:refactor",
  "type:chore",
  "type:docs",
  "type:ops",
  "type:research",
] as const;
export type IssueTypeLabel = (typeof ISSUE_TYPE_LABELS)[number];

export const PRIORITY_LABELS = [
  "priority:queue-jump",
  "priority:normal",
  "priority:background",
] as const;
export type PriorityLabel = (typeof PRIORITY_LABELS)[number];

export const BUSINESS_RISK_LABELS = [
  "risk:low-stakes",
  "risk:normal",
  "risk:destructive",
] as const;
export type BusinessRiskLabel = (typeof BUSINESS_RISK_LABELS)[number];

export type IntakeLabelContractResult =
  | { ok: true }
  | { ok: false; reason: string };

function labelsIn(labels: string[], allowed: readonly string[]): string[] {
  return labels.filter((label) => allowed.includes(label));
}

export function validateDispatchReadyContract(labels: string[]): IntakeLabelContractResult {
  if (!labels.includes(DISPATCH_READY_LABEL)) {
    return { ok: false, reason: "missing dispatch:ready" };
  }
  const groups = [
    ["type", labelsIn(labels, ISSUE_TYPE_LABELS)],
    ["priority", labelsIn(labels, PRIORITY_LABELS)],
    ["risk", labelsIn(labels, BUSINESS_RISK_LABELS)],
  ] as const;
  for (const [group, hits] of groups) {
    if (hits.length !== 1) {
      return {
        ok: false,
        reason:
          hits.length === 0
            ? `missing ${group}:* intake label`
            : `conflicting ${group}:* intake labels (${hits.join(", ")})`,
      };
    }
  }
  return { ok: true };
}

/**
 * Legacy assignment labels continue to admit already-queued work during migration, but
 * they are advisory unless route:human-override is present.
 */
export function isDispatchRequested(labels: string[]): boolean {
  const characteristicPrefixes = [
    "task:",
    "complexity:",
    "risk:",
    "context:",
    "ambiguity:",
    "requirements:",
    "reasoning:",
    "verification:",
    "recoverability:",
  ];
  return (
    labels.includes(DISPATCH_READY_LABEL) ||
    labels.some((label) => label.startsWith("agent:") || label.startsWith("model:")) ||
    labels.some((label) =>
      characteristicPrefixes.some((prefix) => label.startsWith(prefix)),
    ) ||
    labels.includes("route:human-override")
  );
}

/** Optional labels that move otherwise eligible issues between dispatcher queue tiers. */
export const QUEUE_JUMP_LABEL = "queue jump";
export const TECHNICAL_DEBT_LABEL = "technical debt";

export const DISPATCHER_PRIORITY_TIERS = ["queue-jump", "normal", "background"] as const;
export type DispatcherPriorityTier = (typeof DISPATCHER_PRIORITY_TIERS)[number];

/** Labels the repo already uses to mean "an agent has this". */
export const WORKING_LABEL = "agent-working";

/**
 * Labels that mean "this issue is waiting on a human, not on an agent".
 *
 * An issue held for a decision is NOT eligible work — hold it, notify once, move on.
 */
/**
 * Applied when the dispatcher cannot proceed without a human clarifying the ask — an
 * untrusted author, or requirements too thin to route. It is a hold, never an escalation:
 * a vague issue is answered by asking, not by spending a more expensive model on it.
 */
export const NEEDS_INPUT_LABEL = "needs-input";

/**
 * Durable interactive-ownership hold (#82). An interactive session (or operator) applies
 * this to take ownership of an issue outside the dispatcher — unlike `blocked`, it is
 * never added or removed by any dispatcher code path in either direction, and the
 * blocked-queue audit's stale-hold recovery never touches it. It durably keeps
 * `dispatch:ready` from being re-derived by intake-label migration for as long as it is
 * present, because `migrateIntakeLabels` (dispatcher.ts) skips any issue carrying a
 * HOLD_LABELS member before computing the migration.
 */
export const INTERACTIVE_LABEL = "interactive";

export const HOLD_LABELS = [
  NEEDS_INPUT_LABEL,
  "blocked",
  "autoship-held",
  INTERACTIVE_LABEL,
] as const;

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
 * dispatcher.ts). This prevents a run that produced a PR
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
 * Run outcome semantics: a run is `shipped`
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

export interface ResolvedRoutingOverride {
  model: ModelEntry;
  /** Null means the human pinned the model but left effort to the dispatcher. */
  effortLabel: string | null;
}

export type RoutingOverrideResult =
  | { ok: true; value: ResolvedRoutingOverride | null }
  | { ok: false; reason: string };

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

/** Maps a registry model and provider-neutral effort label through the frozen allowlists. */
export function assignmentForModel(
  model: ModelEntry,
  effortLabel: string,
): AssignmentResult {
  if (!isDispatcherAgent(model.cli)) {
    return { ok: false, reason: `${model.modelLabel} has no live dispatcher agent` };
  }
  const effort = EFFORT_LABELS[effortLabel];
  if (!effort) return { ok: false, reason: `unsupported effort label ${effortLabel}` };
  return {
    ok: true,
    value: {
      agent: model.cli,
      modelLabel: model.modelLabel,
      cliModel: model.cliModel,
      effortLabel,
      cliEffort: effort[model.cli],
    },
  };
}

/**
 * Ordinary assignment labels are advisory output from older planning flows. Only the
 * explicit override marker makes them authoritative; this prevents stale/partial labels
 * from wedging otherwise routable work.
 */
export function resolveRoutingOverride(labels: string[]): RoutingOverrideResult {
  if (!labels.includes("route:human-override")) return { ok: true, value: null };

  const agentLabels = labels.filter((label) => label in AGENT_LABELS);
  const modelLabels = labels.filter((label) => label.startsWith("model:"));
  const effortLabels = labels.filter((label) => label.startsWith("effort:"));
  if (agentLabels.length !== 1 || modelLabels.length !== 1) {
    return {
      ok: false,
      reason: "route:human-override requires exactly one agent:* and one model:* label",
    };
  }
  if (effortLabels.length > 1) {
    return {
      ok: false,
      reason: `conflicting effort labels (${effortLabels.join(", ")})`,
    };
  }
  const model = modelByLabel(modelLabels[0]!);
  if (!model || !model.enabled || !isDispatcherAgent(model.cli)) {
    return { ok: false, reason: `unsupported model override ${modelLabels[0]}` };
  }
  const agent = AGENT_LABELS[agentLabels[0] as keyof typeof AGENT_LABELS];
  if (model.cli !== agent) {
    return {
      ok: false,
      reason: `${model.modelLabel} is a ${model.cli} model but the override uses ${agentLabels[0]}`,
    };
  }
  const effortLabel = effortLabels[0] ?? null;
  if (effortLabel !== null && !EFFORT_LABELS[effortLabel]) {
    return { ok: false, reason: `unsupported effort override ${effortLabel}` };
  }
  return { ok: true, value: { model, effortLabel } };
}

export function resolvePriorityTier(labels: string[]): DispatcherPriorityTier {
  if (labels.includes("priority:queue-jump")) return "queue-jump";
  if (labels.includes("priority:background")) return "background";
  if (labels.includes("priority:normal")) return "normal";
  if (labels.includes(QUEUE_JUMP_LABEL)) return "queue-jump";
  if (labels.includes(TECHNICAL_DEBT_LABEL)) return "background";
  return "normal";
}

export interface LabelMigration {
  add: string[];
  remove: string[];
  needsInputReason: string | null;
}

export function migrationForLegacyIntakeLabels(labels: string[]): LabelMigration {
  const add = new Set<string>();
  const remove = new Set<string>();
  if (isDispatchRequested(labels) && !labels.includes(DISPATCH_READY_LABEL)) {
    add.add(DISPATCH_READY_LABEL);
  }
  if (labels.includes(QUEUE_JUMP_LABEL) && !labels.includes("priority:queue-jump")) {
    add.add("priority:queue-jump");
    remove.add(QUEUE_JUMP_LABEL);
  } else if (labels.includes(TECHNICAL_DEBT_LABEL) && !labels.includes("priority:background")) {
    add.add("priority:background");
    remove.add(TECHNICAL_DEBT_LABEL);
  } else if (!labelsIn(labels, PRIORITY_LABELS).length) {
    add.add("priority:normal");
  }

  const task = labels.find((label) => label.startsWith("task:"))?.slice("task:".length);
  const taskMap: Record<string, IssueTypeLabel> = {
    bug: "type:bug",
    bugfix: "type:bug",
    feature: "type:enhancement",
    enhancement: "type:enhancement",
    refactor: "type:refactor",
    chore: "type:chore",
    docs: "type:docs",
    ops: "type:ops",
    research: "type:research",
  };
  if (!labelsIn(labels, ISSUE_TYPE_LABELS).length && task && taskMap[task]) {
    add.add(taskMap[task]);
  }

  const legacyRisk = labels.find((label) => /^risk:(low|medium|high)$/.test(label));
  const riskMap: Record<string, BusinessRiskLabel> = {
    "risk:low": "risk:low-stakes",
    "risk:medium": "risk:normal",
    "risk:high": "risk:destructive",
  };
  if (!labelsIn(labels, BUSINESS_RISK_LABELS).length && legacyRisk) {
    add.add(riskMap[legacyRisk]!);
    // Retire the legacy label in the same pass. Leaving both would keep two different
    // dimensions on one `risk:` prefix, which is exactly the ambiguity migration exists
    // to remove.
    remove.add(legacyRisk);
  }

  const projected = [...labels.filter((label) => !remove.has(label)), ...add];
  const contract = projected.includes(DISPATCH_READY_LABEL)
    ? validateDispatchReadyContract(projected)
    : { ok: true as const };
  return {
    add: [...add].filter((label) => !labels.includes(label)),
    remove: [...remove],
    needsInputReason: contract.ok ? null : contract.reason,
  };
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
