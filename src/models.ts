/**
 * The curated model/provider registry — the authoritative model catalog owned by the
 * standalone dispatcher.
 *
 * The standalone service must remain installable and typecheckable without the
 * `internal-tools` monorepo, so this catalog is self-contained and has no external
 * imports. The embedded dispatcher that once mirrored it under `packages/types` has
 * been removed; this file is now the single authority for the model catalog.
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
  tier: ModelTier;
  frontier: boolean;
  taskClasses: readonly string[];
  contextWindow: number;
  largeContext: boolean;
  capacityPool: string;
  fallbacks: readonly string[];
  listPrice: ModelPriceSchedule;
  enabled: boolean;
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
    frontier: false,
    taskClasses: ["general", "implementation", "large-context", "planning", "refactor"],
    contextWindow: STANDARD_CONTEXT_TOKENS,
    largeContext: true,
    capacityPool: "claude-subscription",
    fallbacks: ["model:claude-opus-4.8"],
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
    fallbacks: ["model:gpt-5.5"],
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
    modelLabel: "model:claude-fable-5",
    provider: "anthropic",
    cli: "claude",
    cliModel: "claude-fable-5",
    role: "ultra-frontier-reserve",
    tier: "ultra-frontier",
    frontier: true,
    taskClasses: ["ultra-frontier", "explicit-reserve"],
    contextWindow: STANDARD_CONTEXT_TOKENS,
    largeContext: false,
    capacityPool: "claude-subscription",
    fallbacks: ["model:claude-opus-4.8"],
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
    modelLabel: "model:gpt-5.4-mini",
    provider: "openai",
    cli: "codex",
    cliModel: "gpt-5.4-mini",
    role: "tiny",
    tier: "tiny",
    frontier: false,
    taskClasses: ["tiny", "cheap", "simple", "small-scope", "low-risk"],
    contextWindow: STANDARD_CONTEXT_TOKENS,
    largeContext: false,
    capacityPool: "codex-subscription",
    fallbacks: ["model:gpt-5.6-luna", "model:claude-haiku-4.5"],
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
    modelLabel: "model:gpt-5.6-luna",
    provider: "openai",
    cli: "codex",
    cliModel: "gpt-5.6-luna",
    role: "standard",
    tier: "standard",
    frontier: false,
    taskClasses: ["standard", "general", "implementation"],
    contextWindow: STANDARD_CONTEXT_TOKENS,
    largeContext: false,
    capacityPool: "codex-subscription",
    fallbacks: ["model:gpt-5.6-terra", "model:claude-haiku-4.5"],
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
    frontier: false,
    taskClasses: ["capable", "hard", "implementation", "refactor", "cross-provider-comparable"],
    contextWindow: STANDARD_CONTEXT_TOKENS,
    largeContext: false,
    capacityPool: "codex-subscription",
    fallbacks: ["model:claude-sonnet-5", "model:gpt-5.6-sol"],
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
    modelLabel: "model:gpt-5.6-sol",
    provider: "openai",
    cli: "codex",
    cliModel: "gpt-5.6-sol",
    role: "frontier-reserve",
    tier: "frontier",
    frontier: true,
    taskClasses: ["frontier", "complex", "deep-reasoning"],
    contextWindow: STANDARD_CONTEXT_TOKENS,
    largeContext: false,
    capacityPool: "codex-subscription",
    fallbacks: ["model:claude-opus-4.8"],
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
    frontier: true,
    taskClasses: ["frontier", "alternate", "implementation"],
    contextWindow: STANDARD_CONTEXT_TOKENS,
    largeContext: false,
    capacityPool: "codex-subscription",
    fallbacks: ["model:gpt-5.6-sol", "model:claude-opus-4.8"],
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
    frontier: false,
    taskClasses: ["general", "large-context", "free-capacity"],
    contextWindow: 1_000_000,
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

export function modelExpectedCostScore(
  model: ModelEntry,
  effortLabel: string,
  at: Date = new Date(),
): number {
  const price = effectiveModelPrice(model, at);
  const effortMultiplier: Record<string, number> = {
    "effort:low": 1,
    "effort:medium": 1.6,
    "effort:high": 2.5,
    "effort:xhigh": 4,
    "effort:max": 5,
    "effort:ultra": 6,
  };
  return (
    price.inputUsdPerMillion +
    price.outputUsdPerMillion * 2
  ) * (effortMultiplier[effortLabel] ?? 1.6);
}

export const LIVE_DISPATCH_CLIS = ["codex", "claude"] as const;

export function isLiveDispatchCli(cli: string): boolean {
  return (LIVE_DISPATCH_CLIS as readonly string[]).includes(cli);
}

export function isDispatchable(model: ModelEntry): boolean {
  return model.enabled && isLiveDispatchCli(model.cli);
}

export function dispatchableModels(): ModelEntry[] {
  return MODELS.filter(isDispatchable);
}

export function modelByLabel(modelLabel: string): ModelEntry | null {
  return MODELS.find((model) => model.modelLabel === modelLabel) ?? null;
}

export function modelByCliModel(cliModel: string): ModelEntry | null {
  return MODELS.find((model) => model.cliModel === cliModel) ?? null;
}
