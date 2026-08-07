/**
 * One recovery policy for every phase the dispatcher owns.
 *
 * A phase may retry with the assigned model a bounded number of times, then gets one
 * frontier-model attempt. Only a failure after that frontier attempt is exhausted.
 * Keeping this decision pure prevents CI, merge, deploy, and agent-exit paths from
 * quietly growing different human-handoff rules again.
 *
 * Each recovery decision is evidence-driven: the failure category determines the action
 * (retry transient, hand off capacity issues, escalate capability gaps, hold on
 * requirements/human decisions) rather than just attempt counts alone.
 */

import type { FailureCategory } from "./failure-classification.ts";
import { modelByCliModel, type ModelEntry } from "./models.ts";

export const RECOVERY_KINDS = ["agent", "ci", "merge", "deploy"] as const;
export type RecoveryKind = (typeof RECOVERY_KINDS)[number];

export interface RecoveryState {
  attempts: number;
  escalated: boolean;
  lastFailureCategory?: FailureCategory | undefined;
  /** The current automatic recovery rung for this phase, not the immutable pickup. */
  rung?: RecoveryRung | undefined;
  /** Every model/effort rung attempted by this phase, in launch order. */
  ladder?: readonly RecoveryRung[] | undefined;
  /**
   * Fingerprint of the last attempt this phase spent: the delivered commit plus the
   * failure it produced. Repeating an attempt against identical inputs cannot produce a
   * different result, so it must not consume budget again — see `decideRecovery`.
   */
  lastFingerprint?: string | undefined;
}

export interface RecoveryRung {
  modelLabel: string;
  cliModel: string;
  effortLabel: string;
  reason: string;
  at: number;
}

export type RecoveryLedger = Partial<Record<RecoveryKind, RecoveryState>>;

export type RecoveryDecision =
  | { action: "retry"; attempt: number; maxAttempts: number; reason: string }
  | { action: "escalate"; reason: string }
  | { action: "hold"; reason: string }
  | { action: "exhausted"; reason: string }
  | { action: "unknown"; reason: string };

export interface RecoveryDecisionOptions {
  /** True when the terminal failure came from the final frontier rung. */
  frontierReached?: boolean;
  /**
   * Identity of the work being retried — the delivered commit plus the failure reason.
   * When it matches the previous attempt for this phase, nothing changed between them
   * and another identical retry is guaranteed to be wasted; the ladder advances instead.
   */
  fingerprint?: string;
}

/**
 * The identity of one repair attempt.
 *
 * `lastCommit` is the run's delivered head: an agent that ran and committed nothing leaves
 * it unchanged. Pairing it with the failure reason is what distinguishes "the agent tried
 * something new and still failed" from "nothing moved" — only the latter is provably
 * redundant.
 */
export function attemptFingerprint(lastCommit: string | null, reason: string): string {
  return `${lastCommit ?? "no-commit"}::${reason}`;
}

export function recoveryState(ledger: RecoveryLedger | undefined, kind: RecoveryKind): RecoveryState {
  const current = ledger?.[kind];
  return {
    attempts: Math.max(0, current?.attempts ?? 0),
    escalated: current?.escalated ?? false,
    lastFailureCategory: current?.lastFailureCategory,
    // Every field below must be carried, because `updateRecovery` spreads this result
    // before applying its patch: anything omitted here is silently erased by any patch
    // that does not restate it. `rung` decides whether a phase has already made its
    // frontier attempt (`phaseReachedFrontier`), and dropping it re-opened escalation for
    // a phase that had already climbed. `ladder` is the launch-order record of every rung
    // this phase tried, and reading it as `undefined` reset it to a single entry on every
    // update. `lastFingerprint` is what makes the no-progress guard durable (#87).
    rung: current?.rung,
    ladder: current?.ladder,
    lastFingerprint: current?.lastFingerprint,
  };
}

