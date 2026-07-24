/**
 * The deterministic routing rubric + escalation policy (#319).
 *
 * Route each issue to the *minimum viable model* at pickup, balance independent live
 * capacity pools, protect the frontier, and make retries/handoffs cost-driven rather
 * than reflexively escalating within one provider. It is a pure decision engine; the
 * dispatcher owns IO, durable assignment, and label projection.
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
import {
  capacityHeadroomForModel,
  isModelCapacityExhausted,
  type CapacityAssessment,
} from "./capacity.ts";

// ── Issue-characteristic taxonomy (PRD deliverable §2: structured routing metadata) ──
//
// Objective, discrete dimensions. Each is a `dimension:value` GitHub label so similar
// issues can be compared later. Kept small on purpose — enough to route, not a survey.

export const COMPLEXITY = ["trivial", "simple", "moderate", "complex"] as const;
export type Complexity = (typeof COMPLEXITY)[number];

export const RISK = ["low", "medium", "high"] as const; // residual blast radius after safeguards
export type Risk = (typeof RISK)[number];

export const CONTEXT_SIZE = ["small", "medium", "large"] as const;
export type ContextSize = (typeof CONTEXT_SIZE)[number];

export const AMBIGUITY = ["clear", "some", "high"] as const;
export type Ambiguity = (typeof AMBIGUITY)[number];

export const REQUIREMENTS_QUALITY = ["good", "adequate", "poor"] as const;
export type RequirementsQuality = (typeof REQUIREMENTS_QUALITY)[number];

export const REASONING_DEPTH = ["shallow", "moderate", "deep"] as const;
export type ReasoningDepth = (typeof REASONING_DEPTH)[number];

export const VERIFICATION_STRENGTH = ["weak", "standard", "strong"] as const;
export type VerificationStrength = (typeof VERIFICATION_STRENGTH)[number];

export const RECOVERABILITY = ["low", "medium", "high"] as const;
export type Recoverability = (typeof RECOVERABILITY)[number];

export interface IssueCharacteristics {
  /** Free-form task class (e.g. "feature", "bugfix", "refactor"), matched to taskClasses. */
  taskType: string;
  complexity: Complexity;
  risk: Risk;
  contextSize: ContextSize;
  ambiguity: Ambiguity;
  requirementsQuality: RequirementsQuality;
  reasoningDepth: ReasoningDepth;
  /** Strength of deterministic feedback available before production (tests, CI, health checks). */
  verificationStrength: VerificationStrength;
  /** How cheaply a bad first attempt can be detected, retried, or rolled back. */
  recoverability: Recoverability;
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
  verificationStrength: "standard",
  recoverability: "medium",
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
  verificationStrength: "verification",
  recoverability: "recoverability",
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
  recoverabilityDiscount: "route:recoverability-discount",
  portfolioBalance: "route:portfolio-balance",
} as const;

export const ROUTING_EFFORTS = [
  "effort:low",
  "effort:medium",
  "effort:high",
  "effort:max",
] as const;
export type RoutingEffort = (typeof ROUTING_EFFORTS)[number];

export interface EffortDecision {
  effortLabel: RoutingEffort;
  reason: string;
}

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
    verificationStrength: oneOf(
      labelValue(labels, p.verificationStrength),
      VERIFICATION_STRENGTH,
      DEFAULT_CHARACTERISTICS.verificationStrength,
    ),
    recoverability: oneOf(
      labelValue(labels, p.recoverability),
      RECOVERABILITY,
      DEFAULT_CHARACTERISTICS.recoverability,
    ),
  };
}

// ── Minimum-viable-tier derivation ──────────────────────────────────────────────

