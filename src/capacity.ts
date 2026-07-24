/**
 * Honest provider-capacity normalization.
 *
 * Live provider/CLI windows are preferred when available. Persisted exhaustion evidence
 * remains the fallback when a live read fails; local activity is only a rotation hint,
 * never a fabricated quota estimate.
 */

export const CAPACITY_CONFIDENCE = [
  "provider-reported",
  "cli-reported",
  "persisted-limit",
  "unconfirmed-limit",
  "estimated",
  "unknown",
] as const;
export type CapacityConfidence = (typeof CAPACITY_CONFIDENCE)[number];

export const CAPACITY_STATE = ["available", "exhausted", "unknown"] as const;
export type CapacityState = (typeof CAPACITY_STATE)[number];

export const DORMANCY_IDLE_MS = 2 * 60 * 60 * 1000;

export interface PoolUsageObservation {
  lastActivityAt: number | null;
  activeRuns: number;
}

/** One provider-owned rolling window. Model labels scope model-specific limits. */
export interface CapacityWindow {
  name: string;
  usedPercent: number;
  resetAt: number | null;
  modelLabels?: readonly string[];
}

/** Sanitized output from an IO adapter. Credentials and raw responses never reach here. */
export interface LiveCapacitySnapshot {
  pool: string;
  confidence: "provider-reported" | "cli-reported";
  observedAt: number;
  windows: CapacityWindow[];
  reason: string;
}

export interface CapacityAssessment {
  pool: string;
  state: CapacityState;
  confidence: CapacityConfidence;
  resetAt: number | null;
  dormant: boolean;
  lastActivityAt: number | null;
  observedAt: number | null;
  windows: CapacityWindow[];
  /** Minimum remaining percentage among unscoped provider windows. */
  headroomPercent: number | null;
  reason: string;
}

function validWindow(window: CapacityWindow): boolean {
  return (
    typeof window.name === "string" &&
    window.name.length > 0 &&
    Number.isFinite(window.usedPercent) &&
    window.usedPercent >= 0 &&
    window.usedPercent <= 100 &&
    (window.resetAt === null || (Number.isFinite(window.resetAt) && window.resetAt > 0))
  );
}

function limitingReset(windows: CapacityWindow[]): number | null {
  const limiting = windows
    .filter((window) => window.usedPercent >= 100 && window.resetAt !== null)
    .map((window) => window.resetAt!)
    .sort((a, b) => a - b);
  return limiting[0] ?? null;
}

function minimumHeadroom(windows: CapacityWindow[]): number | null {
  if (windows.length === 0) return null;
  return Math.min(...windows.map((window) => Math.max(0, 100 - window.usedPercent)));
}

/**
 * Builds an assessment using the strongest current evidence. A successful live read
 * precedes an older cooldown: this is how affirmative provider evidence clears a stale
 * no-reset suppression without pretending a failed read proved availability.
 */
export function assessCapacity(
  pool: string,
  cooldownUntil: number | null,
  nowMs: number,
  usage?: PoolUsageObservation,
  authoritative = true,
  live?: LiveCapacitySnapshot,
): CapacityAssessment {
  if (
    live &&
    live.pool === pool &&
    Number.isFinite(live.observedAt) &&
    live.observedAt <= nowMs &&
    live.windows.length > 0 &&
    live.windows.every(validWindow)
  ) {
    const general = live.windows.filter((window) => !window.modelLabels?.length);
    const headroomPercent = minimumHeadroom(general);
    const state =
      headroomPercent === null ? "unknown" : headroomPercent <= 0 ? "exhausted" : "available";
    return {
      pool,
      state,
      confidence: live.confidence,
      resetAt: state === "exhausted" ? limitingReset(general) : null,
      dormant: usage ? usage.activeRuns === 0 : true,
      lastActivityAt: usage?.lastActivityAt ?? null,
      observedAt: live.observedAt,
      windows: live.windows.map((window) => ({ ...window })),
      headroomPercent,
      reason: live.reason,
    };
  }

  if (cooldownUntil !== null && cooldownUntil > nowMs) {
    return {
      pool,
      state: "exhausted",
      confidence: authoritative ? "persisted-limit" : "unconfirmed-limit",
      resetAt: cooldownUntil,
      dormant: false,
      lastActivityAt: usage?.lastActivityAt ?? null,
      observedAt: null,
      windows: [],
      headroomPercent: 0,
      reason: authoritative
        ? `capacity cooldown active until ${new Date(cooldownUntil).toISOString()}`
        : `unconfirmed capacity signal — revalidating automatically at ${new Date(cooldownUntil).toISOString()}`,
    };
  }

  if (usage) {
    if (usage.activeRuns > 0) {
      return {
        pool,
        state: "unknown",
        confidence: "estimated",
        resetAt: null,
        dormant: false,
        lastActivityAt: usage.lastActivityAt,
        observedAt: null,
        windows: [],
        headroomPercent: null,
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
      lastActivityAt: usage.lastActivityAt,
      observedAt: null,
      windows: [],
      headroomPercent: null,
      reason:
        usage.lastActivityAt === null
          ? "no observed recent use — treated as dormant"
          : dormant
            ? `idle for ${Math.round(idleFor! / 60000)}m — dormant`
            : `used ${Math.round(idleFor! / 60000)}m ago — active`,
    };
  }

  return {
    pool,
    state: "unknown",
    confidence: "unknown",
    resetAt: null,
    dormant: true,
    lastActivityAt: null,
    observedAt: null,
    windows: [],
    headroomPercent: null,
    reason: "no capacity signal available",
  };
}

export function capacityHeadroomForModel(
  assessment: CapacityAssessment,
  modelLabel: string,
): number | null {
  if (assessment.windows.length === 0) return assessment.headroomPercent;
  const applicable = assessment.windows.filter(
    (window) => !window.modelLabels?.length || window.modelLabels.includes(modelLabel),
  );
  return minimumHeadroom(applicable);
}

export function isPoolExhausted(assessment: CapacityAssessment): boolean {
  return assessment.state === "exhausted";
}

export function isModelCapacityExhausted(
  assessment: CapacityAssessment,
  modelLabel: string,
): boolean {
  return (
    assessment.state === "exhausted" ||
    capacityHeadroomForModel(assessment, modelLabel) === 0
  );
}

export function assessPools(
  pools: readonly string[],
  cooldownByPool: Map<string, number | null>,
  usageByPool: Map<string, PoolUsageObservation>,
  nowMs: number,
  authoritativeByPool?: Map<string, boolean>,
  liveByPool?: Map<string, LiveCapacitySnapshot>,
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
        liveByPool?.get(pool),
      ),
    );
  }
  return out;
}
