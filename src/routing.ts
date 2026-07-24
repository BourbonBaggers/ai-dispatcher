/**
 * The deterministic routing rubric + escalation policy (#319).
 *
 * This is the heart of the PRD: route each issue to the *minimum viable model*, prefer
 * dormant capacity, protect the frontier, and make retries/handoffs cost-driven rather
 * than reflexively escalating within one provider. It is a pure decision engine — the
 * planning repo's `AGENTS.md` uses it to pick a `model:*` label at issue-creation time,
 * and the dispatcher can consult it when planning a retry. Nothing here does IO or
 * overrides the label the dispatcher actually obeys.
 *
 * Everything is data-driven: the label taxonomy and the tier ladder are the inputs, the
 * registry (`models.ts`) is the candidate set, and the capacity adapter (`capacity.ts`)
 * supplies availability. The rubric itself is a small set of documented, deterministic
 * rules — no ML, no prediction machinery (PRD 80/20 principle §10).
 */

import {
  MODEL_TIERS,
  tierRank,
  dispatchableModels,
  type ModelEntry,
  type ModelTier,
} from "./models.ts";
import { isPoolExhausted, type CapacityAssessment } from "./capacity.ts";

// ── Issue-characteristic taxonomy (PRD deliverable §2: structured routing metadata) ──
//
// Objective, discrete dimensions. Each is a `dimension:value` GitHub label so similar
// issues can be compared later. Kept small on purpose — enough to route, not a survey.

export const COMPLEXITY = ["trivial", "simple", "moderate", "complex"] as const;
export type Complexity = (typeof COMPLEXITY)[number];

export const RISK = ["low", "medium", "high"] as const; // blast radius
export type Risk = (typeof RISK)[number];

export const CONTEXT_SIZE = ["small", "medium", "large"] as const;
export type ContextSize = (typeof CONTEXT_SIZE)[number];

export const AMBIGUITY = ["clear", "some", "high"] as const;
export type Ambiguity = (typeof AMBIGUITY)[number];

export const REQUIREMENTS_QUALITY = ["good", "adequate", "poor"] as const;
export type RequirementsQuality = (typeof REQUIREMENTS_QUALITY)[number];

export const REASONING_DEPTH = ["shallow", "moderate", "deep"] as const;
export type ReasoningDepth = (typeof REASONING_DEPTH)[number];

export interface IssueCharacteristics {
  /** Free-form task class (e.g. "feature", "bugfix", "refactor"), matched to taskClasses. */
  taskType: string;
  complexity: Complexity;
  risk: Risk;
  contextSize: ContextSize;
  ambiguity: Ambiguity;
  requirementsQuality: RequirementsQuality;
  reasoningDepth: ReasoningDepth;
}

/** Conservative defaults for an unlabelled issue: mid on every axis → a general-tier route. */
export const DEFAULT_CHARACTERISTICS: IssueCharacteristics = {
  taskType: "general",
  complexity: "moderate",
  risk: "medium",
  contextSize: "medium",
  ambiguity: "some",
  requirementsQuality: "adequate",
  reasoningDepth: "moderate",
};

/** `dimension:value` label prefixes for each characteristic dimension. */
export const CHARACTERISTIC_LABEL_PREFIXES = {
  taskType: "task",
  complexity: "complexity",
  risk: "risk",
  contextSize: "context",
  ambiguity: "ambiguity",
  requirementsQuality: "requirements",
  reasoningDepth: "reasoning",
} as const;

/** Marks an issue whose model was chosen by a human, not the rubric (excluded from learning). */
export const HUMAN_OVERRIDE_LABEL = "route:human-override";

/** Routing-rationale labels — *why* a model was chosen, applied for later comparison. */
export const ROUTING_RATIONALE = {
  minViable: "route:min-viable",
  dormantCapacity: "route:dormant-capacity",
  frontierJustified: "route:frontier-justified",
  capacityConstrained: "route:capacity-constrained",
  taskClassMatch: "route:task-class-match",
} as const;

function labelValue(labels: string[], prefix: string): string | null {
  const hit = labels.find((l) => l.startsWith(`${prefix}:`));
  return hit ? hit.slice(prefix.length + 1) : null;
}

