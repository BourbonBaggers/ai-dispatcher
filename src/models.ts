/**
 * The curated model/provider registry — the authoritative model catalog owned by the
 * standalone dispatcher.
 *
 * This catalog is self-contained and has no external imports. It is the single
 * authority for the model catalog.
 */

export const MODEL_TIERS = [
  "tiny",
  "cheap",
  "standard",
  "capable",
  "hard",
  "frontier",
  "ultra-frontier",
] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

export function tierRank(tier: ModelTier): number {
  return MODEL_TIERS.indexOf(tier);
}

export const MODEL_ROLES = [
  "tiny",
  "cheap",
  "standard",
  "capable",
  "hard",
  "large-context",
  "planning",
  "frontier-reserve",
  "ultra-frontier-reserve",
] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];

export const STANDARD_CONTEXT_TOKENS = 200_000;

export interface ModelEntry {
  modelLabel: string;
  provider: string;
  cli: string;
  cliModel: string;
  role: ModelRole;
  /**
   * The model's home capability class. Used for registry ordering, display, and as the
   * escalation anchor when a run has no durable route evidence. Must appear in
   * `routeTiers`.
   */
  tier: ModelTier;
  /**
   * Every route tier this model is a valid selection for, cheapest-first. A model spans
   * several routes because *effort* — not a different model — supplies the extra
   * persistence a harder route needs (issue #51 §4). This is the single source of
   * eligibility: routing must never re-derive a model's route span from its label, or the
   * registry stops being the one place a model is configured.
   */
  routeTiers: readonly ModelTier[];
  frontier: boolean;
  taskClasses: readonly string[];
  contextWindow: number;
  largeContext: boolean;
  capacityPool: string;
  fallbacks: readonly string[];
  listPrice: ModelPriceSchedule;
  enabled: boolean;
  /**
   * When true, this model is excluded from normal issue pickup and routing. It is only
   * eligible when both primary providers (Codex and Claude) are confirmed exhausted for
   * the same quota window. OpenCode Zen models use this flag.
   */
  fallbackOnly?: boolean;
}

export interface ModelPrice {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  cachedInputUsdPerMillion?: number;
  longContextInputUsdPerMillion?: number;
  longContextOutputUsdPerMillion?: number;
  source: string;
  effectiveFrom: string;
  effectiveUntil?: string;
}

export interface ModelPriceSchedule {
  standardContext: readonly ModelPrice[];
}

