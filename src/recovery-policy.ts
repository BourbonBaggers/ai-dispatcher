/**
 * One recovery policy for every phase the dispatcher owns.
 *
 * A phase may retry with the assigned model a bounded number of times, then gets one
 * frontier-model attempt. Only a failure after that frontier attempt is exhausted.
 * Keeping this decision pure prevents CI, merge, deploy, and agent-exit paths from
 * quietly growing different human-handoff rules again.
 */

export const RECOVERY_KINDS = ["agent", "ci", "merge", "deploy"] as const;
export type RecoveryKind = (typeof RECOVERY_KINDS)[number];

export interface RecoveryState {
  attempts: number;
  escalated: boolean;
}

export type RecoveryLedger = Partial<Record<RecoveryKind, RecoveryState>>;

export type RecoveryDecision =
  | { action: "retry"; attempt: number; maxAttempts: number }
  | { action: "escalate" }
  | { action: "exhausted" };

export function recoveryState(ledger: RecoveryLedger | undefined, kind: RecoveryKind): RecoveryState {
  const current = ledger?.[kind];
  return {
    attempts: Math.max(0, current?.attempts ?? 0),
    escalated: current?.escalated ?? false,
  };
}

export function decideRecovery(
  ledger: RecoveryLedger | undefined,
  kind: RecoveryKind,
  maxAttempts: number,
): RecoveryDecision {
  const current = recoveryState(ledger, kind);
  if (current.attempts < Math.max(0, maxAttempts)) {
    return {
      action: "retry",
      attempt: current.attempts + 1,
      maxAttempts: Math.max(0, maxAttempts),
    };
  }
  return current.escalated ? { action: "exhausted" } : { action: "escalate" };
}

export function updateRecovery(
  ledger: RecoveryLedger | undefined,
  kind: RecoveryKind,
  patch: Partial<RecoveryState>,
): RecoveryLedger {
  return {
    ...(ledger ?? {}),
    [kind]: { ...recoveryState(ledger, kind), ...patch },
  };
}
