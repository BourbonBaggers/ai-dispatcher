/**
 * Capacity-awareness adapter (#319).
 *
 * The PRD is emphatic: "The system must not pretend capacity information is precise when
 * the provider does not expose it." Neither the Claude Code CLI nor the Codex CLI exposes
 * a remaining-quota number, so this module never fabricates one. It reports the *best
 * available signal* on the PRD's descending confidence ladder and is honest — usually
 * `unknown` — about the rest.
 *
 * Confidence ladder (descending preference of signal source):
 *   1. provider-reported  — provider's own remaining/reset numbers  (not exposed today)
 *   2. cli-reported       — CLI limit-state / account status         (not exposed today)
 *   3. persisted-limit    — a persisted cooldown with a provider-reported (authoritative) reset
 *   4. unconfirmed-limit  — a persisted cooldown from an unconfirmed, no-reset signal (#32)
 *   5. estimated          — a local estimate from observed dispatch history
 *   6. unknown            — no signal at all
 *
 * `persisted-limit` vs. `unconfirmed-limit` matters for honesty (#32 requirement 11): an
 * unconfirmed no-reset quota-like signal (`token-exhaustion.ts`'s
 * `authoritative: false`) is a self-revalidating guess, not proof the pool is exhausted,
 * so it must never be reported at the same confidence as a provider-reported reset. The
 * two live signals besides those are `estimated` (from observed usage). Levels 1–2 exist
 * in the type so a future adapter can return them without a schema change.
 *
 * This module is pure: routing (`routing.ts`) consumes the assessments to prefer dormant
 * capacity, and the dispatcher supplies the cooldown/usage facts. No IO here.
 */

/** Descending preference of signal source. Index 0 is the strongest signal. */
export const CAPACITY_CONFIDENCE = [
  "provider-reported",
  "cli-reported",
  "persisted-limit",
  "unconfirmed-limit",
  "estimated",
  "unknown",
] as const;
export type CapacityConfidence = (typeof CAPACITY_CONFIDENCE)[number];

/**
 * What we believe about a pool's ability to accept work. `exhausted` is only ever
 * asserted from hard evidence (an active cooldown); absence of evidence is `unknown`,
 * never an optimistic `available`.
 */
export const CAPACITY_STATE = ["available", "exhausted", "unknown"] as const;
export type CapacityState = (typeof CAPACITY_STATE)[number];

/**
 * A pool is dormant when it is otherwise-idle capacity. Routing prefers dormant pools so
 * scarce, busy subscription capacity is conserved (PRD principle §3). A pool untouched for
 * this long counts as idle.
 */
export const DORMANCY_IDLE_MS = 2 * 60 * 60 * 1000; // 2 hours

/** Observed local usage for a pool, used to estimate confidence and dormancy. */
export interface PoolUsageObservation {
  /** Epoch ms of the most recent dispatch drawing on this pool; null if never/unknown. */
  lastActivityAt: number | null;
  /** In-flight runs currently drawing on this pool. */
  activeRuns: number;
}

export interface CapacityAssessment {
  pool: string;
  state: CapacityState;
  confidence: CapacityConfidence;
  /** Epoch ms when an exhausted pool is expected to recover, or null. */
  resetAt: number | null;
  /** Otherwise-idle capacity: routing prefers this among comparable options. */
  dormant: boolean;
  /** Human-readable explanation for logs and telemetry. */
  reason: string;
}

/**
 * Assesses one capacity pool from the honest signals we actually have.
 *
 * @param pool         capacity pool id (e.g. "claude-subscription")
 * @param cooldownUntil epoch ms a persisted capacity cooldown runs until, or null
 * @param nowMs        current epoch ms
 * @param usage        observed local usage, when available (raises confidence to estimated)
 * @param authoritative whether the cooldown came from a provider-reported reset (default
 *   `true`, preserving prior behavior). `false` means an unconfirmed, self-revalidating
 *   guess (#32) — reported at `unconfirmed-limit`, never conflated with proven exhaustion.
 */
export function assessCapacity(
  pool: string,
  cooldownUntil: number | null,
  nowMs: number,
  usage?: PoolUsageObservation,
  authoritative = true,
): CapacityAssessment {
  // Level 3/4 — a cooldown that is still in the future means the pool is paused. Whether
  // that is proven (persisted-limit) or an unconfirmed guess pending revalidation
  // (unconfirmed-limit) is reported honestly rather than collapsed into one confidence.
  if (cooldownUntil !== null && cooldownUntil > nowMs) {
    return {
      pool,
      state: "exhausted",
      confidence: authoritative ? "persisted-limit" : "unconfirmed-limit",
      resetAt: cooldownUntil,
      dormant: false,
      reason: authoritative
        ? `capacity cooldown active until ${new Date(cooldownUntil).toISOString()}`
        : `unconfirmed capacity signal — revalidating automatically at ${new Date(cooldownUntil).toISOString()}`,
    };
  }

  // Level 5 — estimated. We have observed usage but no provider/CLI capacity number, so we
  // do not claim to know remaining capacity; we only estimate dormancy from activity.
  if (usage) {
    if (usage.activeRuns > 0) {
      return {
        pool,
        state: "unknown",
        confidence: "estimated",
        resetAt: null,
        dormant: false,
        reason: `${usage.activeRuns} run(s) in flight — capacity in use`,
      };
    }
    const idleFor = usage.lastActivityAt === null ? null : nowMs - usage.lastActivityAt;
    const dormant = idleFor === null || idleFor >= DORMANCY_IDLE_MS;
    return {
      pool,
      state: "unknown",
      confidence: "estimated",
      resetAt: null,
      dormant,
      reason:
        usage.lastActivityAt === null
          ? "no observed recent use — treated as dormant"
          : dormant
            ? `idle for ${Math.round(idleFor! / 60000)}m — dormant`
            : `used ${Math.round(idleFor! / 60000)}m ago — active`,
    };
  }

  // Level 6 — unknown. No cooldown and no usage history: we know nothing, and say so.
  // Absence of a cooldown is treated as dormant for routing preference, but the state
  // stays honestly `unknown` rather than a fabricated `available`.
  return {
    pool,
    state: "unknown",
    confidence: "unknown",
    resetAt: null,
    dormant: true,
    reason: "no capacity signal available",
  };
}

/** True when an assessment means "do not route work to this pool right now". */
export function isPoolExhausted(assessment: CapacityAssessment): boolean {
  return assessment.state === "exhausted";
}

/**
 * Assesses several pools at once into a lookup routing consumes.
 *
 * @param pools          the pool ids to assess
 * @param cooldownByPool pool → active-cooldown epoch ms (or null)
 * @param usageByPool    pool → observed usage (optional per pool)
 * @param nowMs          current epoch ms
 * @param authoritativeByPool pool → whether its cooldown is provider-reported (default
 *   `true` when absent for a pool, preserving prior behavior — see `assessCapacity`)
 */
export function assessPools(
  pools: readonly string[],
  cooldownByPool: Map<string, number | null>,
  usageByPool: Map<string, PoolUsageObservation>,
  nowMs: number,
  authoritativeByPool?: Map<string, boolean>,
): Map<string, CapacityAssessment> {
  const out = new Map<string, CapacityAssessment>();
  for (const pool of pools) {
    out.set(
      pool,
      assessCapacity(
        pool,
        cooldownByPool.get(pool) ?? null,
        nowMs,
        usageByPool.get(pool),
        authoritativeByPool?.get(pool) ?? true,
      ),
    );
  }
  return out;
}