function oneOf<T extends string>(value: string | null, allowed: readonly T[], fallback: T): T {
  return value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/** Builds objective characteristics from an issue's labels, filling unlabelled axes with defaults. */
export function parseCharacteristics(labels: string[]): IssueCharacteristics {
  const p = CHARACTERISTIC_LABEL_PREFIXES;
  return {
    taskType: labelValue(labels, p.taskType) ?? DEFAULT_CHARACTERISTICS.taskType,
    complexity: oneOf(labelValue(labels, p.complexity), COMPLEXITY, DEFAULT_CHARACTERISTICS.complexity),
    risk: oneOf(labelValue(labels, p.risk), RISK, DEFAULT_CHARACTERISTICS.risk),
    contextSize: oneOf(labelValue(labels, p.contextSize), CONTEXT_SIZE, DEFAULT_CHARACTERISTICS.contextSize),
    ambiguity: oneOf(labelValue(labels, p.ambiguity), AMBIGUITY, DEFAULT_CHARACTERISTICS.ambiguity),
    requirementsQuality: oneOf(
      labelValue(labels, p.requirementsQuality),
      REQUIREMENTS_QUALITY,
      DEFAULT_CHARACTERISTICS.requirementsQuality,
    ),
    reasoningDepth: oneOf(labelValue(labels, p.reasoningDepth), REASONING_DEPTH, DEFAULT_CHARACTERISTICS.reasoningDepth),
  };
}

// ── Minimum-viable-tier derivation ──────────────────────────────────────────────

const COMPLEXITY_TO_RANK: Record<Complexity, number> = {
  trivial: 0, // fast
  simple: 0, // fast
  moderate: 1, // general
  complex: 2, // complex
};

/**
 * The minimum viable capability tier for an issue. Complexity is the primary driver;
 * high blast radius and deep reasoning raise the floor even for otherwise-moderate work.
 * The frontier floor is reserved: it is reached only when the work is simultaneously
 * complex, high-risk, AND demands deep reasoning — the ceiling of every axis. This keeps
 * frontier a genuine reserve (PRD principle §4) rather than a default for "hard" issues.
 *
 * Requirements quality deliberately does NOT raise the tier: well-specified requirements
 * substitute for model strength (principle §5), and poorly-specified work should be
 * refined rather than escalated. Requirements quality feeds routing *confidence* instead.
 */
export function deriveMinimumTier(c: IssueCharacteristics): ModelTier {
  let rank = COMPLEXITY_TO_RANK[c.complexity];
  if (c.risk === "high") rank = Math.max(rank, 2); // complex
  if (c.reasoningDepth === "deep") rank = Math.max(rank, 2); // complex
  if (c.complexity === "complex" && c.risk === "high" && c.reasoningDepth === "deep") {
    rank = 3; // frontier — only at the ceiling of every axis
  }
  return MODEL_TIERS[rank]!;
}

// ── routeIssue ──────────────────────────────────────────────────────────────────

export const ROUTING_CONFIDENCE = ["high", "medium", "low"] as const;
export type RoutingConfidence = (typeof ROUTING_CONFIDENCE)[number];

export interface RoutingAlternative {
  modelLabel: string;
  tier: ModelTier;
  eligible: boolean;
  reason: string;
}

export interface RoutingDecision {
  selected: ModelEntry | null;
  minimumTier: ModelTier;
  confidence: RoutingConfidence;
  determiningFactors: string[];
  rationaleLabels: string[];
  alternatives: RoutingAlternative[];
  reason: string;
}

/**
 * Routing confidence from the axes that make an outcome (un)predictable. High ambiguity or
 * poor requirements lower it; a hard capacity signal (persisted-limit/estimated) raises it
 * over a blind `unknown`. Confidence is advice for the human, not a gate.
 */
function routingConfidence(
  c: IssueCharacteristics,
  capacity: CapacityAssessment | undefined,
): RoutingConfidence {
  let score = 2; // 2 = high, 1 = medium, 0 = low
  if (c.ambiguity === "high") score -= 1;
  if (c.requirementsQuality === "poor") score -= 1;
  if (c.ambiguity === "clear" && c.requirementsQuality === "good") score += 1;
  if (!capacity || capacity.confidence === "unknown") score -= 0; // no boost, no extra penalty
  const clamped = Math.max(0, Math.min(2, score));
  return ROUTING_CONFIDENCE[2 - clamped]!;
}

/**
 * Selects the minimum viable model for an issue.
 *
 * Steps mirror the PRD "initial assignment" list: classify → find capable models → drop
 * unavailable → protect the frontier unless justified → prefer the lowest capable tier →
 * prefer dormant capacity among comparable options → record alternatives + confidence +
 * determining factors.
 */
export function routeIssue(
  characteristics: IssueCharacteristics,
  capacityByPool: Map<string, CapacityAssessment>,
  models: readonly ModelEntry[] = dispatchableModels(),
): RoutingDecision {
  const minimumTier = deriveMinimumTier(characteristics);
  const minRank = tierRank(minimumTier);
  const frontierJustified = minimumTier === "frontier";
  const needsLargeContext = characteristics.contextSize === "large";
  const factors: string[] = [`minimum viable tier: ${minimumTier}`];

  const alternatives: RoutingAlternative[] = [];
  const eligible: ModelEntry[] = [];

  for (const model of models) {
    // Capability floor: at or above the minimum viable tier.
    if (tierRank(model.tier) < minRank) {
      alternatives.push(alt(model, false, `below minimum viable tier (${model.tier} < ${minimumTier})`));
      continue;
    }
    // Large-context work requires a model provisioned for it.
    if (needsLargeContext && !model.largeContext) {
      alternatives.push(alt(model, false, "not provisioned for large-context work"));
      continue;
    }
    // Protect the frontier: withhold frontier models unless the tier floor itself demands it.
    if (model.frontier && !frontierJustified) {
      alternatives.push(alt(model, false, "frontier model withheld — not justified by characteristics"));
      continue;
    }
    // Drop unavailable capacity.
    const capacity = capacityByPool.get(model.capacityPool);
    if (capacity && isPoolExhausted(capacity)) {
      alternatives.push(alt(model, false, `pool ${model.capacityPool} exhausted`));
      continue;
    }
    alternatives.push(alt(model, true, "capable and available"));
    eligible.push(model);
  }

  if (eligible.length === 0) {
    return {
      selected: null,
      minimumTier,
      confidence: "low",
      determiningFactors: factors,
      rationaleLabels: [],
      alternatives,
      reason: frontierJustified
        ? "no capable model is available (including the frontier)"
        : "no capable non-frontier model is available — refine the issue or approve frontier use",
    };
  }

  const selected = pickBest(eligible, characteristics, capacityByPool);
  const capacity = capacityByPool.get(selected.capacityPool);
  const rationaleLabels: string[] = [ROUTING_RATIONALE.minViable];

  if (selected.tier === minimumTier) {
    factors.push(`chose the lowest capable tier (${selected.tier})`);
  } else {
    factors.push(`lowest available capable tier is ${selected.tier} (min viable ${minimumTier})`);
    rationaleLabels.push(ROUTING_RATIONALE.capacityConstrained);
  }
  if (capacity?.dormant) {
    factors.push(`preferred dormant pool ${selected.capacityPool}`);
    rationaleLabels.push(ROUTING_RATIONALE.dormantCapacity);
  }
  if (selected.taskClasses.includes(characteristics.taskType)) {
    factors.push(`task class "${characteristics.taskType}" matches the model`);
    rationaleLabels.push(ROUTING_RATIONALE.taskClassMatch);
  }
  if (selected.frontier) {
    factors.push("frontier justified by issue characteristics");
    rationaleLabels.push(ROUTING_RATIONALE.frontierJustified);
  }

  return {
    selected,
    minimumTier,
    confidence: routingConfidence(characteristics, capacity),
    determiningFactors: factors,
    rationaleLabels,
    alternatives,
    reason: `selected ${selected.modelLabel} (${selected.tier})`,
  };
}

function alt(model: ModelEntry, eligible: boolean, reason: string): RoutingAlternative {
  return { modelLabel: model.modelLabel, tier: model.tier, eligible, reason };
}

/**
 * Orders eligible models by the PRD's preference and returns the winner:
 *   1. lowest capable tier   (minimum viable model)
 *   2. dormant capacity      (conserve busy subscriptions)
 *   3. task-class match       (a model built for this kind of work)
 *   4. registry order         (stable, deterministic tiebreak)
 */
function pickBest(
  eligible: ModelEntry[],
  c: IssueCharacteristics,
  capacityByPool: Map<string, CapacityAssessment>,
): ModelEntry {
  const dormant = (m: ModelEntry) => (capacityByPool.get(m.capacityPool)?.dormant ? 0 : 1);
  const taskMatch = (m: ModelEntry) => (m.taskClasses.includes(c.taskType) ? 0 : 1);
  const registryOrder = new Map(eligible.map((m, i) => [m.modelLabel, i]));
  return [...eligible].sort((a, b) => {
    return (
      tierRank(a.tier) - tierRank(b.tier) ||
      dormant(a) - dormant(b) ||
      taskMatch(a) - taskMatch(b) ||
      registryOrder.get(a.modelLabel)! - registryOrder.get(b.modelLabel)!
    );
  })[0]!;
}

// ── Retry / handoff planning ─────────────────────────────────────────────────────

/** Failure taxonomy the dispatcher can distinguish (PRD "retry and handoff"). */
export const FAILURE_CATEGORIES = [
  "transient",
  "usage-limit",
  "requirements-block",
  "implementation-failure",
  "test-failure",
  "context-exhaustion",
  "human-intervention",
] as const;
export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];