export const MODELS: readonly ModelEntry[] = [
  {
    modelLabel: "model:claude-haiku-4.5",
    provider: "anthropic",
    cli: "claude",
    cliModel: "claude-haiku-4-5-20251001",
    role: "tiny",
    tier: "tiny",
    // Haiku carries the Claude side of every cheap lane up to `standard`; effort, not a
    // bigger model, is what separates those routes (#51 §3 catalog).
    routeTiers: ["tiny", "cheap", "standard"],
    frontier: false,
    taskClasses: ["fast", "simple", "small-scope", "low-risk"],
    contextWindow: STANDARD_CONTEXT_TOKENS,
    largeContext: false,
    capacityPool: "claude-subscription",
    fallbacks: ["model:claude-sonnet-5"],
    listPrice: {
      standardContext: [
        {
          inputUsdPerMillion: 1,
          outputUsdPerMillion: 5,
          source: "anthropic-haiku-4-5",
          effectiveFrom: "2025-10-01",
        },
      ],
    },
    enabled: true,
  },
  {
    modelLabel: "model:claude-sonnet-5",
    provider: "anthropic",
    cli: "claude",
    cliModel: "claude-sonnet-5",
    role: "capable",
    tier: "capable",
    routeTiers: ["capable", "hard"],
    frontier: false,
    taskClasses: ["general", "implementation", "large-context", "planning", "refactor"],
    contextWindow: STANDARD_CONTEXT_TOKENS,
    largeContext: true,
    capacityPool: "claude-subscription",
    fallbacks: ["model:claude-opus-5.5"],
    listPrice: {
      standardContext: [
        {
          inputUsdPerMillion: 2,
          outputUsdPerMillion: 10,
          source: "anthropic-sonnet-5-promotional",
          effectiveFrom: "2026-01-01",
          effectiveUntil: "2026-08-31",
        },
        {
          inputUsdPerMillion: 3,
          outputUsdPerMillion: 15,
          source: "anthropic-sonnet-5-standard",
          effectiveFrom: "2026-09-01",
        },
      ],
    },
    enabled: true,
  },
  {
    modelLabel: "model:claude-opus-5.5",
    provider: "anthropic",
    cli: "claude",
    cliModel: "claude-opus-5-5",
    role: "frontier-reserve",
    tier: "frontier",
    routeTiers: ["frontier"],
    frontier: true,
    taskClasses: ["complex", "high-risk", "planning", "deep-reasoning", "large-blast-radius"],
    contextWindow: 1_000_000,
    largeContext: true,
    capacityPool: "claude-subscription",
    fallbacks: ["model:claude-fable-5.1", "model:gpt-6-astra"],
    listPrice: {
      standardContext: [
        {
          inputUsdPerMillion: 4,
          outputUsdPerMillion: 20,
          source: "anthropic-opus-5-5",
          effectiveFrom: "2026-09-25",
        },
      ],
    },
    enabled: true,
  },
  {
    modelLabel: "model:claude-opus-5",
    provider: "anthropic",
    cli: "claude",
    cliModel: "claude-opus-5",
    role: "frontier-reserve",
    tier: "frontier",
    routeTiers: ["frontier"],
    frontier: true,
    taskClasses: ["complex", "high-risk", "planning", "deep-reasoning", "large-blast-radius"],
    contextWindow: 1_000_000,
    largeContext: true,
    capacityPool: "claude-subscription",
    fallbacks: ["model:claude-opus-5.5", "model:claude-opus-4.8"],
    listPrice: {
      standardContext: [
        {
          inputUsdPerMillion: 5,
          outputUsdPerMillion: 25,
          source: "anthropic-opus-5",
          effectiveFrom: "2026-07-24",
        },
      ],
    },
    enabled: true,
  },
  {
    modelLabel: "model:claude-opus-4.8",
    provider: "anthropic",
    cli: "claude",
    cliModel: "claude-opus-4-8",
    role: "frontier-reserve",
    tier: "frontier",
    routeTiers: ["frontier"],
    frontier: true,
    taskClasses: ["complex", "high-risk", "planning", "deep-reasoning", "large-blast-radius"],
    contextWindow: STANDARD_CONTEXT_TOKENS,
    largeContext: false,
    capacityPool: "claude-subscription",
    fallbacks: ["model:claude-opus-5.5", "model:gpt-6-astra"],
    listPrice: {
      standardContext: [
        {
          inputUsdPerMillion: 5,
          outputUsdPerMillion: 25,
          source: "anthropic-opus-4-8",
          effectiveFrom: "2026-01-01",
        },
      ],
    },
    enabled: true,
  },
  {
    modelLabel: "model:claude-fable-5.1",
    provider: "anthropic",
    cli: "claude",
    cliModel: "claude-fable-5-1",
    role: "ultra-frontier-reserve",
    tier: "ultra-frontier",
    routeTiers: ["ultra-frontier"],
    frontier: true,
    taskClasses: ["ultra-frontier", "explicit-reserve", "long-horizon"],
    contextWindow: 1_000_000,
    largeContext: true,
    capacityPool: "claude-subscription",
    fallbacks: ["model:claude-opus-5.5"],
    listPrice: {
      standardContext: [
        {
          inputUsdPerMillion: 10,
          outputUsdPerMillion: 50,
          source: "anthropic-fable-5-1",
          effectiveFrom: "2026-09-25",
        },
      ],
    },
    enabled: true,
  },
  {
    modelLabel: "model:claude-fable-5",
    provider: "anthropic",
    cli: "claude",
    cliModel: "claude-fable-5",
    role: "ultra-frontier-reserve",
    tier: "ultra-frontier",
    routeTiers: ["ultra-frontier"],
    frontier: true,
    taskClasses: ["ultra-frontier", "explicit-reserve"],
    contextWindow: 1_000_000,
    largeContext: true,
    capacityPool: "claude-subscription",
    fallbacks: ["model:claude-fable-5.1", "model:claude-opus-5.5"],
    listPrice: {
      standardContext: [
        {
          inputUsdPerMillion: 10,
          outputUsdPerMillion: 50,
          source: "anthropic-fable-5",
          effectiveFrom: "2026-01-01",
        },
      ],
    },
    enabled: true,
  },
  {
    modelLabel: "model:gpt-6-luna",
    provider: "openai",
    cli: "codex",
    cliModel: "gpt-6-luna",
    role: "tiny",
    tier: "standard",
    routeTiers: ["tiny", "cheap", "standard"],
    frontier: false,
    taskClasses: ["tiny", "cheap", "standard", "general", "implementation", "high-volume"],
    contextWindow: 1_050_000,
    largeContext: true,
    capacityPool: "codex-subscription",
    fallbacks: ["model:gpt-6-sol", "model:claude-haiku-4.5"],
    listPrice: {
      standardContext: [
        {
          inputUsdPerMillion: 0.1,
          outputUsdPerMillion: 0.5,
          source: "openai-gpt-6-luna",
          effectiveFrom: "2026-09-25",
        },
      ],
    },
    enabled: true,
  },
  {
    modelLabel: "model:gpt-5.4-mini",
    provider: "openai",
    cli: "codex",
    cliModel: "gpt-5.4-mini",
    role: "tiny",
    tier: "tiny",
    routeTiers: ["tiny", "cheap"],
    frontier: false,
    taskClasses: ["tiny", "cheap", "simple", "small-scope", "low-risk"],
    contextWindow: STANDARD_CONTEXT_TOKENS,
    largeContext: false,
    capacityPool: "codex-subscription",
    fallbacks: ["model:gpt-6-luna", "model:claude-haiku-4.5"],
    listPrice: {
      standardContext: [
        {
          inputUsdPerMillion: 0.75,
          outputUsdPerMillion: 4.5,
          source: "openai-standard",
          effectiveFrom: "2026-01-01",
        },
      ],
    },
    enabled: true,
  },
  {
    modelLabel: "model:gpt-6-sol",
    provider: "openai",
    cli: "codex",
    cliModel: "gpt-6-sol",
    role: "capable",
    tier: "capable",
    routeTiers: ["capable", "hard"],
    frontier: false,
    taskClasses: ["capable", "hard", "implementation", "refactor", "planning"],
    contextWindow: 1_050_000,
    largeContext: true,
    capacityPool: "codex-subscription",
    fallbacks: ["model:gpt-6-astra", "model:claude-sonnet-5"],
    listPrice: {
      standardContext: [
        {
          inputUsdPerMillion: 2,
          outputUsdPerMillion: 10,
          source: "openai-gpt-6-sol",
          effectiveFrom: "2026-09-25",
        },
      ],
    },
    enabled: true,
  },
  {
    modelLabel: "model:gpt-5.6-luna",
    provider: "openai",
    cli: "codex",
    cliModel: "gpt-5.6-luna",
    role: "standard",
    tier: "standard",
    routeTiers: ["standard"],
    frontier: false,
    taskClasses: ["standard", "general", "implementation"],
    contextWindow: STANDARD_CONTEXT_TOKENS,
    largeContext: false,
    capacityPool: "codex-subscription",
    fallbacks: ["model:gpt-6-sol", "model:claude-haiku-4.5"],
    listPrice: {
      standardContext: [
        {
          inputUsdPerMillion: 1,
          outputUsdPerMillion: 6,
          source: "openai-standard",
          effectiveFrom: "2026-01-01",
        },
      ],
    },
    enabled: true,
  },
  {
    modelLabel: "model:gpt-5.6-terra",
    provider: "openai",
    cli: "codex",
    cliModel: "gpt-5.6-terra",
    role: "capable",
    tier: "capable",
    routeTiers: ["capable", "hard"],
    frontier: false,
    taskClasses: ["capable", "hard", "implementation", "refactor", "cross-provider-comparable"],
    contextWindow: STANDARD_CONTEXT_TOKENS,
    largeContext: false,
    capacityPool: "codex-subscription",
    fallbacks: ["model:gpt-6-sol", "model:gpt-6-astra", "model:claude-sonnet-5"],
    listPrice: {
      standardContext: [
        {
          inputUsdPerMillion: 2.5,
          outputUsdPerMillion: 15,
          source: "openai-standard",
          effectiveFrom: "2026-01-01",
        },
      ],
    },
    enabled: true,
  },
  {
    modelLabel: "model:gpt-5.4",
    provider: "openai",
    cli: "codex",
    cliModel: "gpt-5.4",
    role: "capable",
    tier: "capable",
    // Assignable alternate only: it shares terra's price but not its `hard` span, so it
    // never wins routine traffic on a tie (#51 §3 "dominated alternates").
    routeTiers: ["capable"],
    frontier: false,
    taskClasses: ["capable", "alternate", "implementation"],
    contextWindow: STANDARD_CONTEXT_TOKENS,
    largeContext: false,
    capacityPool: "codex-subscription",
    fallbacks: ["model:gpt-5.6-terra", "model:claude-sonnet-5"],
    listPrice: {
      standardContext: [
        {
          inputUsdPerMillion: 2.5,
          outputUsdPerMillion: 15,
          source: "openai-standard",
          effectiveFrom: "2026-01-01",
        },
      ],
    },
    enabled: true,
  },
  {
    modelLabel: "model:gpt-6-astra",
    provider: "openai",
    cli: "codex",
    cliModel: "gpt-6-astra",
    role: "frontier-reserve",
    tier: "frontier",
    routeTiers: ["frontier", "ultra-frontier"],
    frontier: true,
    taskClasses: ["frontier", "ultra-frontier", "complex", "deep-reasoning", "long-horizon"],
    contextWindow: 1_050_000,
    largeContext: true,
    capacityPool: "codex-subscription",
    fallbacks: ["model:claude-fable-5.1", "model:claude-opus-5.5"],
    listPrice: {
      standardContext: [
        {
          inputUsdPerMillion: 10,
          outputUsdPerMillion: 50,
          source: "openai-gpt-6-astra",
          effectiveFrom: "2026-09-25",
        },
      ],
    },
    enabled: true,
  },
  {
    modelLabel: "model:gpt-5.6-sol",
    provider: "openai",
    cli: "codex",
    cliModel: "gpt-5.6-sol",
    role: "frontier-reserve",
    tier: "frontier",
    // Sol is the Codex option at both reserve routes (#51 §3); `ultra-frontier` still
    // requires explicit reserve selection, so spanning it here grants no automatic reach.
    routeTiers: ["frontier", "ultra-frontier"],
    frontier: true,
    taskClasses: ["frontier", "complex", "deep-reasoning"],
    contextWindow: STANDARD_CONTEXT_TOKENS,
    largeContext: false,
    capacityPool: "codex-subscription",
    fallbacks: ["model:gpt-6-astra", "model:claude-opus-5.5"],
    listPrice: {
      standardContext: [
        {
          inputUsdPerMillion: 5,
          outputUsdPerMillion: 30,
          source: "openai-standard",
          effectiveFrom: "2026-01-01",
        },
      ],
    },
    enabled: true,
  },
  {
    modelLabel: "model:gpt-5.5",
    provider: "openai",
    cli: "codex",
    cliModel: "gpt-5.5",
    role: "frontier-reserve",
    tier: "frontier",
    routeTiers: ["frontier"],
    frontier: true,
    taskClasses: ["frontier", "alternate", "implementation"],
    contextWindow: STANDARD_CONTEXT_TOKENS,
    largeContext: false,
    capacityPool: "codex-subscription",
    fallbacks: ["model:gpt-6-astra", "model:claude-opus-5.5"],
    listPrice: {
      standardContext: [
        {
          inputUsdPerMillion: 5,
          outputUsdPerMillion: 30,
          source: "openai-standard",
          effectiveFrom: "2026-01-01",
        },
      ],
    },
    enabled: true,
  },
  {
    modelLabel: "model:gemini-2.5-pro",
    provider: "google",
    cli: "gemini",
    cliModel: "gemini-2.5-pro",
    role: "large-context",
    tier: "standard",
    routeTiers: ["standard", "capable"],
    frontier: false,
    taskClasses: ["general", "large-context", "free-capacity"],
    contextWindow: STANDARD_CONTEXT_TOKENS,
    largeContext: true,
    capacityPool: "gemini-free",
    fallbacks: ["model:claude-sonnet-5"],
    listPrice: {
      standardContext: [
        {
          inputUsdPerMillion: 0,
          outputUsdPerMillion: 0,
          source: "disabled-future-provider",
          effectiveFrom: "2026-01-01",
        },
      ],
    },
    enabled: false,
  },
  // OpenCode Zen fallback models (quota-exhaustion only, never normal pickup)
  {
    modelLabel: "model:opencode-deepseek-v4-flash",
    provider: "opencode",
    cli: "opencode",
    cliModel: "deepseek-v4-flash",
    role: "tiny",
    tier: "tiny",
    routeTiers: ["tiny", "cheap"],
    frontier: false,
    taskClasses: ["tiny", "cheap", "simple", "small-scope", "low-risk"],
    contextWindow: STANDARD_CONTEXT_TOKENS,
    largeContext: false,
    capacityPool: "opencode-zen",
    fallbacks: ["model:claude-haiku-4.5"],
    listPrice: {
      standardContext: [
        {
          inputUsdPerMillion: 0.5,
          outputUsdPerMillion: 2.5,
          source: "opencode-zen-deepseek-flash",
          effectiveFrom: "2026-01-01",
        },
      ],
    },
    enabled: true,
    fallbackOnly: true,
  },
  {
    modelLabel: "model:opencode-minimax-m3",
    provider: "opencode",
    cli: "opencode",
    cliModel: "minimax-m3",
    role: "standard",
    tier: "standard",
    routeTiers: ["tiny", "cheap", "standard"],
    frontier: false,
    taskClasses: ["standard", "general", "implementation"],
    contextWindow: STANDARD_CONTEXT_TOKENS,
    largeContext: false,
    capacityPool: "opencode-zen",
    fallbacks: ["model:claude-sonnet-5"],
    listPrice: {
      standardContext: [
        {
          inputUsdPerMillion: 1,
          outputUsdPerMillion: 5,
          source: "opencode-zen-minimax",
          effectiveFrom: "2026-01-01",
        },
      ],
    },
    enabled: true,
    fallbackOnly: true,
  },
  {
    modelLabel: "model:opencode-grok-build-0.1",
    provider: "opencode",
    cli: "opencode",
    cliModel: "grok-build-0.1",
    role: "standard",
    tier: "standard",
    routeTiers: ["tiny", "cheap", "standard"],
    frontier: false,
    taskClasses: ["standard", "general", "implementation"],
    contextWindow: STANDARD_CONTEXT_TOKENS,
    largeContext: false,
    capacityPool: "opencode-zen",
    fallbacks: ["model:claude-sonnet-5"],
    listPrice: {
      standardContext: [
        {
          inputUsdPerMillion: 1.5,
          outputUsdPerMillion: 7.5,
          source: "opencode-zen-grok",
          effectiveFrom: "2026-01-01",
        },
      ],
    },
    enabled: true,
    fallbackOnly: true,
  },
  {
    modelLabel: "model:opencode-glm-5.2",
    provider: "opencode",
    cli: "opencode",
    cliModel: "glm-5.2",
    role: "capable",
    tier: "capable",
    routeTiers: ["capable", "hard"],
    frontier: false,
    taskClasses: ["capable", "hard", "implementation", "refactor"],
    contextWindow: STANDARD_CONTEXT_TOKENS,
    largeContext: false,
    capacityPool: "opencode-zen",
    fallbacks: ["model:claude-opus-4.8"],
    listPrice: {
      standardContext: [
        {
          inputUsdPerMillion: 2,
          outputUsdPerMillion: 10,
          source: "opencode-zen-glm",
          effectiveFrom: "2026-01-01",
        },
      ],
    },
    enabled: true,
    fallbackOnly: true,
  },
  {
    modelLabel: "model:opencode-deepseek-v4-pro",
    provider: "opencode",
    cli: "opencode",
    cliModel: "deepseek-v4-pro",
    role: "capable",
    tier: "capable",
    routeTiers: ["capable", "hard", "frontier"],
    frontier: false,
    taskClasses: ["capable", "hard", "implementation", "refactor"],
    contextWindow: STANDARD_CONTEXT_TOKENS,
    largeContext: false,
    capacityPool: "opencode-zen",
    fallbacks: ["model:claude-opus-4.8"],
    listPrice: {
      standardContext: [
        {
          inputUsdPerMillion: 3,
          outputUsdPerMillion: 15,
          source: "opencode-zen-deepseek-pro",
          effectiveFrom: "2026-01-01",
        },
      ],
    },
    enabled: true,
    fallbackOnly: true,
  },
  {
    modelLabel: "model:opencode-kimi-k2.7-code",
    provider: "opencode",
    cli: "opencode",
    cliModel: "kimi-k2.7-code",
    role: "capable",
    tier: "capable",
    routeTiers: ["capable", "hard"],
    frontier: false,
    taskClasses: ["capable", "hard", "implementation", "refactor"],
    contextWindow: STANDARD_CONTEXT_TOKENS,
    largeContext: false,
    capacityPool: "opencode-zen",
    fallbacks: ["model:claude-opus-4.8"],
    listPrice: {
      standardContext: [
        {
          inputUsdPerMillion: 2.5,
          outputUsdPerMillion: 12.5,
          source: "opencode-zen-kimi",
          effectiveFrom: "2026-01-01",
        },
      ],
    },
    enabled: true,
    fallbackOnly: true,
  },
  {
    modelLabel: "model:opencode-kimi-k3",
    provider: "opencode",
    cli: "opencode",
    cliModel: "kimi-k3",
    role: "frontier-reserve",
    tier: "frontier",
    routeTiers: ["frontier", "ultra-frontier"],
    frontier: true,
    taskClasses: ["frontier", "complex", "deep-reasoning"],
    contextWindow: STANDARD_CONTEXT_TOKENS,
    largeContext: false,
    capacityPool: "opencode-zen",
    fallbacks: ["model:claude-opus-4.8"],
    listPrice: {
      standardContext: [
        {
          inputUsdPerMillion: 5,
          outputUsdPerMillion: 25,
          source: "opencode-zen-kimi-k3",
          effectiveFrom: "2026-01-01",
        },
      ],
    },
    enabled: true,
    fallbackOnly: true,
  },
  {
    modelLabel: "model:opencode-qwen-3.7-max",
    provider: "opencode",
    cli: "opencode",
    cliModel: "qwen-3.7-max",
    role: "ultra-frontier-reserve",
    tier: "ultra-frontier",
    routeTiers: ["ultra-frontier"],
    frontier: true,
    taskClasses: ["ultra-frontier", "explicit-reserve"],
    contextWindow: STANDARD_CONTEXT_TOKENS,
    largeContext: false,
    capacityPool: "opencode-zen",
    fallbacks: ["model:claude-fable-5"],
    listPrice: {
      standardContext: [
        {
          inputUsdPerMillion: 8,
          outputUsdPerMillion: 40,
          source: "opencode-zen-qwen",
          effectiveFrom: "2026-01-01",
        },
      ],
    },
    enabled: true,
    fallbackOnly: true,
  },
  // Free OpenCode Zen models (last-resort only, never paid fallback)
  {
    modelLabel: "model:opencode-deepseek-v4-flash-free",
    provider: "opencode",
    cli: "opencode",
    cliModel: "deepseek-v4-flash-free",
    role: "tiny",
    tier: "tiny",
    routeTiers: ["tiny", "cheap", "standard"],
    frontier: false,
    taskClasses: ["free-model-last-resort"],
    contextWindow: STANDARD_CONTEXT_TOKENS,
    largeContext: false,
    capacityPool: "opencode-zen-free",
    fallbacks: ["model:claude-haiku-4.5"],
    listPrice: {
      standardContext: [
        {
          inputUsdPerMillion: 0,
          outputUsdPerMillion: 0,
          source: "opencode-zen-free",
          effectiveFrom: "2026-01-01",
        },
      ],
    },
    enabled: true,
    fallbackOnly: true,
  },
  {
    modelLabel: "model:opencode-mimo-v2.5-free",
    provider: "opencode",
    cli: "opencode",
    cliModel: "mimo-v2.5-free",
    role: "standard",
    tier: "standard",
    routeTiers: ["tiny", "cheap", "standard", "capable"],
    frontier: false,
    taskClasses: ["free-model-last-resort"],
    contextWindow: STANDARD_CONTEXT_TOKENS,
    largeContext: false,
    capacityPool: "opencode-zen-free",
    fallbacks: ["model:claude-sonnet-5"],
    listPrice: {
      standardContext: [
        {
          inputUsdPerMillion: 0,
          outputUsdPerMillion: 0,
          source: "opencode-zen-free",
          effectiveFrom: "2026-01-01",
        },
      ],
    },
    enabled: true,
    fallbackOnly: true,
  },
  {
    modelLabel: "model:opencode-north-mini-code-free",
    provider: "opencode",
    cli: "opencode",
    cliModel: "north-mini-code-free",
    role: "capable",
    tier: "capable",
    routeTiers: ["capable", "hard"],
    frontier: false,
    taskClasses: ["free-model-last-resort"],
    contextWindow: STANDARD_CONTEXT_TOKENS,
    largeContext: false,
    capacityPool: "opencode-zen-free",
    fallbacks: ["model:claude-sonnet-5"],
    listPrice: {
      standardContext: [
        {
          inputUsdPerMillion: 0,
          outputUsdPerMillion: 0,
          source: "opencode-zen-free",
          effectiveFrom: "2026-01-01",
        },
      ],
    },
    enabled: true,
    fallbackOnly: true,
  },
];

