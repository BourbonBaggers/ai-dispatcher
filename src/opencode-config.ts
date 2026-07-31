/**
 * OpenCode Zen configuration and validation (#56).
 *
 * Validates OpenCode credentials, balance configuration, and fallback eligibility.
 * Pure validation logic; credential storage and API communication is the dispatcher's job.
 */

import type { OpenCodeZenBalance } from "./exhaustion-state.ts";

/**
 * OpenCode Zen provider configuration.
 */
export interface OpenCodeZenConfig {
  /** OpenCode API key for Zen access (from OPENCODE_API_KEY or config file). */
  apiKey: string | null;
  /** Whether OpenCode Zen fallback is enabled. */
  fallbackEnabled: boolean;
  /** Maximum fallback attempts per window (prevents infinite loops). */
  maxFallbackAttemptsPerWindow: number;
  /** Cached or fetched balance information. */
  balance: OpenCodeZenBalance;
  /** Last time balance was refreshed, if queried from API. */
  balanceRefreshedAt: number | null;
}

/**
 * Validation result for OpenCode configuration.
 */
export type ConfigValidationResult =
  | { ok: true; value: OpenCodeZenConfig }
  | { ok: false; reason: string };

/**
 * Default balance when configuration is unavailable.
 */
const UNAVAILABLE_BALANCE: OpenCodeZenBalance = {
  paidBalance: null,
  freeMonthlyBalance: null,
  monthlyResetAt: null,
  source: "unavailable",
};

/** Default max fallback attempts per quota window. */
const DEFAULT_MAX_FALLBACK_ATTEMPTS_PER_WINDOW = 3;

/**
 * Validates OpenCode configuration from environment variables and config.
 *
 * Does not fetch live balance data (that's async and the dispatcher's job), but
 * prepares to accept it when available. Configuration without an API key is valid but
 * fallback-disabled.
 */
export function validateOpenCodeConfig(env: Record<string, string | undefined>): ConfigValidationResult {
  const apiKey = env.OPENCODE_API_KEY?.trim() || null;
  const fallbackEnabledStr = env.OPENCODE_FALLBACK_ENABLED?.trim().toLowerCase();
  const fallbackEnabled = fallbackEnabledStr === "true" || fallbackEnabledStr === "1";

  // If fallback is enabled but no API key, that's an error
  if (fallbackEnabled && !apiKey) {
    return {
      ok: false,
      reason:
        "OpenCode Zen fallback is enabled but OPENCODE_API_KEY is missing. Set OPENCODE_API_KEY or disable fallback with OPENCODE_FALLBACK_ENABLED=false.",
    };
  }

  const config: OpenCodeZenConfig = {
    apiKey,
    fallbackEnabled,
    maxFallbackAttemptsPerWindow: DEFAULT_MAX_FALLBACK_ATTEMPTS_PER_WINDOW,
    balance: UNAVAILABLE_BALANCE,
    balanceRefreshedAt: null,
  };

  return { ok: true, value: config };
}

/**
 * Updates balance information in the configuration.
 *
 * Used after the dispatcher queries the OpenCode API for current balance.
 */
export function updateBalance(
  config: OpenCodeZenConfig,
  balance: OpenCodeZenBalance,
  now: Date = new Date(),
): OpenCodeZenConfig {
  return {
    ...config,
    balance,
    balanceRefreshedAt: now.getTime(),
  };
}

/**
 * Checks if OpenCode fallback is usable given current configuration.
 *
 * Fallback is usable when enabled AND credentials are present AND (balance is known or
 * can be queried).
 */
export function isOpenCodeFallbackUsable(config: OpenCodeZenConfig): boolean {
  if (!config.fallbackEnabled) return false;
  if (!config.apiKey) return false;
  // Balance must be known or queriable (source is not "unavailable" after init, or
  // apiKey is present so we can query). For this check, we accept "unavailable" since
  // the dispatcher can fetch it if needed.
  return true;
}

/**
 * Checks if balance information needs refreshing from the API.
 *
 * Balance should be refreshed if:
 * - Never fetched (balanceRefreshedAt is null)
 * - Last fetch was too long ago (default: 5 minutes)
 */
export function shouldRefreshBalance(
  config: OpenCodeZenConfig,
  now: Date = new Date(),
  maxAgeMs: number = 5 * 60 * 1000,
): boolean {
  if (!config.apiKey) return false;
  if (config.balanceRefreshedAt === null) return true;
  return now.getTime() - config.balanceRefreshedAt > maxAgeMs;
}
