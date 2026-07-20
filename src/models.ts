/**
 * The curated model/provider registry — the authoritative model catalog owned by the
 * standalone dispatcher.
 *
 * The standalone service must remain installable and typecheckable without the
 * `internal-tools` monorepo, so this catalog is self-contained and has no external
 * imports. The embedded dispatcher that once mirrored it under `packages/types` has
 * been removed; this file is now the single authority for the model catalog.
 */

export const MODEL_TIERS = ["fast", "general", "complex", "frontier"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

export function tierRank(tier: ModelTier): number {
  return MODEL_TIERS.indexOf(tier);
}

export const MODEL_ROLES = [
  "fast",
  "general",
  "complex",
  "large-context",
  "planning",
  "frontier-reserve",
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
  enabled: boolean;
}

export const MODELS: readonly ModelEntry[] = [
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
    fallbacks: ["model:gpt-5.5"],
    enabled: true,
  },
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
  {
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