export function effectiveModelPrice(
  model: ModelEntry,
  at: Date = new Date(),
): ModelPrice {
  const day = at.toISOString().slice(0, 10);
  const active = model.listPrice.standardContext
    .filter((price) => price.effectiveFrom <= day)
    .filter((price) => price.effectiveUntil === undefined || day <= price.effectiveUntil)
    .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
  return active ?? model.listPrice.standardContext[0]!;
}

/**
 * Effort multiplies tokens consumed, so it scales the burn estimate. Within a single
 * routing decision every candidate shares one effort, so this factor cancels out of the
 * ranking — it is retained because the score is also persisted as telemetry, where a
 * low-effort and an xhigh attempt must not look equally expensive.
 */
const EFFORT_BURN_MULTIPLIER: Record<string, number> = {
  "effort:low": 1,
  "effort:medium": 1.6,
  "effort:high": 2.5,
  "effort:xhigh": 4,
  "effort:max": 5,
  "effort:ultra": 6,
};

/** Coding agents emit far fewer output than input tokens, but output is priced ~5-6x. */
const OUTPUT_TOKEN_WEIGHT = 2;

/**
 * Relative cost of running one attempt on this model, in list-price units.
 *
 * Under flat subscriptions the dollar figure is not what is actually spent — but price
 * tracks how fast a model consumes a provider's rolling usage window, and *that* is the
 * scarce resource (exhausting a window can lock the pool out for days). So this doubles
 * as the headroom-burn proxy, which is why routing minimizes it rather than treating it
 * as a billing estimate. It is never reported as money: see `telemetry.ts` for the
 * strictly separated billed / list-price-equivalent / subscription measures.
 */
