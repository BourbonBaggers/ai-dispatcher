/**
 * The curated model/provider registry — the single data source for routing (#319).
 *
 * The PRD's core instruction is "model/provider configuration should live in data or
 * configuration rather than being scattered through routing code." This file is that
 * data. Every downstream concern — the label allowlist (`labels.ts`), the routing rubric
 * (`routing.ts`), and the capacity ladder (`capacity.ts`) — reads from `MODELS` rather
 * than hard-coding model identifiers.
 *
 * Design rules that keep the live dispatch path safe:
 *   - `cli` is a plain string, not the closed `DispatcherAgent` union, so the registry can
 *     *document* a future provider lane (e.g. a Gemini free tier) as disabled data without
 *     touching the runner's agent switch. Only entries whose `cli` is a known dispatcher
 *     agent AND `enabled` are ever surfaced as a dispatchable label (see `labels.ts`).
 *   - `cliModel` is an explicit, pinned identifier — never a floating alias — so a provider
 *     silently upgrading an alias cannot cause quality-over-cost drift (PRD scope §2).
 *   - This module is pure data + tiny pure accessors: no IO, trivially testable.
 */

/**
 * Capability ladder, ascending. A higher index is a stronger (and more expensive) tier.
 * Routing derives the *minimum viable* tier for an issue and never routes below it, so the
 * ordering here is load-bearing — do not reorder without updating routing expectations.
 */
export const MODEL_TIERS = ["fast", "general", "complex", "frontier"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

/** Ordinal rank of a tier on the ladder (0 = weakest). */
export function tierRank(tier: ModelTier): number {
  return MODEL_TIERS.indexOf(tier);
}

/**
 * The curated routing roles from the PRD's "curated model strategy". A role is the
 * human-facing intent of a lane; `tier` is the machine-comparable strength. They are
 * related but distinct: several models can share a tier while filling different roles.
 */
export const MODEL_ROLES = [
  "fast",
  "general",
  "complex",
  "large-context",
  "planning",
  "frontier-reserve",
] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];

/**
 * A large-context task is one whose working set does not comfortably fit a standard
 * window. 200k tokens is the standard Claude/Codex window; a model is flagged
 * `largeContext` when it is specifically provisioned to go beyond that.
 */
export const STANDARD_CONTEXT_TOKENS = 200_000;

export interface ModelEntry {
  /** The `model:*` GitHub label that selects this model (exactly one per issue). */
  modelLabel: string;
  /** Provider brand, for reporting/telemetry grouping (e.g. "anthropic", "openai"). */
  provider: string;
  /**
   * CLI executable family. Kept a plain string (not `DispatcherAgent`) so a future
   * provider lane can be documented as disabled data. Only "claude" and "codex" are
   * live dispatch agents today.
   */
  cli: string;
  /** Explicit, pinned model identifier handed to the CLI's `--model` flag. */
  cliModel: string;
  /** Human-facing routing role. */
  role: ModelRole;
  /** Machine-comparable capability tier. */
  tier: ModelTier;
  /** Frontier reserve: expensive, protected, requires justification to route to. */
  frontier: boolean;
  /** Intended task classes, used by the routing rubric to match issue characteristics. */
  taskClasses: readonly string[];
  /** Documented maximum context window in tokens. */
  contextWindow: number;
  /** Specifically provisioned for work beyond the standard window. */
  largeContext: boolean;
  /**
   * Subscription/capacity pool this model draws from. Models in the same pool share a
   * capacity budget, so routing prefers a *dormant* pool over a busy one.
   */
  capacityPool: string;
  /** Fallback candidates (model labels), in preference order, for handoff/escalation. */
  fallbacks: readonly string[];
  /** Whether this model may be dispatched. Disabled entries are documentation only. */
  enabled: boolean;
}

/**
 * The registry. Two live lanes today (Claude subscription, Codex subscription) plus
 * disabled entries that honestly document *why* a technically-valid model is excluded and
 * that the architecture already supports a future provider.
 */