function deriveBaselineTier(c: IssueCharacteristics): ModelTier {
  // Balanced/general is the default. Fast is earned by a complete deterministic
  // execution package, not merely by somebody calling the task "simple".
  if (
    (c.complexity === "trivial" || c.complexity === "simple") &&
    c.risk === "low" &&
    c.ambiguity === "clear" &&
    c.requirementsQuality === "good" &&
    c.reasoningDepth === "shallow" &&
    c.verificationStrength === "strong"
  ) {
    return "fast";
  }

  let rank = c.complexity === "complex" ? 2 : 1;
  // Risk changes how much verification and recovery matter; it does not give a model
  // additional reasoning ability. Only unresolved implementation judgment raises the
  // capability floor. This prevents safety-critical but well-specified work from being
  // priced as architecture merely because its subject is important.
  if (c.reasoningDepth === "deep") rank = Math.max(rank, 2); // complex
  if (c.ambiguity === "high" || c.requirementsQuality === "poor") {
    rank = Math.max(rank, 2); // unresolved approach selection needs the complex lane
  }

  const severeResidualUncertainty =
    c.reasoningDepth === "deep" &&
    (c.ambiguity === "high" || c.requirementsQuality === "poor");
  const weakSafeguards =
    c.verificationStrength === "weak" || c.recoverability === "low";
  if (
    c.complexity === "complex" &&
    c.risk === "high" &&
    severeResidualUncertainty &&
    weakSafeguards
  ) {
    rank = 3; // frontier — a wrong first approach is both likely and expensive
  }
  return MODEL_TIERS[rank]!;
}

/**
 * Strong deterministic feedback and cheap automatic recovery make a cheaper first
 * attempt rational: a miss produces useful evidence and the recovery ladder escalates
 * automatically. High stated risk does not veto this discount: if deterministic
 * verification catches a miss and recovery is genuinely cheap, that risk is already
 * contained. Unclear requirements or residual deep reasoning still prevent it.
 */
export function hasRecoverabilityDiscount(c: IssueCharacteristics): boolean {
  return (
    deriveBaselineTier(c) === "complex" &&
    c.reasoningDepth !== "deep" &&
    c.requirementsQuality === "good" &&
    c.ambiguity !== "high" &&
    c.verificationStrength === "strong" &&
    c.recoverability === "high"
  );
}

/**
 * The lowest plausible tier for the initial attempt, not the tier most likely to finish
 * without a retry. Residual implementation judgment establishes the capability baseline;
 * risk alone does not. A complete execution package can route simple work to fast directly;
 * strong verification plus cheap recovery lowers raw complex scope to general because
 * bounded repair and frontier escalation are already part of the operating contract.
 * Frontier requires severe residual uncertainty plus weak safeguards, so importance or
 * file count alone can never justify it.
 */
export function deriveMinimumTier(c: IssueCharacteristics): ModelTier {
  const baselineRank = tierRank(deriveBaselineTier(c));
  const adjustedRank =
    hasRecoverabilityDiscount(c) && baselineRank > 0 ? baselineRank - 1 : baselineRank;
  return MODEL_TIERS[adjustedRank]!;
}

/**
 * Effort is persistence within a lane, not model intelligence. It is derived from the
 * same provider-neutral workload facts and is deliberately independent of capacity.
 */
export function deriveEffort(c: IssueCharacteristics): EffortDecision {
  const minimumTier = deriveMinimumTier(c);
  if (
    minimumTier === "fast" &&
    c.contextSize === "small" &&
    c.verificationStrength === "strong"
  ) {
    return {
      effortLabel: "effort:low",
      reason: "localized deterministic work with strong verification",
    };
  }
  if (
    minimumTier === "frontier" &&
    (c.verificationStrength === "weak" || c.recoverability === "low")
  ) {
    return {
      effortLabel: "effort:max",
      reason: "frontier work with weak verification or costly recovery warrants exhaustive persistence",
    };
  }
  if (
    c.contextSize === "large" ||
    c.complexity === "complex" ||
    c.verificationStrength === "weak"
  ) {
    return {
      effortLabel: "effort:high",
      reason: "broad bounded execution or multi-step verification requires extra persistence",
    };
  }
  return {
    effortLabel: "effort:medium",
    reason: "default effort for normal implementation and verification",
  };
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
  capacitySelection: "live-headroom" | "rotation" | "only-capable";
  reason: string;
}

