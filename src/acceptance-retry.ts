/**
 * Bounded retries for the post-ship acceptance audit (#98).
 *
 * The audit is advisory, so "try again later" was its whole failure policy — and with no
 * memory of earlier attempts, "later" meant the next scan, forever. Two production audits
 * looped for hours that way: one PR's diff exceeded GitHub's 300-file limit and could never
 * be read, and another re-bought a judge verdict every pass because filing its follow-up
 * failed identically each time. At a 60-second scan interval that is a model call a minute
 * for work that cannot succeed.
 *
 * So every audit carries a durable attempt count and next-attempt time:
 *  - a failed attempt backs off (5 min, 30 min, 2 h, then daily), so the sweep makes at most
 *    one attempt per audit per window, whatever the scan interval is;
 *  - the sixth failure, or a follow-up creation that fails the same way twice, is terminal:
 *    `unavailable` with the reason, never retried. Giving up costs only the audit's finding.
 *    Delivery never waited on it, and nothing here may hold, page, or spend recovery budget.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

export const AUDIT_MAX_ATTEMPTS = 6;

/** Wait after the 1st, 2nd, 3rd, ... failed attempt. The last entry repeats. */
export const AUDIT_RETRY_DELAYS_MS: readonly number[] = [
  5 * MINUTE_MS,
  30 * MINUTE_MS,
  2 * HOUR_MS,
  24 * HOUR_MS,
];

const LONGEST_RETRY_DELAY_MS = Math.max(...AUDIT_RETRY_DELAYS_MS);

/**
 * An audit's durable bookkeeping on its run record. `pending` is set when a run ships;
 * `done` and `unavailable` are both final, and only `pending` is ever swept.
 */
export interface AuditState {
  status: "pending" | "done" | "unavailable";
  /** The follow-up this audit filed, if any — the primary dedupe record. */
  followUpIssue?: number;
  /** When the audit was queued (pending) or resolved (done/unavailable). */
  at?: number;
  /** Attempts that ended without resolving the audit. Absent on records before #98. */
  attempts?: number;
  /** The sweep must not try again before this time. Absent means due now. */
  nextAttemptAt?: number;
  /** Why the latest attempt failed or, once `unavailable`, why the audit gave up. */
  reason?: string;
  /** Normalized error of the latest follow-up creation failure; a repeat is permanent. */
  failureSignature?: string;
}

export interface AuditFailure {
  reason: string;
  /**
   * Set only where an identical failure on consecutive attempts proves the failure is
   * deterministic (follow-up creation). Absent means "counts toward the cap only".
   */
  signature?: string;
}

/** The wait after `attempts` consecutive failed attempts. */
export function auditRetryDelayMs(attempts: number): number {
  const index = Math.min(Math.max(1, attempts), AUDIT_RETRY_DELAYS_MS.length) - 1;
  return AUDIT_RETRY_DELAYS_MS[index]!;
}

/**
 * Whether the sweep may attempt this audit now. A legacy pending record has no next time
 * and is due at once. A next time further out than any delay this policy produces can only
 * come from a clock that has since moved backwards; it is due rather than stranded.
 */
export function auditDue(audit: AuditState | undefined, nowMs: number): boolean {
  if (audit?.status !== "pending") return false;
  const next = audit.nextAttemptAt;
  if (next === undefined) return true;
  return nowMs >= next || next - nowMs > LONGEST_RETRY_DELAY_MS;
}

/**
 * The record after an attempt that could not resolve the audit: pending with the next
 * backoff, or terminal `unavailable` once the cap is reached or a signed failure repeats.
 */
export function auditAfterFailure(
  previous: AuditState | undefined,
  failure: AuditFailure,
  nowMs: number,
): AuditState {
  const attempts = Math.max(0, previous?.attempts ?? 0) + 1;

  if (failure.signature !== undefined && failure.signature === previous?.failureSignature) {
    return {
      status: "unavailable",
      at: nowMs,
      attempts,
      reason: `failed the same way twice: ${failure.reason}`,
    };
  }
  if (attempts >= AUDIT_MAX_ATTEMPTS) {
    return {
      status: "unavailable",
      at: nowMs,
      attempts,
      reason: `gave up after ${attempts} attempts: ${failure.reason}`,
    };
  }
  return {
    status: "pending",
    at: previous?.at ?? nowMs,
    attempts,
    nextAttemptAt: nowMs + auditRetryDelayMs(attempts),
    reason: failure.reason,
    // Only the latest failure is compared, so "the same way twice" means consecutively.
    ...(failure.signature === undefined ? {} : { failureSignature: failure.signature }),
  };
}

/**
 * Failures that say nothing about the request itself. Two of these in a row mean GitHub was
 * unhealthy twice, not that the request can never succeed, so they never count as "the same
 * way" — the cap still bounds them.
 */
const TRANSIENT_GITHUB_ERROR =
  /rate limit|abuse detection|timed? ?out|timeout|HTTP 5\d\d|bad gateway|service unavailable|connection (?:reset|refused)|\bEOF\b|could not resolve host|no such host|network is unreachable|temporarily/i;

/**
 * What makes two follow-up creation failures "the same": gh's error text, normalized. A
 * missing label or a rejected field fails identically every time; an empty or transient
 * error has no signature and can never make an audit terminal early.
 */
export function creationFailureSignature(error: string): string | undefined {
  const normalized = error.replace(/\s+/g, " ").trim().toLowerCase().slice(0, 300);
  if (normalized === "" || TRANSIENT_GITHUB_ERROR.test(normalized)) return undefined;
  return normalized;
}
