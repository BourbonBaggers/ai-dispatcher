/**
 * Provider capacity exhaustion tracking and detection (#56).
 *
 * Tracks exhaustion state for Codex and Claude across quota windows (5-hour, weekly,
 * monthly) to determine when OpenCode Zen becomes eligible as a fallback. This is pure
 * decision logic; the dispatcher owns IO and durable state recording.
 */

import type { ProviderCapacitySignal } from "./token-exhaustion.ts";

export const QUOTA_WINDOWS = ["5-hour", "weekly", "monthly"] as const;
export type QuotaWindow = (typeof QUOTA_WINDOWS)[number];

export const PRIMARY_PROVIDERS = ["anthropic", "openai"] as const;
export type PrimaryProvider = (typeof PRIMARY_PROVIDERS)[number];

/**
 * Exhaustion evidence for a single provider at a point in time.
 */
export interface ProviderExhaustionSnapshot {
  provider: PrimaryProvider;
  window: QuotaWindow;
  exhausted: boolean;
  /** ISO timestamp when exhaustion was first detected. */
  detectedAt: string;
  /** The capacity signal that triggered exhaustion classification. */
  signal: ProviderCapacitySignal | null;
  /** Reported reset time if known. */
  resetAt: number | null;
}

/**
 * Tracks which providers are exhausted for which quota windows.
 * Each provider+window combination has at most one entry.
 */
export interface ExhaustionState {
  /** Keyed as `${provider}:${window}` for fast lookup. */
  [key: string]: ProviderExhaustionSnapshot | undefined;
}

/**
 * Computes a state key for a provider+window combination.
 */
export function exhaustionKey(provider: PrimaryProvider, window: QuotaWindow): string {
  return `${provider}:${window}`;
}

/**
 * Records exhaustion for a provider in a specific quota window.
 */
export function recordExhaustion(
  state: ExhaustionState,
  provider: PrimaryProvider,
  window: QuotaWindow,
  signal: ProviderCapacitySignal | null,
  now: Date = new Date(),
): ExhaustionState {
  const key = exhaustionKey(provider, window);
  const existing = state[key];
  // Do not update if already recorded unless the new signal is more authoritative
  if (existing && existing.exhausted && !signal) {
    return state;
  }
  return {
    ...state,
    [key]: {
      provider,
      window,
      exhausted: true,
      detectedAt: now.toISOString(),
      signal,
      resetAt: signal?.resetAt ?? null,
    },
  };
}

/**
 * Clears exhaustion for a provider when the quota window resets or capacity is restored.
 */
export function clearExhaustion(
  state: ExhaustionState,
  provider: PrimaryProvider,
  window: QuotaWindow,
): ExhaustionState {
  const key = exhaustionKey(provider, window);
  const { [key]: _, ...rest } = state;
  return rest;
}

/**
 * Checks if both Codex and Claude are confirmed exhausted for the same window.
 *
 * OpenCode becomes eligible only when both primary providers have no capacity in the
 * same quota window. Unknown or stale exhaustion signals do not count.
 */
export function areBothPrimaryProvidersExhausted(
  state: ExhaustionState,
  window: QuotaWindow,
  now: Date = new Date(),
): boolean {
  const claudeKey = exhaustionKey("anthropic", window);
  const codexKey = exhaustionKey("openai", window);

  const claudeSnapshot = state[claudeKey];
  const codexSnapshot = state[codexKey];

  // Both must be exhausted
  if (!claudeSnapshot?.exhausted || !codexSnapshot?.exhausted) {
    return false;
  }

  // A reset time in the past means exhaustion has cleared
  const now_ms = now.getTime();
  if (claudeSnapshot.resetAt && claudeSnapshot.resetAt < now_ms) {
    return false;
  }
  if (codexSnapshot.resetAt && codexSnapshot.resetAt < now_ms) {
    return false;
  }

  return true;
}

/**
 * Checks if at least one of the primary providers has usable capacity.
 *
 * OpenCode is not used if only one provider is exhausted — the other should be available.
 */
export function hasAvailablePrimaryProvider(
  state: ExhaustionState,
  window: QuotaWindow,
  now: Date = new Date(),
): boolean {
  return !areBothPrimaryProvidersExhausted(state, window, now);
}

/**
 * OpenCode Zen balance state.
 */
export interface OpenCodeZenBalance {
  /** Paid Zen balance available (subscription/top-up tokens remaining). */
  paidBalance: number | null;
  /** Monthly free quota remaining. */
  freeMonthlyBalance: number | null;
  /** When the monthly free quota resets. */
  monthlyResetAt: number | null;
  /** Source of balance information. */
  source: "cached-config" | "api-queried" | "unavailable";
}

/**
 * Checks if OpenCode Zen has available paid balance for a fallback attempt.
 *
 * The dispatcher should not use free models during ordinary paid fallback.
 */
export function hasOpenCodePaidBalance(balance: OpenCodeZenBalance): boolean {
  if (balance.source === "unavailable") return false;
  return balance.paidBalance !== null && balance.paidBalance > 0;
}

/**
 * Checks if OpenCode Zen free-model last resort is available.
 *
 * Free models can only be used after paid balance is exhausted AND both Codex and Claude
 * are exhausted for the monthly window.
 */
export function canAttemptFreeModelLastResort(
  balance: OpenCodeZenBalance,
  bothExhaustedForMonth: boolean,
  now: Date = new Date(),
): boolean {
  if (!bothExhaustedForMonth) return false;
  if (balance.source === "unavailable") return false;
  // Paid balance must be truly exhausted, not just unavailable
  if (balance.paidBalance === null || balance.paidBalance > 0) {
    return false;
  }
  // Monthly free quota must exist and not have reset
  if (balance.freeMonthlyBalance === null || balance.freeMonthlyBalance <= 0) {
    return false;
  }
  // If reset time is in the past, the monthly quota has expired
  if (balance.monthlyResetAt && balance.monthlyResetAt < now.getTime()) {
    return false;
  }
  return true;
}