export function decideRecovery(
  ledger: RecoveryLedger | undefined,
  kind: RecoveryKind,
  maxAttempts: number,
  failureCategory?: FailureCategory,
  options: RecoveryDecisionOptions = {},
): RecoveryDecision {
  const current = recoveryState(ledger, kind);
  // Legacy callers had only a boolean escalation flag; treating those records as
  // frontier-complete preserves their old terminal behavior. New dispatcher paths
  // pass an explicit false until the current model is actually frontier.
  const frontierReached = options.frontierReached ?? true;

  // A retry is only worth budget if something actually changed. When the delivered commit
  // and the failure are both identical to the previous attempt, the agent relaunched and
  // moved nothing, so an identical relaunch will fail identically. Advance the ladder
  // instead of burning the remaining allowance on provably redundant work. Callers that
  // pass no fingerprint keep the original attempt-count behavior.
  const repeated = options.fingerprint !== undefined && options.fingerprint === current.lastFingerprint;
  const retryAvailable = current.attempts < Math.max(0, maxAttempts) && !repeated;
  const noProgress = (base: string): string =>
    repeated ? `${base}; the previous attempt produced no change` : base;

  // Failure category drives evidence-based recovery decisions
  if (failureCategory) {
    switch (failureCategory) {
      case "transient":
        // Retry transient failures using the same model (doesn't count toward escalation)
        if (retryAvailable) {
          return {
            action: "retry",
            attempt: current.attempts + 1,
            maxAttempts: Math.max(0, maxAttempts),
            reason: "Transient infrastructure failure; retry same model",
          };
        }
        // After exhausting retries on transient failure, escalate capability
        return current.escalated && frontierReached
          ? { action: "exhausted", reason: noProgress("Transient failures persist after escalation") }
          : {
              action: "escalate",
              reason: noProgress("Transient failures continue despite retries; escalate for more capability"),
            };

      case "usage-limit":
      case "context-exhaustion":
        // Hand off to comparable/larger capacity rather than retrying
        return current.escalated && frontierReached
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
        if (retryAvailable) {
          // Try the same model once more before escalating
          return {
            action: "retry",
            attempt: current.attempts + 1,
            maxAttempts: Math.max(0, maxAttempts),
            reason: `${failureCategory === "test-failure" ? "Deterministic test" : "Implementation"} failure; retry same model`,
          };
        }
        return current.escalated && frontierReached
          ? {
              action: "exhausted",
              reason: noProgress(
                `${failureCategory === "test-failure" ? "Test" : "Implementation"} failures persist after escalation`,
              ),
            }
          : {
              action: "escalate",
              reason: noProgress(
                `${failureCategory === "test-failure" ? "Deterministic test" : "Implementation"} failures; escalate capability`,
              ),
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
  if (retryAvailable) {
    return {
      action: "retry",
      attempt: current.attempts + 1,
      maxAttempts: Math.max(0, maxAttempts),
      reason: "Retry available",
    };
  }
  return current.escalated && frontierReached
    ? { action: "exhausted", reason: noProgress("Recovery exhausted") }
    : { action: "escalate", reason: noProgress("Retries exhausted; escalate") };
}

/**
 * The model a phase is currently running on.
 *
 * The run's own `cliModel` is the last model *any* phase used, which bleeds across phase
 * boundaries: a frontier model borrowed to repair CI is still the run's `cliModel` when
 * the deploy phase makes its first ordinary repair. The per-phase `rung` records what
 * *this* phase has climbed to, so callers read it first and fall back to the run only for
 * legacy records written before rungs were tracked.
 */
export function phaseRungModel(
  ledger: RecoveryLedger | undefined,
  kind: RecoveryKind,
  runCliModel: string,
): ModelEntry | null {
  return modelByCliModel(ledger?.[kind]?.rung?.cliModel ?? runCliModel) ?? null;
}

/**
 * Whether this phase has already made its frontier attempt — the one thing that turns a
 * failure into genuine exhaustion rather than another rung to climb.
 *
 * A phase is frontier-complete when its own current rung is a frontier model. Legacy
 * records carry no rung, only the boolean `escalated` flag from when escalation was a
 * single jump; for those, `escalated` alone still means frontier-complete, preserving
 * their original terminal behaviour rather than granting them a ladder they never had.
 */
export function phaseReachedFrontier(
  ledger: RecoveryLedger | undefined,
  kind: RecoveryKind,
  runCliModel: string,
): boolean {
  const phase = ledger?.[kind];
  if (phase?.rung) return modelByCliModel(phase.rung.cliModel)?.frontier ?? false;
  if (modelByCliModel(runCliModel)?.frontier) return true;
  return phase?.escalated ?? false;
}

export function updateRecovery(
  ledger: RecoveryLedger | undefined,
  kind: RecoveryKind,
  patch: Partial<RecoveryState>,
): RecoveryLedger {
  const previous = recoveryState(ledger, kind);
  const nextRung = patch.rung;
  const ladder = nextRung
    ? [...(previous.ladder ?? []), nextRung]
    : previous.ladder;
  return {
    ...(ledger ?? {}),
    [kind]: { ...previous, ...patch, ...(ladder ? { ladder } : {}) },
  };
}
