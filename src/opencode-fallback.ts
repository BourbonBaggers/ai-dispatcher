/**
 * OpenCode Zen fallback routing and model selection (#56).
 *
 * Selects models for quota-exhaustion fallback when both Codex and Claude are confirmed
 * exhausted for the same window. This is pure decision logic; the dispatcher owns durable
 * state recording and capacity assessment.
 */

import type { ModelEntry, ModelTier } from "./models.ts";
import { modelByLabel, allDispatchableModels, isFallbackOnly } from "./models.ts";
import type { CapacityAssessment } from "./capacity.ts";
import { isModelCapacityExhausted } from "./capacity.ts";
import type { ExhaustionState, OpenCodeZenBalance, QuotaWindow } from "./exhaustion-state.ts";
import {
  areBothPrimaryProvidersExhausted,
  canAttemptFreeModelLastResort,
  hasOpenCodePaidBalance,
} from "./exhaustion-state.ts";

/**
 * Deterministic OpenCode model selection table per issue spec (#56).
 * Models are ordered by preference within each route tier.
 */
export const OPENCODE_MODEL_SELECTION_TABLE: Record<ModelTier, readonly string[]> = {
  tiny: [
    "model:opencode-deepseek-v4-flash",
    "model:opencode-minimax-m3",
    "model:opencode-grok-build-0.1",
  ],
  cheap: [
    "model:opencode-deepseek-v4-flash",
    "model:opencode-minimax-m3",
    "model:opencode-grok-build-0.1",
  ],
  standard: [
    "model:opencode-minimax-m3",
    "model:opencode-grok-build-0.1",
    "model:opencode-deepseek-v4-flash",
  ],
  capable: ["model:opencode-glm-5.2", "model:opencode-deepseek-v4-pro", "model:opencode-kimi-k2.7-code"],
  hard: ["model:opencode-glm-5.2", "model:opencode-deepseek-v4-pro", "model:opencode-kimi-k2.7-code"],
  frontier: ["model:opencode-deepseek-v4-pro", "model:opencode-glm-5.2", "model:opencode-kimi-k3"],
  "ultra-frontier": ["model:opencode-kimi-k3", "model:opencode-qwen-3.7-max", "model:opencode-deepseek-v4-pro"],
};

/**
 * Free-model last-resort candidates in priority order.
 * Only attempted after paid Zen balance is exhausted.
 */
export const OPENCODE_FREE_MODEL_LAST_RESORT_ORDER: readonly string[] = [
  "model:opencode-deepseek-v4-flash-free",
  "model:opencode-mimo-v2.5-free",
  "model:opencode-north-mini-code-free",
];

export interface OpenCodeFallbackDecision {
  /** The selected OpenCode model, or null if none available. */
  selected: ModelEntry | null;
  /** Why the model was selected or not. */
  reason: string;
  /** The trigger window that caused exhaustion (5-hour/weekly/monthly). */
  triggerWindow: QuotaWindow;
  /** True if this is a paid Zen attempt, false for free-model last resort. */
  isPaidAttempt: boolean;
}

/**
 * Selects the best available OpenCode model for the given route tier.
 *
 * Returns the first eligible candidate from the preference table, or null if none are
 * available. Filters out disabled models, those that lack capacity, and any that have
 * already failed in the current fallback sequence.
 */
function determineBestOpenCodeModel(
  routeTier: ModelTier,
  capacityByPool: Map<string, CapacityAssessment>,
  models: readonly ModelEntry[],
  failedModelsInSequence: Set<string> = new Set(),
): ModelEntry | null {
  const candidates = OPENCODE_MODEL_SELECTION_TABLE[routeTier] ?? [];

  for (const modelLabel of candidates) {
    const model = models.find((m) => m.modelLabel === modelLabel);
    if (!model) continue;

    // Skip disabled or non-OpenCode models
    if (!model.enabled || model.provider !== "opencode") continue;

    // Skip if already failed in this sequence
    if (failedModelsInSequence.has(modelLabel)) continue;

    // Skip if capacity is exhausted
    const capacity = capacityByPool.get(model.capacityPool);
    if (capacity && isModelCapacityExhausted(capacity, modelLabel)) continue;

    return model;
  }

  return null;
}

/**
 * Plans an OpenCode Zen fallback attempt when both primary providers are exhausted.
 *
 * Checks all preconditions (both exhausted for the same window, Zen balance available)
 * and selects the best available model from the deterministic table. Returns null if
 * OpenCode cannot be used.
 */
export function planOpenCodeFallback(
  exhaustionState: ExhaustionState,
  zenBalance: OpenCodeZenBalance,
  routeTier: ModelTier,
  capacityByPool: Map<string, CapacityAssessment>,
  models: readonly ModelEntry[] = allDispatchableModels(),
  options: { failedModelsInSequence?: Set<string>; now?: Date } = {},
): OpenCodeFallbackDecision | null {
  const failedModels = options.failedModelsInSequence ?? new Set();
  const now = options.now ?? new Date();

  // Try windows in preference order: 5-hour → weekly → monthly
  const windows: QuotaWindow[] = ["5-hour", "weekly", "monthly"];
  let selectedWindow: QuotaWindow | null = null;

  for (const window of windows) {
    if (areBothPrimaryProvidersExhausted(exhaustionState, window)) {
      selectedWindow = window;
      break;
    }
  }

  if (!selectedWindow) {
    return null;
  }

  // Paid fallback: at least one primary provider exhausted with paid balance available
  if (hasOpenCodePaidBalance(zenBalance)) {
    const model = determineBestOpenCodeModel(routeTier, capacityByPool, models, failedModels);
    if (model) {
      return {
        selected: model,
        reason: `selected ${model.modelLabel} from exhaustion fallback (${selectedWindow} window)`,
        triggerWindow: selectedWindow,
        isPaidAttempt: true,
      };
    }
    return {
      selected: null,
      reason: `no OpenCode model available for ${routeTier} tier fallback (${selectedWindow} window)`,
      triggerWindow: selectedWindow,
      isPaidAttempt: true,
    };
  }

  // Free-model last resort: both exhausted for monthly window, paid balance exhausted, free balance available
  const bothExhaustedForMonthly = areBothPrimaryProvidersExhausted(exhaustionState, "monthly");
  if (canAttemptFreeModelLastResort(zenBalance, bothExhaustedForMonthly, now)) {
    // Find the first available free model
    for (const modelLabel of OPENCODE_FREE_MODEL_LAST_RESORT_ORDER) {
      const model = models.find((m) => m.modelLabel === modelLabel);
      if (!model) continue;

      if (!model.enabled || model.provider !== "opencode") continue;

      if (failedModels.has(modelLabel)) continue;

      const capacity = capacityByPool.get(model.capacityPool);
      if (capacity && isModelCapacityExhausted(capacity, modelLabel)) continue;

      return {
        selected: model,
        reason: `selected ${model.modelLabel} as free-model last resort (monthly window)`,
        triggerWindow: "monthly",
        isPaidAttempt: false,
      };
    }

    return {
      selected: null,
      reason: "no free OpenCode model available as last resort (monthly window)",
      triggerWindow: "monthly",
      isPaidAttempt: false,
    };
  }

  return null;
}
