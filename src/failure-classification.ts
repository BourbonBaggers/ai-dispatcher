/**
 * Failure classification maps evidence from agent, CI, merge, and deployment phases
 * into specific failure categories. Each category indicates whether the root cause is
 * transient infrastructure, exhausted capacity, capability limits, or defects in the
 * work itself.
 */

/** Failure categories that drive evidence-based recovery decisions. */
export const FAILURE_CATEGORIES = [
  "transient",
  "usage-limit",
  "context-exhaustion",
  "implementation-failure",
  "test-failure",
  "requirements-block",
  "human-intervention",
  "unknown",
] as const;

export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];

export interface FailureClassification {
  category: FailureCategory;
  reason: string;
  evidence?: string;
}

// Agent failure classification

export interface AgentFailureSignals {
  exitCode: number;
  outputContains?: string[];
  sawResult: boolean;
  providerCapacitySignal?: {
    kind: string;
  };
}

export function classifyAgentFailure(signals: AgentFailureSignals): FailureClassification {
  const { exitCode, outputContains = [], sawResult, providerCapacitySignal } = signals;

  if (providerCapacitySignal) {
    if (providerCapacitySignal.kind === "context-exhaustion") {
      return {
        category: "context-exhaustion",
        reason: "Model context window exhausted",
        evidence: "Provider signaled context/token limit exceeded",
      };
    }
    return {
      category: "usage-limit",
      reason: "Provider capacity exhausted",
      evidence: `Provider capacity signal: ${providerCapacitySignal.kind}`,
    };
  }

  if (!sawResult) {
    return {
      category: "transient",
      reason: "Agent process interrupted before reporting result",
      evidence: "No result line received; branch preserved for resume",
    };
  }

  if (exitCode === 0) {
    return {
      category: "implementation-failure",
      reason: "Agent exited cleanly but made no commits",
      evidence: "Exit code 0 with no work committed",
    };
  }

  // Check for dependency/flaky failures (before network so we can distinguish)
  for (const pattern of ["npm err", "dependency", "flaky", "intermittent", "package"]) {
    if (outputContains.some((line) => line.toLowerCase().includes(pattern))) {
      return {
        category: "transient",
        reason: "Dependency or flaky infrastructure failure",
        evidence: `Output contains: ${pattern}`,
      };
    }
  }

  // Check for common transient network/infra failure patterns
  for (const pattern of [
    "network",
    "timeout",
    "connection",
    "unavailable",
    "ECONNREFUSED",
    "ENOTFOUND",
  ]) {
    if (outputContains.some((line) => line.toLowerCase().includes(pattern))) {
      return {
        category: "transient",
        reason: "Network or infrastructure failure detected",
        evidence: `Output contains: ${pattern}`,
      };
    }
  }

  return {
    category: "implementation-failure",
    reason: "Agent failed with non-zero exit",
    evidence: `Exit code ${exitCode}`,
  };
}

// CI failure classification

export interface CiFailureSignals {
  ciState: "pass" | "fail" | "pending" | "none";
  checkConclusionDetails?: string;
  failedChecks?: Array<{
    name: string;
    conclusion?: string;
    summary?: string;
  }>;
}

