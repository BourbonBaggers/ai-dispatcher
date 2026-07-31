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
  modelExpectedCostScore,
  servesRoute,
  tierRank,
  dispatchableModels,
  type ModelEntry,
  type ModelTier,
} from "./models.ts";
import {
  isModelCapacityExhausted,
  poolScarcityMultiplier,
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

export const ISSUE_TYPES = ["bug", "enhancement", "refactor", "chore", "docs", "ops", "research"] as const;
export type IssueType = (typeof ISSUE_TYPES)[number];

export const BUSINESS_RISKS = ["low-stakes", "normal", "destructive"] as const;
export type BusinessRisk = (typeof BUSINESS_RISKS)[number];

export const ROUTE_TIERS = MODEL_TIERS;
export type RouteTier = ModelTier;

export interface IssueCharacteristics {
  issueType: IssueType;
  businessRisk: BusinessRisk;
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
  issueType: "enhancement",
  businessRisk: "normal",
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
  issueType: "type",
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

export const BASE_ROUTE_MATRIX: Record<IssueType, Record<BusinessRisk, RouteTier>> = {
  docs: {
    "low-stakes": "tiny",
    normal: "cheap",
    destructive: "standard",
  },
  chore: {
    "low-stakes": "tiny",
    normal: "cheap",
    destructive: "capable",
  },
  bug: {
    "low-stakes": "cheap",
    normal: "standard",
    destructive: "capable",
  },
  enhancement: {
    "low-stakes": "standard",
    normal: "standard",
    destructive: "capable",
  },
  refactor: {
    "low-stakes": "standard",
    normal: "capable",
    destructive: "hard",
  },
  ops: {
    "low-stakes": "standard",
    normal: "capable",
    destructive: "hard",
  },
  research: {
    "low-stakes": "standard",
    normal: "capable",
    destructive: "hard",
  },
};

/**
 * The highest route the issue-text assessment may reach. Text-derived axes are
 * author-controlled, so they stop below the reserve; frontier requires a human override or
 * durable recovery evidence that cheaper rungs already failed. See `issue-assessment.ts`.
 */
export const TEXT_UPROUTE_CEILING: ModelTier = "hard";

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
  "effort:xhigh",
  "effort:max",
  "effort:ultra",
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

/**
 * Reads a `prefix:value` label, accepting only values in `allowed`.
 *
 * Two different dimensions share the `risk:` prefix — the business risk the author sets
 * (`low-stakes`/`normal`/`destructive`) and the legacy technical risk axis
 * (`low`/`medium`/`high`). Matching on the prefix alone makes the result depend on label
 * order, which during migration silently read a legacy `risk:high` issue as business risk
 * `normal` and routed it a tier too low. Selecting by *value* removes the ambiguity, and
 * both labels can coexist safely while migration runs.
 */
function labelValueIn<T extends string>(
  labels: string[],
  prefix: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const hit = labels.find(
    (l) => l.startsWith(`${prefix}:`) && (allowed as readonly string[]).includes(l.slice(prefix.length + 1)),
  );
  return hit ? (hit.slice(prefix.length + 1) as T) : fallback;
}

function oneOf<T extends string>(value: string | null, allowed: readonly T[], fallback: T): T {
  return value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/** Builds objective characteristics from an issue's labels, filling unlabelled axes with defaults. */
export function parseCharacteristics(labels: string[]): IssueCharacteristics {
  const p = CHARACTERISTIC_LABEL_PREFIXES;
  return {
    issueType: oneOf(labelValue(labels, p.issueType), ISSUE_TYPES, DEFAULT_CHARACTERISTICS.issueType),
    businessRisk: labelValueIn(labels, p.risk, BUSINESS_RISKS, DEFAULT_CHARACTERISTICS.businessRisk),
    taskType: labelValue(labels, p.taskType) ?? DEFAULT_CHARACTERISTICS.taskType,
    complexity: oneOf(labelValue(labels, p.complexity), COMPLEXITY, DEFAULT_CHARACTERISTICS.complexity),
    risk: labelValueIn(labels, p.risk, RISK, DEFAULT_CHARACTERISTICS.risk),
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
  return BASE_ROUTE_MATRIX[c.issueType][c.businessRisk];
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
    tierRank(deriveBaselineTier(c)) > 0 &&
    (c.complexity === "trivial" || c.contextSize === "small") &&
    c.requirementsQuality === "good" &&
    c.ambiguity === "clear" &&
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
  if (c.requirementsQuality === "poor") return "standard";
  let adjustedRank = hasRecoverabilityDiscount(c) && baselineRank > 0 ? baselineRank - 1 : baselineRank;
  const upRouteEvidence =
    c.contextSize === "large" ||
    c.ambiguity === "high" ||
    c.reasoningDepth === "deep" ||
    c.complexity === "complex" ||
    c.verificationStrength === "weak";
  // Up-routing stops below the reserve. These axes are now derived from author-controlled
  // issue text, so letting them reach `frontier` would let anyone spend the expensive pool
  // by wording an issue a certain way. Frontier stays reachable only through human
  // override or the recovery ladder, which requires proof that cheaper rungs failed.
  const ceiling = tierRank(TEXT_UPROUTE_CEILING);
  if (upRouteEvidence && adjustedRank < ceiling) adjustedRank += 1;
  return MODEL_TIERS[adjustedRank]!;
}

/**
 * Effort per route tier (#51 §4). Effort is persistence within a lane, not model
 * intelligence, and it is an economic control in its own right because it scales tokens
 * consumed. One table so routing and recovery cannot drift apart.
 */
export const ROUTE_EFFORT: Record<RouteTier, EffortDecision> = {
  tiny: { effortLabel: "effort:low", reason: "tiny and cheap deterministic work uses low effort" },
  cheap: { effortLabel: "effort:low", reason: "tiny and cheap deterministic work uses low effort" },
  standard: {
    effortLabel: "effort:medium",
    reason: "default effort for normal implementation and verification",
  },
  capable: {
    effortLabel: "effort:medium",
    reason: "default effort for normal implementation and verification",
  },
  hard: { effortLabel: "effort:high", reason: "hard work uses high effort" },
  frontier: { effortLabel: "effort:xhigh", reason: "frontier work uses extra-high persistence" },
  "ultra-frontier": {
    effortLabel: "effort:max",
    reason: "ultra-frontier work requires explicit maximum persistence",
  },
};

export function effortForRouteTier(tier: RouteTier): EffortDecision {
  return ROUTE_EFFORT[tier];
}

/** Effort for an issue, derived from the same workload facts and independent of capacity. */
export function deriveEffort(c: IssueCharacteristics): EffortDecision {
  return effortForRouteTier(deriveMinimumTier(c));
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
  capacitySelection: CapacitySelectionBasis;
  reason: string;
  needsInput: boolean;
}

/**
 * How the winning candidate was chosen. `lowest-burn` is the normal case; the others say
 * capacity had to intervene. Legacy values are retained so durable records written before
 * scarcity weighting still parse.
 */
export const CAPACITY_SELECTION_BASES = [
  "lowest-burn",
  "scarcity-weighted",
  "sole-candidate",
  "agent-override",
  // historical, no longer produced:
  "live-headroom",
  "rotation",
  "only-capable",
  "human-override",
] as const;
export type CapacitySelectionBasis = (typeof CAPACITY_SELECTION_BASES)[number];

export interface RoutingOptions {
  /**
   * Retained for durable-state compatibility. Scarcity weighting replaced pool rotation:
   * rotating spends headroom the dispatcher has no evidence it needs to spend.
   */
  rotationCursor?: string | null;
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
 * protect the reserves unless the route itself demands them → drop pools without capacity
 * → pick the lowest scarcity-weighted burn → record alternatives and determining factors.
 */
export function routeIssue(
  characteristics: IssueCharacteristics,
  capacityByPool: Map<string, CapacityAssessment>,
  models: readonly ModelEntry[] = dispatchableModels(),
  options: RoutingOptions = {},
): RoutingDecision {
  const minimumTier = deriveMinimumTier(characteristics);
  const effort = deriveEffort(characteristics);
  const frontierJustified = minimumTier === "frontier";
  const needsLargeContext = characteristics.contextSize === "large";
  const baselineTier = deriveBaselineTier(characteristics);
  const factors: string[] = [`baseline tier: ${baselineTier}`];
  if (characteristics.requirementsQuality === "poor") {
    factors.push("poor requirements: needs-input instead of expensive-model escalation");
  }
  if (hasRecoverabilityDiscount(characteristics)) {
    factors.push(`recoverability discount: ${baselineTier} → ${minimumTier}`);
  } else {
    factors.push(`minimum viable tier: ${minimumTier}`);
  }

  const alternatives: RoutingAlternative[] = [];
  const eligible: ModelEntry[] = [];
  /** Route-capable models that only capacity removed — the real capacity-constrained set. */
  const blockedByCapacity: ModelEntry[] = [];

  for (const model of models) {
    // The registry declares which routes each model serves. Routing must never re-derive
    // that from a model label, or `models.ts` stops being the single source of config.
    if (!servesRoute(model, minimumTier)) {
      alternatives.push(alt(model, false, `does not serve the ${minimumTier} route`));
      continue;
    }
    // Large-context work requires a model provisioned for it.
    if (needsLargeContext && !model.largeContext) {
      alternatives.push(alt(model, false, "not provisioned for large-context work"));
      continue;
    }
    // Protect the reserves. Both guards are belt-and-braces now that `routeTiers` gates
    // eligibility, but they keep the invariant local and obvious: nothing reaches an
    // ultra-frontier model automatically, and a frontier model needs a frontier route.
    if (model.tier === "ultra-frontier") {
      alternatives.push(alt(model, false, "ultra-frontier model requires explicit reserve selection"));
      continue;
    }
    if (model.frontier && !frontierJustified) {
      alternatives.push(alt(model, false, "frontier model withheld — not justified by characteristics"));
      continue;
    }
    // Drop unavailable capacity.
    const capacity = capacityByPool.get(model.capacityPool);
    if (capacity && isModelCapacityExhausted(capacity, model.modelLabel)) {
      alternatives.push(alt(model, false, `pool ${model.capacityPool} exhausted`));
      blockedByCapacity.push(model);
      continue;
    }
    alternatives.push(alt(model, true, "serves the route and has capacity"));
    eligible.push(model);
  }

  if (characteristics.requirementsQuality === "poor") {
    return {
      selected: null,
      minimumTier,
      confidence: "low",
      determiningFactors: factors,
      rationaleLabels: [],
      alternatives,
      capacitySelection: "sole-candidate",
      reason: "needs-input: requirements are missing or contradictory",
      needsInput: true,
    };
  }

  if (eligible.length === 0) {
    return {
      selected: null,
      minimumTier,
      confidence: "low",
      determiningFactors: factors,
      rationaleLabels: [],
      alternatives,
      capacitySelection: "sole-candidate",
      reason: frontierJustified
        ? "no capable model is available (including the frontier)"
        : "no capable non-frontier model is available — refine the issue or approve frontier use",
      needsInput: false,
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

  // Rationale labels are the learning dataset's ground truth, so each one must describe
  // what actually decided this pick. Claiming "capacity constrained" or "portfolio
  // balance" on a plain cheapest-first choice poisons every later cost comparison.
  if (picked.basis === "scarcity-weighted") {
    factors.push(picked.scarcityNote);
    rationaleLabels.push(ROUTING_RATIONALE.portfolioBalance);
  }
  // "Capacity constrained" means a model that would otherwise have won was unavailable —
  // not merely that the ladder had no model at this exact tier.
  const selectedBurn = modelExpectedCostScore(selected, effort.effortLabel);
  const cheaperBlocked = blockedByCapacity
    .filter((model) => modelExpectedCostScore(model, effort.effortLabel) < selectedBurn)
    .sort(
      (a, b) =>
        modelExpectedCostScore(a, effort.effortLabel) - modelExpectedCostScore(b, effort.effortLabel),
    )[0];
  if (cheaperBlocked) {
    factors.push(`lower-burn candidate ${cheaperBlocked.modelLabel} had no capacity`);
    rationaleLabels.push(ROUTING_RATIONALE.capacityConstrained);
  }
  if (capacity?.dormant && picked.basis !== "sole-candidate") {
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
    needsInput: false,
  };
}

function alt(model: ModelEntry, eligible: boolean, reason: string): RoutingAlternative {
  return { modelLabel: model.modelLabel, tier: model.tier, eligible, reason };
}

interface PickedModel {
  model: ModelEntry;
  basis: RoutingDecision["capacitySelection"];
  reason: string;
  /** Set when scarcity, not burn rate, decided the winner — used for the rationale label. */
  scarcityNote: string;
}

/**
 * Selects the candidate with the lowest scarcity-weighted burn.
 *
 * The operating economics are subscription-based: the dispatcher is not really spending
 * dollars per attempt, it is spending a provider's rolling usage window, and running that
 * window dry can cost days of access to the whole pool. Those two facts point the same way
 * almost always — the cheapest adequate model burns the least headroom, so cheapest-first
 * *is* headroom preservation — and only diverge near a limit, where continuing to feed the
 * cheap-but-nearly-spent pool trades a small price saving for a large outage risk.
 *
 * One score expresses both: burn rate scaled by how scarce its pool is. Below the scarcity
 * knee the multiplier is ~1 and this is exactly cheapest-first; as a window drains the
 * penalty overtakes the price gap and work moves to the other provider on its own. There
 * is no separate rotation rule, because rotation would spend headroom the dispatcher has
 * no evidence it needs to spend.
 */
function pickBest(
  eligible: ModelEntry[],
  c: IssueCharacteristics,
  capacityByPool: Map<string, CapacityAssessment>,
  _options: RoutingOptions,
): PickedModel {
  const taskMatch = (m: ModelEntry) => (m.taskClasses.includes(c.taskType) ? 0 : 1);
  const registryOrder = new Map(eligible.map((model, index) => [model.modelLabel, index]));
  const effort = deriveEffort(c).effortLabel;

  const scored = eligible.map((model) => {
    const burn = modelExpectedCostScore(model, effort);
    const scarcity = poolScarcityMultiplier(capacityByPool.get(model.capacityPool), model.modelLabel);
    return { model, burn, scarcity, score: burn * scarcity };
  });
  // Ties resolve deterministically so an unchanged fleet keeps producing the same route.
  const order = (a: typeof scored[number], b: typeof scored[number]) =>
    a.score - b.score ||
    a.burn - b.burn ||
    taskMatch(a.model) - taskMatch(b.model) ||
    registryOrder.get(a.model.modelLabel)! - registryOrder.get(b.model.modelLabel)!;

  const byScore = [...scored].sort(order);
  const winner = byScore[0]!;
  const byBurn = [...scored].sort((a, b) => a.burn - b.burn || order(a, b));
  const lowestBurn = byBurn[0]!;

  if (eligible.length === 1) {
    return {
      model: winner.model,
      basis: "sole-candidate",
      reason: `only ${winner.model.modelLabel} serves this route with capacity`,
      scarcityNote: "",
    };
  }

  if (winner.model.modelLabel !== lowestBurn.model.modelLabel) {
    return {
      model: winner.model,
      basis: "scarcity-weighted",
      reason: `selected ${winner.model.modelLabel} — scarcity-weighted burn`,
      scarcityNote:
        `pool ${lowestBurn.model.capacityPool} is too spent to absorb ${lowestBurn.model.modelLabel} ` +
        `(scarcity x${lowestBurn.scarcity.toFixed(2)}); moved to ${winner.model.capacityPool} ` +
        `(x${winner.scarcity.toFixed(2)})`,
    };
  }

  return {
    model: winner.model,
    basis: "lowest-burn",
    reason: `selected lowest-burn candidate ${winner.model.modelLabel}`,
    scarcityNote: "",
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

export interface NextAttemptOptions {
  /**
   * The route this issue was assigned at pickup. Escalation walks the *route* ladder, not
   * the current model's home tier — otherwise a frontier model used to repair one phase
   * would silently make the next phase's ordinary repairs frontier attempts too, which the
   * operating contract forbids. Defaults to the model's home tier when a legacy run has no
   * durable route evidence.
   */
  routeTier?: RouteTier;
}

/**
 * Plans the next attempt after a failure, cost-driven rather than reflexively escalating
 * within one provider. Fallback preference comes from the model's own `fallbacks` list.
 * Frontier is only ever reached when lower-tier repair attempts have failed. That final
 * escalation is automatic; operator involvement begins only if frontier also fails.
 *
 * Candidate ranking reuses the pickup economics — scarcity-weighted burn — so recovery
 * cannot quietly drain a nearly-spent pool that routing was already steering away from.
 */
export function planNextAttempt(
  failureCategory: FailureCategory,
  currentModel: ModelEntry,
  capacityByPool: Map<string, CapacityAssessment>,
  models: readonly ModelEntry[] = dispatchableModels(),
  options: NextAttemptOptions = {},
): NextAttemptPlan {
  const reason = ESCALATION_REASON[failureCategory];
  const routeTier = options.routeTier ?? currentModel.tier;
  /** Lowest scarcity-weighted burn first — the same rule pickup uses. */
  const cheapestFirst = (tier: RouteTier) => (a: ModelEntry, b: ModelEntry) => {
    const effort = effortForRouteTier(tier).effortLabel;
    const score = (m: ModelEntry) =>
      modelExpectedCostScore(m, effort) *
      poolScarcityMultiplier(capacityByPool.get(m.capacityPool), m.modelLabel);
    return score(a) - score(b);
  };

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
    // Comparable = serves the same route, different pool. No tier arithmetic: the registry
    // already says which models are substitutable for this route.
    const comparable = models
      .filter(
        (m) =>
          !m.frontier &&
          servesRoute(m, routeTier) &&
          m.capacityPool !== currentModel.capacityPool &&
          available(m, capacityByPool),
      )
      .sort(cheapestFirst(routeTier));
    const handoff =
      comparable[0] ??
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
      .filter((m) => m.largeContext && available(m, capacityByPool) && !m.frontier)
      .sort(cheapestFirst(routeTier));
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

  // Implementation / test failure: escalate exactly one *route* tier. Frontier is the
  // final automated rung; failure there is the handoff point.
  const nextRank = tierRank(routeTier) + 1;
  // Automation is exhausted when the *route* has reached the frontier and failed there —
  // not merely because the last attempt happened to run on a frontier model. A frontier
  // model borrowed to repair one phase must leave the next phase's ordinary repairs on the
  // assigned route, or one escalation permanently promotes the whole issue.
  if (currentModel.frontier && tierRank(routeTier) >= tierRank("frontier")) {
    return {
      action: "hold",
      model: null,
      escalationReason: reason,
      requiresHumanApproval: false,
      rationale: "frontier attempt failed — automation exhausted",
    };
  }
  if (nextRank >= tierRank("frontier")) {
    // Already at the strongest non-frontier tier: use an explicit fallback if present.
    const fallback = firstAvailable(
      currentModel.fallbacks.filter((label) => modelByLabelLocal(label, models)?.tier !== "ultra-frontier"),
      capacityByPool,
      models,
    );
    if (fallback) {
      return {
        action: fallback.frontier ? "escalate-frontier" : "handoff",
        model: fallback,
        escalationReason: reason,
        requiresHumanApproval: false,
        rationale: fallback.frontier
          ? `escalate automatically to final frontier attempt (${fallback.modelLabel})`
          : `top tier reached — hand off to ${fallback.modelLabel}`,
      };
    }
    return { action: "hold", model: null, escalationReason: reason, requiresHumanApproval: false, rationale: "already at the strongest tier — hold for a human" };
  }
  const nextTier = MODEL_TIERS[nextRank]!;
  const stronger = models
    .filter(
      (m) => servesRoute(m, nextTier) && m.tier !== "ultra-frontier" && available(m, capacityByPool),
    )
    .sort(cheapestFirst(nextTier));
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

function modelByLabelLocal(label: string, models: readonly ModelEntry[]): ModelEntry | null {
  return models.find((model) => model.modelLabel === label) ?? null;
}
