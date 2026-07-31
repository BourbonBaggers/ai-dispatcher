/**
 * OpenCode Zen telemetry and evidence recording (#56).
 *
 * Records OpenCode-specific attempt metadata including exhaustion evidence, balance
 * state, and fallback sequence information. This is pure data modeling; recording and
 * persistence is the dispatcher's job.
 */

import type { QuotaWindow } from "./exhaustion-state.ts";
import type { ModelPrice } from "./models.ts";

/**
 * OpenCode-specific telemetry for an attempt.
 * Recorded separately from the base AttemptRecord since it only applies to fallback attempts.
 */
export interface OpenCodeAttemptTelemetry {
  /** Provider lane always "opencode-zen" for OpenCode attempts. */
  providerLane: "opencode-zen";
  /** Selected OpenCode model (e.g., "model:opencode-deepseek-v4-pro"). */
  selectedModel: string;
  /** Route tier preserved from original assignment. */
  routeTier: string;
  /** Effort preserved from original assignment. */
  effortLabel: string;
  /** Quota window that triggered exhaustion (5-hour/weekly/monthly). */
  fallbackTriggerWindow: QuotaWindow;
  /** Exhaustion evidence: were both Codex and Claude confirmed exhausted. */
  primaryProvidersExhaustedFor: {
    provider1: "anthropic" | "openai";
    provider2: "anthropic" | "openai";
    window: QuotaWindow;
    bothConfirmed: boolean;
  };
  /** Whether this was a paid Zen attempt (true) or free-model last resort (false). */
  isPaidAttempt: boolean;
  /** If free-model last resort, which free model was attempted. */
  freeModelLastResort?: string | null;
  /** Price snapshot at attempt time for cost tracking. */
  priceSnapshot: ModelPrice | null;
  /** OpenCode Zen balance state at attempt time. */
  zenBalanceAtAttempt: {
    paidBalance: number | null;
    freeMonthlyBalance: number | null;
    source: "cached-config" | "api-queried" | "unavailable";
  };
  /** Provider-reported usage if available. */
  providerReportedUsage: {
    tokensUsed: number | null;
    creditsCost: number | null;
    source: "provider-api" | "unavailable";
  } | null;
  /** Billed amount if available. */
  billedAmount: {
    amount: number;
    currency: string;
  } | null;
  /** Whether this attempt was later succeeded by a different model/provider. */
  wasBypassedByLaterAttempt?: boolean;
}

/**
 * Exhaustion recovery event for logging and analytics.
 * Emitted when the dispatcher determines that OpenCode fallback is eligible.
 */
export interface ExhaustionRecoveryEvent {
  issueNumber: number;
  timestamp: number;
  exhaustionWindow: QuotaWindow;
  primaryProviders: readonly ["anthropic", "openai"];
  fallbackProvider: "opencode";
  selectedModel: string;
  isPaidAttempt: boolean;
  detailedReason: string;
}