export function classifyCiFailure(signals: CiFailureSignals): FailureClassification {
  if (signals.ciState === "pending") {
    return {
      category: "unknown",
      reason: "CI still running",
      evidence: "Some checks have not yet completed",
    };
  }

  if (signals.ciState === "pass" || signals.ciState === "none") {
    return {
      category: "unknown",
      reason: "No CI failure to classify",
      evidence: "CI passed or not available",
    };
  }

  const checkDetails = signals.checkConclusionDetails?.toLowerCase() ?? "";
  const failedCheckNames = (signals.failedChecks ?? [])
    .map((c) => c.name?.toLowerCase() ?? "")
    .join(" ");

  // Check for timeout/flaky patterns
  if (
    checkDetails.includes("timeout") ||
    checkDetails.includes("exceeded") ||
    failedCheckNames.includes("timeout")
  ) {
    return {
      category: "transient",
      reason: "CI check timed out",
      evidence: "Check conclusion indicates timeout",
    };
  }

  if (
    checkDetails.includes("flaky") ||
    checkDetails.includes("intermittent") ||
    failedCheckNames.includes("flaky")
  ) {
    return {
      category: "transient",
      reason: "Flaky CI check",
      evidence: "Check identified as flaky",
    };
  }

  // Infrastructure failures
  if (
    checkDetails.includes("runner") ||
    checkDetails.includes("action") ||
    checkDetails.includes("workflow") ||
    failedCheckNames.includes("setup")
  ) {
    return {
      category: "transient",
      reason: "CI infrastructure failure",
      evidence: "Check or runner setup failed",
    };
  }

  // Deterministic test failures are implementation problems
  return {
    category: "test-failure",
    reason: "Deterministic test failure",
    evidence: `Failed checks: ${signals.failedChecks?.map((c) => c.name).join(", ") ?? "unknown"}`,
  };
}

// Merge failure classification

export interface MergeFailureSignals {
  mergeStatus?: "clean" | "conflicted" | "unknown";
  conflictDetails?: string;
  hasConflicts?: boolean;
}

export function classifyMergeFailure(signals: MergeFailureSignals): FailureClassification {
  if (signals.mergeStatus === "clean" || !signals.hasConflicts) {
    return {
      category: "unknown",
      reason: "No merge failure to classify",
      evidence: "Merge is clean or not attempted",
    };
  }

  if (signals.conflictDetails?.toLowerCase().includes("manual")) {
    return {
      category: "human-intervention",
      reason: "Merge conflicts require manual resolution",
      evidence: "Conflicts detected that agent cannot auto-resolve",
    };
  }

  // Most merge conflicts are either infrastructure (transient) or implementation
  if (signals.hasConflicts) {
    return {
      category: "test-failure",
      reason: "Merge conflict in working files",
      evidence: "Conflicted files present in merge",
    };
  }

  return {
    category: "unknown",
    reason: "Merge status unclear",
    evidence: signals.conflictDetails ?? "Unknown merge state",
  };
}

// Deployment failure classification

export interface DeploymentFailureSignals {
  exitCode: number;
  commandOutput?: string;
  deployPhase?: "pre-deploy" | "deploy" | "health-check" | "rollback" | "unknown";
}

export function classifyDeploymentFailure(signals: DeploymentFailureSignals): FailureClassification {
  const { exitCode, commandOutput = "", deployPhase } = signals;

  if (exitCode === 0) {
    return {
      category: "unknown",
      reason: "No deployment failure",
      evidence: "Deploy command exited successfully",
    };
  }

  const output = commandOutput.toLowerCase();

  // Timeout or health-check issues
  if (
    deployPhase === "health-check" ||
    output.includes("timeout") ||
    output.includes("health")
  ) {
    return {
      category: "transient",
      reason: "Deployment health-check or timeout",
      evidence: `Deploy phase: ${deployPhase}, output contains timeout/health indicators`,
    };
  }

  // Infrastructure/environment issues
  if (
    output.includes("cannot connect") ||
    output.includes("connection refused") ||
    output.includes("network") ||
    output.includes("unavailable")
  ) {
    return {
      category: "transient",
      reason: "Deployment infrastructure failure",
      evidence: "Network or environment connectivity issue",
    };
  }

  // Pre-deployment validation failures
  if (deployPhase === "pre-deploy" || output.includes("validation")) {
    return {
      category: "test-failure",
      reason: "Deployment validation failed",
      evidence: "Pre-deployment checks failed",
    };
  }

  // Assume generic deployment failures are transient until proven otherwise
  return {
    category: "transient",
    reason: "Deployment failed",
    evidence: `Exit code ${exitCode} at phase ${deployPhase ?? "unknown"}`,
  };
}
