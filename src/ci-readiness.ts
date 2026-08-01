/**
 * Pure classification of the two GitHub facts autoship must keep separate:
 * mergeability and check-suite existence. An empty check list is not equivalent
 * to a workflow that is still running; keeping that distinction lets the caller
 * give delayed workflow creation a short grace period and repair a durable hole.
 */

export type ChecksState = "pass" | "pending" | "fail" | "unknown";
export type MergeState = "clean" | "behind" | "conflicted" | "unknown";

export interface CiReadinessObservation {
  checks: ChecksState;
  checkCount: number | null;
  mergeState: MergeState;
}

export type CiReadiness =
  | { kind: "ready"; reason: "checks-passed" }
  | { kind: "pending"; reason: "checks-running" | "workflow-delayed" }
  | { kind: "repair"; reason: "checks-missing" | "checks-failing" | "merge-conflict" | "stale-base" }
  | { kind: "unknown"; reason: string };

export function classifyCiReadiness(observation: CiReadinessObservation): CiReadiness {
  if (observation.mergeState === "conflicted") {
    return { kind: "repair", reason: "merge-conflict" };
  }
  if (observation.mergeState === "behind") {
    return { kind: "repair", reason: "stale-base" };
  }
  if (observation.mergeState === "unknown") {
    return { kind: "unknown", reason: "PR mergeability could not be read" };
  }

  if (observation.checkCount === 0) {
    return { kind: "repair", reason: "checks-missing" };
  }
  switch (observation.checks) {
    case "pass":
      return { kind: "ready", reason: "checks-passed" };
    case "pending":
      return { kind: "pending", reason: "checks-running" };
    case "fail":
      return { kind: "repair", reason: "checks-failing" };
    case "unknown":
      return { kind: "unknown", reason: "CI state could not be read" };
  }
}

/** A missing suite is allowed one observation for GitHub to create delayed workflows. */
export function classifyMissingChecksAfterGrace(
  observation: CiReadinessObservation,
  firstObservedAt: number | null,
  now: number,
  graceMs: number,
): CiReadiness {
  const result = classifyCiReadiness(observation);
  if (result.kind !== "repair" || result.reason !== "checks-missing") return result;
  if (firstObservedAt === null || now - firstObservedAt < Math.max(0, graceMs)) {
    return { kind: "pending", reason: "workflow-delayed" };
  }
  return result;
}
