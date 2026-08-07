/**
 * One recovery policy for every phase the dispatcher owns.
 *
 * A phase may retry with the assigned model a bounded number of times, then climb through
 * a model ladder (same provider, ascending tiers) before getting one frontier-model attempt.
 * Only a failure after the frontier attempt is exhausted leads to human handoff.
 * Keeping this decision pure prevents CI, merge, deploy, and agent-exit paths from
 * quietly growing different human-handoff rules again.
 *
 * Each recovery decision is evidence-driven: the failure category determines the action
 * (retry transient, hand off capacity issues, escalate capability gaps, hold on
 * requirements/human decisions) rather than just attempt counts alone.
 */

import type { FailureCategory } from "./failure-classification.ts";
import type { ModelLadder, ModelEntry } from "./models.ts";
import { nextModelInLadder } from "./models.ts";

export const RECOVERY_KINDS = ["agent", "ci", "merge", "deploy"] as const;
export type RecoveryKind = (typeof RECOVERY_KINDS)[number];

export interface RecoveryState {
  attempts: number;
  escalated: boolean;
  lastFailureCategory?: FailureCategory | undefined;
  /**
   * The model ladder for this recovery phase (non-frontier models in ascending tier order).
   * Used to climb through models before frontier escalation.
   * Not serialized in durable state; reconstructed when needed.
   */
  ladder?: readonly ModelEntry[] | undefined;
  /**
   * Current position in the ladder (0-based index).
   * 0 = starting/assigned model, increases with each ladder escalation.
   * Not serialized; reconstructed from current model.
   */
  ladderIndex?: number | undefined;
}

export type RecoveryLedger = Partial<Record<RecoveryKind, RecoveryState>>;

export type RecoveryDecision =
  | { action: "retry"; attempt: number; maxAttempts: number; reason: string; nextModel?: ModelEntry | null }
  | { action: "escalate"; reason: string; nextModel?: ModelEntry | null }
  | { action: "hold"; reason: string }
  | { action: "exhausted"; reason: string }
  | { action: "unknown"; reason: string };

export function recoveryState(ledger: RecoveryLedger | undefined, kind: RecoveryKind): RecoveryState {
  const current = ledger?.[kind];
  return {
    attempts: Math.max(0, current?.attempts ?? 0),
    escalated: current?.escalated ?? false,
    lastFailureCategory: current?.lastFailureCategory,
    ladder: current?.ladder,
    ladderIndex: current?.ladderIndex,
  };
}

/**
 * Determine if we should stay with the same model or climb the ladder.
 * Returns true if we should proceed with a ladder rung (next model), false to escalate to frontier.
 * When a ladder is provided, we climb before frontier escalation.
 */
function shouldClimbLadder(current: RecoveryState): boolean {
  if (!current.ladder || current.ladder.length === 0) {
    return false;
  }
  const currentIndex = current.ladderIndex ?? 0;
  // Can climb if there's a next rung above current position
  return currentIndex + 1 < current.ladder.length;
}