export interface RoutingOptions {
  /** Last capacity pool used for an initial automatic assignment. */
  rotationCursor?: string | null;
  /** Differences at or below this value rotate instead of chasing small quota jitter. */
  headroomHysteresisPercent?: number;
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
 * Steps mirror the pickup policy: classify → find capable models → drop unavailable →
 * protect the frontier unless justified → admit at most one tier of non-frontier
 * headroom → prefer materially greater live headroom, otherwise rotate pools → prefer
 * the lowest tier within that pool → record alternatives and determining factors.
 */
export function routeIssue(
  characteristics: IssueCharacteristics,
  capacityByPool: Map<string, CapacityAssessment>,
  models: readonly ModelEntry[] = dispatchableModels(),
  options: RoutingOptions = {},
): RoutingDecision {
  const minimumTier = deriveMinimumTier(characteristics);
  const minRank = tierRank(minimumTier);
  const frontierJustified = minimumTier === "frontier";
  const needsLargeContext = characteristics.contextSize === "large";
  const baselineTier = deriveBaselineTier(characteristics);
  const factors: string[] = [`baseline tier: ${baselineTier}`];
  if (hasRecoverabilityDiscount(characteristics)) {
    factors.push(`recoverability discount: ${baselineTier} → ${minimumTier}`);
  } else {
    factors.push(`minimum viable tier: ${minimumTier}`);
  }

  const alternatives: RoutingAlternative[] = [];
  const eligible: ModelEntry[] = [];

  for (const model of models) {
    // Capability floor: at or above the minimum viable tier.
    if (tierRank(model.tier) < minRank) {
      alternatives.push(alt(model, false, `below minimum viable tier (${model.tier} < ${minimumTier})`));
      continue;
    }
    // One tier of headroom lets adjacent capable pools share subscription load without
    // sending trivial work to a dramatically overqualified model.
    if (!model.frontier && tierRank(model.tier) > minRank + 1) {
      alternatives.push(alt(model, false, `more than one tier above minimum (${model.tier} > ${minimumTier})`));
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
    if (capacity && isModelCapacityExhausted(capacity, model.modelLabel)) {
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
      capacitySelection: "only-capable",
      reason: frontierJustified
        ? "no capable model is available (including the frontier)"
        : "no capable non-frontier model is available — refine the issue or approve frontier use",
    };
  }

  const picked = pickBest(eligible, characteristics, capacityByPool, options);
  const selected = picked.model;
  const capacity = capacityByPool.get(selected.capacityPool);
  const rationaleLabels: string[] = [ROUTING_RATIONALE.minViable];
  factors.push(picked.reason);
  if (picked.basis === "rotation") {
    rationaleLabels.push(ROUTING_RATIONALE.portfolioBalance);
  }
  if (hasRecoverabilityDiscount(characteristics)) {
    rationaleLabels.push(ROUTING_RATIONALE.recoverabilityDiscount);
  }

  const minimumTierAvailable = eligible.some((model) => model.tier === minimumTier);
  if (selected.tier === minimumTier) {
    factors.push(`chose the lowest capable tier (${selected.tier})`);
  } else if (minimumTierAvailable) {
    factors.push(
      `selected adjacent capable tier ${selected.tier} to balance pool ${selected.capacityPool}`,
    );
    if (!rationaleLabels.includes(ROUTING_RATIONALE.portfolioBalance)) {
      rationaleLabels.push(ROUTING_RATIONALE.portfolioBalance);
    }
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
    capacitySelection: picked.basis,
    reason: `selected ${selected.modelLabel} (${selected.tier})`,
  };
}

function alt(model: ModelEntry, eligible: boolean, reason: string): RoutingAlternative {
  return { modelLabel: model.modelLabel, tier: model.tier, eligible, reason };
}

/**
 * Chooses materially greater constrained live headroom when both pools report it. When
 * readings are missing or close, durable deterministic rotation shares work without
 * fabricating a quota estimate. Within the chosen pool it uses the lowest capable tier,
 * then task-class match and registry order as stable tie-breakers.
 */
function pickBest(
  eligible: ModelEntry[],
  c: IssueCharacteristics,
  capacityByPool: Map<string, CapacityAssessment>,
  options: RoutingOptions,
): {
  model: ModelEntry;
  basis: RoutingDecision["capacitySelection"];
  reason: string;
} {
  const taskMatch = (m: ModelEntry) => (m.taskClasses.includes(c.taskType) ? 0 : 1);
  const registryOrder = new Map(eligible.map((model, index) => [model.modelLabel, index]));
  const bestWithinPool = (pool: string): ModelEntry =>
    eligible
      .filter((model) => model.capacityPool === pool)
      .sort(
        (a, b) =>
          tierRank(a.tier) - tierRank(b.tier) ||
          taskMatch(a) - taskMatch(b) ||
          registryOrder.get(a.modelLabel)! - registryOrder.get(b.modelLabel)!,
      )[0]!;

  const pools = [...new Set(eligible.map((model) => model.capacityPool))];
  if (pools.length === 1) {
    return {
      model: bestWithinPool(pools[0]!),
      basis: "only-capable",
      reason: `only capable capacity pool is ${pools[0]}`,
    };
  }

  const representatives = pools.map((pool) => bestWithinPool(pool));
  const headrooms = representatives.map((model) => ({
    model,
    headroom: capacityByPool.has(model.capacityPool)
      ? capacityHeadroomForModel(capacityByPool.get(model.capacityPool)!, model.modelLabel)
      : null,
  }));
  if (headrooms.every((item) => item.headroom !== null)) {
    const sorted = [...headrooms].sort((a, b) => b.headroom! - a.headroom!);
    const spread = sorted[0]!.headroom! - sorted[sorted.length - 1]!.headroom!;
    const hysteresis = options.headroomHysteresisPercent ?? 10;
    if (spread > hysteresis) {
      const winner = sorted[0]!;
      return {
        model: winner.model,
        basis: "live-headroom",
        reason: `preferred ${winner.model.capacityPool} with ${winner.headroom}% constrained headroom`,
      };
    }
  }

  const cursorIndex = options.rotationCursor
    ? pools.indexOf(options.rotationCursor)
    : -1;
  const nextPool = pools[(cursorIndex + 1 + pools.length) % pools.length]!;
  return {
    model: bestWithinPool(nextPool),
    basis: "rotation",
    reason:
      cursorIndex < 0
        ? `capacity was incomparable or close — started deterministic rotation with ${nextPool}`
        : `capacity was incomparable or close — rotated after ${options.rotationCursor} to ${nextPool}`,
  };
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
  /** Compatibility field. Automatic recovery always leaves this false. */
  requiresHumanApproval: boolean;
  rationale: string;
}

function available(model: ModelEntry, capacityByPool: Map<string, CapacityAssessment>): boolean {
  const capacity = capacityByPool.get(model.capacityPool);
  return !(capacity && isModelCapacityExhausted(capacity, model.modelLabel));
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
        !m.frontier &&
        tierRank(m.tier) >= tierRank(currentModel.tier) &&
        tierRank(m.tier) <= tierRank(currentModel.tier) + 1 &&
        m.capacityPool !== currentModel.capacityPool &&
        available(m, capacityByPool),
    );
    const dormantFirst = comparable.sort(
      (a, b) =>
        (capacityByPool.get(a.capacityPool)?.dormant ? 0 : 1) -
        (capacityByPool.get(b.capacityPool)?.dormant ? 0 : 1),
    );
    const handoff =
      dormantFirst[0] ??
      firstAvailable(
        currentModel.fallbacks.filter(
          (label) => models.find((model) => model.modelLabel === label)?.frontier === false,
        ),
        capacityByPool,
        models,
      );
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