export const MODELS: readonly ModelEntry[] = [
  // ── Claude subscription pool ────────────────────────────────────────────────
  {
    modelLabel: "model:claude-haiku-4.5",
    provider: "anthropic",
    cli: "claude",
    cliModel: "claude-haiku-4-5-20251001",
    role: "fast",
    tier: "fast",
    frontier: false,
    taskClasses: ["fast", "simple", "small-scope", "low-risk"],
    contextWindow: STANDARD_CONTEXT_TOKENS,
    largeContext: false,
    capacityPool: "claude-subscription",
    fallbacks: ["model:claude-sonnet-5"],
    enabled: true,
  },
  {
    modelLabel: "model:claude-sonnet-5",
    provider: "anthropic",
    cli: "claude",
    cliModel: "claude-sonnet-5",
    role: "general",
    tier: "general",
    frontier: false,
    // Sonnet is the general implementation lane and doubles as the large-context and
    // planning lane — it handles big working sets and architectural reasoning without
    // consuming frontier (Opus) capacity.
    taskClasses: ["general", "implementation", "large-context", "planning", "refactor"],
    contextWindow: STANDARD_CONTEXT_TOKENS,
    largeContext: true,
    capacityPool: "claude-subscription",
    fallbacks: ["model:claude-opus-4.8"],
    enabled: true,
  },
  {
    modelLabel: "model:claude-opus-4.8",
    provider: "anthropic",
    cli: "claude",
    cliModel: "claude-opus-4-8",
    role: "frontier-reserve",
    tier: "frontier",
    frontier: true,
    taskClasses: ["complex", "high-risk", "planning", "deep-reasoning", "large-blast-radius"],
    contextWindow: STANDARD_CONTEXT_TOKENS,
    largeContext: false,
    capacityPool: "claude-subscription",
    // Frontier has no higher lane to escalate to within its provider; cross-provider is the
    // only remaining move.
    fallbacks: ["model:gpt-5.5"],
    enabled: true,
  },

  // ── Codex subscription pool ─────────────────────────────────────────────────
  {
    modelLabel: "model:gpt-5.5",
    provider: "openai",
    cli: "codex",
    cliModel: "gpt-5.5",
    role: "complex",
    tier: "complex",
    frontier: false,
    taskClasses: ["general", "implementation", "complex", "cross-provider-comparable"],
    contextWindow: STANDARD_CONTEXT_TOKENS,
    largeContext: false,
    capacityPool: "codex-subscription",
    fallbacks: ["model:claude-opus-4.8"],
    enabled: true,
  },

  // ── Disabled: documented-but-not-dispatchable ───────────────────────────────
  {
    // A Codex CLI authenticated with a ChatGPT account returns a hard 400 for this model
    // at call time, so it is intentionally excluded from dispatch. Kept as data so the
    // exclusion (and its reason) is not silently lost.
    modelLabel: "model:gpt-5.5-mini",
    provider: "openai",
    cli: "codex",
    cliModel: "gpt-5.5-mini",
    role: "fast",
    tier: "fast",
    frontier: false,
    taskClasses: ["fast", "simple"],
    contextWindow: STANDARD_CONTEXT_TOKENS,
    largeContext: false,
    capacityPool: "codex-subscription",
    fallbacks: ["model:gpt-5.5"],
    enabled: false,
  },
  {
    // Provider-neutrality proof (PRD principle §9): a future CLI-backed lane (Gemini free
    // capacity) can be added as pure data. It carries a `cli` outside the live dispatcher
    // agent union, so it can never be dispatched until a runner adapter is added — it is
    // documentation of the extension point, not an active lane.
    modelLabel: "model:gemini-2.5-pro",
    provider: "google",
    cli: "gemini",
    cliModel: "gemini-2.5-pro",
    role: "large-context",
    tier: "general",
    frontier: false,
    taskClasses: ["general", "large-context", "free-capacity"],
    contextWindow: 1_000_000,
    largeContext: true,
    capacityPool: "gemini-free",
    fallbacks: ["model:claude-sonnet-5"],
    enabled: false,
  },
];

/** Live dispatcher agents — the only `cli` values a model may have to be dispatchable. */
export const LIVE_DISPATCH_CLIS = ["codex", "claude"] as const;

export function isLiveDispatchCli(cli: string): boolean {
  return (LIVE_DISPATCH_CLIS as readonly string[]).includes(cli);
}

/** A model is dispatchable only when it is enabled AND runs on a live dispatcher agent. */
export function isDispatchable(model: ModelEntry): boolean {
  return model.enabled && isLiveDispatchCli(model.cli);
}

/** Every model that may actually be dispatched today. */
export function dispatchableModels(): ModelEntry[] {
  return MODELS.filter(isDispatchable);
}

/** Look up a model by its `model:*` label, or null. */
export function modelByLabel(modelLabel: string): ModelEntry | null {
  return MODELS.find((m) => m.modelLabel === modelLabel) ?? null;
}

/** Look up a model by explicit CLI identifier, or null. */
export function modelByCliModel(cliModel: string): ModelEntry | null {
  return MODELS.find((m) => m.cliModel === cliModel) ?? null;
}