/** Failure category → the escalation reason recorded on the next attempt. */
export const ESCALATION_REASON: Record<FailureCategory, string> = {
  transient: "transient provider failure — retry the same model",
  "usage-limit": "usage-limit exhaustion — hand off to unused comparable capacity",
  "requirements-block": "requirements/clarification block — hold for a human",
  "implementation-failure": "implementation failure — escalate one capability tier",
  "test-failure": "test failure — escalate one capability tier",
  "context-exhaustion": "context exhaustion — hand off to large-context capacity",
  "human-intervention": "human intervention required — hold",
};

export const NEXT_ATTEMPT_ACTIONS = [
  "retry-same",
  "handoff",
  "escalate-tier",
  "escalate-frontier",
  "hold",
] as const;
export type NextAttemptAction = (typeof NEXT_ATTEMPT_ACTIONS)[number];

export interface NextAttemptPlan {
  action: NextAttemptAction;
  /** The model to run next, or null when holding for a human / nothing available. */
  model: ModelEntry | null;
  escalationReason: string;
  /** Frontier capacity increase — the operator must approve before it is consumed. */
  requiresHumanApproval: boolean;
  rationale: string;
}

function available(model: ModelEntry, capacityByPool: Map<string, CapacityAssessment>): boolean {
  const capacity = capacityByPool.get(model.capacityPool);
  return !(capacity && isPoolExhausted(capacity));
}