export function modelExpectedCostScore(
  model: ModelEntry,
  effortLabel: string,
  at: Date = new Date(),
): number {
  const price = effectiveModelPrice(model, at);
  return (
    (price.inputUsdPerMillion + price.outputUsdPerMillion * OUTPUT_TOKEN_WEIGHT) *
    (EFFORT_BURN_MULTIPLIER[effortLabel] ?? EFFORT_BURN_MULTIPLIER["effort:medium"]!)
  );
}

/** Whether this model is a valid selection for `tier`. The registry is the only authority. */
export function servesRoute(model: ModelEntry, tier: ModelTier): boolean {
  return model.routeTiers.includes(tier);
}

/** Every dispatchable model that serves `tier`, in registry order. */
export function modelsForRoute(tier: ModelTier): ModelEntry[] {
  return dispatchableModels().filter((model) => servesRoute(model, tier));
}

export const LIVE_DISPATCH_CLIS = ["codex", "claude", "opencode"] as const;

export function isLiveDispatchCli(cli: string): boolean {
  return (LIVE_DISPATCH_CLIS as readonly string[]).includes(cli);
}

export function isDispatchable(model: ModelEntry): boolean {
  return model.enabled && isLiveDispatchCli(model.cli);
}

export function isFallbackOnly(model: ModelEntry): boolean {
  return model.fallbackOnly === true;
}

/** Models eligible for normal issue pickup and routing (excludes fallback-only). */
export function dispatchableModels(): ModelEntry[] {
  return MODELS.filter(isDispatchable).filter((m) => !isFallbackOnly(m));
}

/** All enabled dispatchable models, including fallback-only (for exhaustion fallback). */
export function allDispatchableModels(): ModelEntry[] {
  return MODELS.filter(isDispatchable);
}

export function modelByLabel(modelLabel: string): ModelEntry | null {
  return MODELS.find((model) => model.modelLabel === modelLabel) ?? null;
}

export function modelByCliModel(cliModel: string): ModelEntry | null {
  return MODELS.find((model) => model.cliModel === cliModel) ?? null;
}