export function decideRecovery(
  ledger: RecoveryLedger | undefined,
  kind: RecoveryKind,
  maxAttempts: number,
  failureCategory?: FailureCategory,
): RecoveryDecision {
  const current = recoveryState(ledger, kind);

  // Failure category drives evidence-based recovery decisions
  if (failureCategory) {
    switch (failureCategory) {
      case "transient":
        // Retry transient failures using the same model (doesn't count toward escalation)
        if (current.attempts < Math.max(0, maxAttempts)) {
          return {
            action: "retry",
            attempt: current.attempts + 1,
            maxAttempts: Math.max(0, maxAttempts),
            reason: "Transient infrastructure failure; retry same model",
          };
        }
        // After exhausting retries, climb ladder if available, then escalate
        if (shouldClimbLadder(current) && current.ladder) {
          const nextModel = nextModelInLadder(
            current.ladder[(current.ladderIndex ?? 0)]!,
            current.ladder,
          );
          return {
            action: "escalate",
            reason: `Transient failures continue despite retries; climb to ${nextModel?.modelLabel ?? "next rung"}`,
            nextModel,
          };
        }
        return current.escalated
          ? { action: "exhausted", reason: "Transient failures persist after escalation" }
          : {
              action: "escalate",
              reason: "Transient failures continue despite retries; escalate for more capability",
            };

      case "usage-limit":
      case "context-exhaustion":
        // Hand off to comparable/larger capacity rather than retrying
        if (shouldClimbLadder(current) && current.ladder) {
          const nextModel = nextModelInLadder(
            current.ladder[(current.ladderIndex ?? 0)]!,
            current.ladder,
          );
          return {
            action: "escalate",
            reason: `${failureCategory === "context-exhaustion" ? "Context window" : "Provider capacity"} exhausted; climb to ${nextModel?.modelLabel ?? "next rung"}`,
            nextModel,
          };
        }
        return current.escalated
          ? {
              action: "exhausted",
              reason: `${failureCategory === "context-exhaustion" ? "Context" : "Capacity"} exhaustion persists after escalation`,
            }
          : {
              action: "escalate",
              reason: `${failureCategory === "context-exhaustion" ? "Context window" : "Provider capacity"} exhausted; hand off to available capacity`,
            };

      case "implementation-failure":
      case "test-failure":
        // Deterministic failures need capability escalation, not retries
        if (current.attempts < Math.max(0, maxAttempts)) {
          // Try the same model once more before escalating
          return {
            action: "retry",
            attempt: current.attempts + 1,
            maxAttempts: Math.max(0, maxAttempts),
            reason: `${failureCategory === "test-failure" ? "Deterministic test" : "Implementation"} failure; retry same model`,
          };
        }
        // Retries exhausted; climb ladder if available
        if (shouldClimbLadder(current) && current.ladder) {
          const nextModel = nextModelInLadder(
            current.ladder[(current.ladderIndex ?? 0)]!,
            current.ladder,
          );
          return {
            action: "escalate",
            reason: `${failureCategory === "test-failure" ? "Deterministic test" : "Implementation"} failures; climb to ${nextModel?.modelLabel ?? "next rung"}`,
            nextModel,
          };
        }
        return current.escalated
          ? {
              action: "exhausted",
              reason: `${failureCategory === "test-failure" ? "Test" : "Implementation"} failures persist after escalation`,
            }
          : {
              action: "escalate",
              reason: `${failureCategory === "test-failure" ? "Deterministic test" : "Implementation"} failures; escalate capability`,
            };

      case "requirements-block":
      case "human-intervention":
        // These require explicit operator decision, not automated recovery
        return {
          action: "hold",
          reason: `${failureCategory === "requirements-block" ? "Requirements" : "Explicit"} block requires human intervention`,
        };

      case "unknown":
        // Unknown state: park and recheck without spending budget
        return {
          action: "unknown",
          reason: "Insufficient evidence to classify failure; park and recheck",
        };
    }
  }

  // Fallback: legacy behavior when no category is provided
  if (current.attempts < Math.max(0, maxAttempts)) {
    return {
      action: "retry",
      attempt: current.attempts + 1,
      maxAttempts: Math.max(0, maxAttempts),
      reason: "Retry available",
    };
  }
  // Retries exhausted; climb ladder if available
  if (shouldClimbLadder(current) && current.ladder) {
    const nextModel = nextModelInLadder(
      current.ladder[(current.ladderIndex ?? 0)]!,
      current.ladder,
    );
    return {
      action: "escalate",
      reason: `Retries exhausted; climb to ${nextModel?.modelLabel ?? "next rung"}`,
      nextModel,
    };
  }
  return current.escalated
    ? { action: "exhausted", reason: "Recovery exhausted" }
    : { action: "escalate", reason: "Retries exhausted; escalate" };
}

export function updateRecovery(
  ledger: RecoveryLedger | undefined,
  kind: RecoveryKind,
  patch: Partial<RecoveryState>,
): RecoveryLedger {
  const current = recoveryState(ledger, kind);
  return {
    ...(ledger ?? {}),
    [kind]: { ...current, ...patch },
  };
}