/** First available candidate from a list of model labels, in order. */
function firstAvailable(
  labels: readonly string[],
  capacityByPool: Map<string, CapacityAssessment>,
  models: readonly ModelEntry[],
): ModelEntry | null {
  for (const label of labels) {
    const model = models.find((m) => m.modelLabel === label);
    if (model && available(model, capacityByPool)) return model;
  }
  return null;
}

/**
 * Plans the next attempt after a failure, cost-driven rather than reflexively escalating
 * within one provider. Fallback preference comes from the model's own `fallbacks` list.
 * Frontier is only ever reached when lower-tier repair attempts have failed. That final
 * escalation is automatic; operator involvement begins only if frontier also fails.
 */
export function planNextAttempt(
  failureCategory: FailureCategory,
  currentModel: ModelEntry,
  capacityByPool: Map<string, CapacityAssessment>,
  models: readonly ModelEntry[] = dispatchableModels(),
): NextAttemptPlan {
  const reason = ESCALATION_REASON[failureCategory];

  // Human-owned states never touch the model — hold and let a human decide.
  if (failureCategory === "requirements-block" || failureCategory === "human-intervention") {
    return { action: "hold", model: null, escalationReason: reason, requiresHumanApproval: false, rationale: reason };
  }

  // Transient: the model was fine; retry it if its pool is not exhausted, else hand off.
  if (failureCategory === "transient") {
    if (available(currentModel, capacityByPool)) {
      return {
        action: "retry-same",
        model: currentModel,
        escalationReason: reason,
        requiresHumanApproval: false,
        rationale: "transient failure — the same model on available capacity is cheapest",
      };
    }
    // Pool went cold mid-retry — fall through to a cross-provider handoff.
  }

  // Usage-limit / cold pool: move to unused *comparable* capacity at another provider
  // (same tier, different pool) before spending a stronger tier.
  if (failureCategory === "usage-limit" || failureCategory === "transient") {
    const comparable = models.filter(
      (m) =>
        m.tier === currentModel.tier &&
        m.capacityPool !== currentModel.capacityPool &&
        available(m, capacityByPool),
    );
    const dormantFirst = comparable.sort(
      (a, b) =>
        (capacityByPool.get(a.capacityPool)?.dormant ? 0 : 1) -
        (capacityByPool.get(b.capacityPool)?.dormant ? 0 : 1),
    );
    const handoff = dormantFirst[0] ?? firstAvailable(currentModel.fallbacks, capacityByPool, models);
    if (handoff) {
      return {
        action: "handoff",
        model: handoff,
        escalationReason: reason,
        requiresHumanApproval: false,
        rationale: `hand off to comparable capacity (${handoff.modelLabel})`,
      };
    }
    return { action: "hold", model: null, escalationReason: reason, requiresHumanApproval: false, rationale: "no comparable capacity available — hold" };
  }

  // Context exhaustion: the work needs a bigger window, not necessarily a stronger model.
  if (failureCategory === "context-exhaustion") {
    const largeContext = models
      .filter((m) => m.largeContext && available(m, capacityByPool) && (!m.frontier))
      .sort((a, b) => tierRank(a.tier) - tierRank(b.tier));
    const target = largeContext[0] ?? firstAvailable(currentModel.fallbacks, capacityByPool, models);
    if (target) {
      return {
        action: "handoff",
        model: target,
        escalationReason: reason,
        requiresHumanApproval: false,
        rationale: `hand off to large-context capacity (${target.modelLabel})`,
      };
    }
    return { action: "hold", model: null, escalationReason: reason, requiresHumanApproval: false, rationale: "no large-context capacity available — hold" };
  }

  // Implementation / test failure: escalate exactly one capability tier. Frontier is
  // the final automated rung; failure there is the handoff point.
  const nextRank = tierRank(currentModel.tier) + 1;
  if (nextRank >= MODEL_TIERS.length) {
    if (currentModel.frontier) {
      return {
        action: "hold",
        model: null,
        escalationReason: reason,
        requiresHumanApproval: false,
        rationale: "frontier attempt failed — automation exhausted",
      };
    }
    // Already at the strongest non-frontier tier: use an explicit fallback if present.
    const sameTierElsewhere = firstAvailable(currentModel.fallbacks, capacityByPool, models);
    if (sameTierElsewhere) {
      return {
        action: "handoff",
        model: sameTierElsewhere,
        escalationReason: reason,
        requiresHumanApproval: false,
        rationale: `top tier reached — hand off to ${sameTierElsewhere.modelLabel}`,
      };
    }
    return { action: "hold", model: null, escalationReason: reason, requiresHumanApproval: false, rationale: "already at the strongest tier — hold for a human" };
  }
  const nextTier = MODEL_TIERS[nextRank]!;
  const stronger = models
    .filter((m) => m.tier === nextTier && available(m, capacityByPool))
    .sort((a, b) => (capacityByPool.get(a.capacityPool)?.dormant ? 0 : 1) - (capacityByPool.get(b.capacityPool)?.dormant ? 0 : 1));
  const target = stronger[0] ?? firstAvailable(currentModel.fallbacks, capacityByPool, models);
  if (!target) {
    return { action: "hold", model: null, escalationReason: reason, requiresHumanApproval: false, rationale: `no ${nextTier}-tier capacity available — hold` };
  }
  return {
    action: target.frontier ? "escalate-frontier" : "escalate-tier",
    model: target,
    escalationReason: reason,
    requiresHumanApproval: false,
    rationale: target.frontier
      ? `escalate automatically to final frontier attempt (${target.modelLabel})`
      : `escalate one tier to ${target.modelLabel}`,
  };
}
