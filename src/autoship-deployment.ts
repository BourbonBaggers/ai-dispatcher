import type { ExecResult } from "./exec.ts";

export type AutoshipHealthState = "pass" | "fail" | "unknown";

export type AutoshipShipState =
  | "merge_succeeded_deployment_not_attempted"
  | "deployment_failed_rollback_succeeded"
  | "deployment_failed_rollback_failed"
  | "deployment_state_unknown"
  | "shipped";

const SHIP_STATES: readonly AutoshipShipState[] = [
  "merge_succeeded_deployment_not_attempted",
  "deployment_failed_rollback_succeeded",
  "deployment_failed_rollback_failed",
  "deployment_state_unknown",
  "shipped",
];

const HEALTH_STATES: readonly AutoshipHealthState[] = ["pass", "fail", "unknown"];

export interface AutoshipShaContext {
  prHeadSha: string;
  baseSha: string;
}

export interface DeploymentCheckoutSnapshot {
  path: string;
  branch: string | null;
  headSha: string | null;
  staged: readonly string[];
  tracked: readonly string[];
  untracked: readonly string[];
  inProgressOperation: "merge" | "rebase" | "cherry-pick" | null;
}

export interface DeploymentRecoveryPolicy {
  deploymentCheckoutPath: string;
  recoveryAttempts: number;
  maxRecoveryAttempts: number;
}

export type DeploymentCheckoutDecision =
  | { action: "use"; snapshot: DeploymentCheckoutSnapshot }
  | { action: "recreate"; snapshot: DeploymentCheckoutSnapshot; reasons: string[] }
  | { action: "blocked"; snapshot: DeploymentCheckoutSnapshot; reasons: string[] };

export interface AutoshipStatusReport {
  state: AutoshipShipState;
  health: AutoshipHealthState;
  prHeadSha: string | null;
  mergedSha: string | null;
  deployedSha: string | null;
  rollbackSha: string | null;
  lastKnownGoodSha: string | null;
  deploymentCheckoutPath: string | null;
}

export interface ClassifiedShipResult {
  state: AutoshipShipState;
  health: AutoshipHealthState;
  detail: string;
  report: AutoshipStatusReport | null;
}

export function dirtyDeploymentReasons(snapshot: DeploymentCheckoutSnapshot): string[] {
  const reasons: string[] = [];
  if (snapshot.staged.length > 0) reasons.push(`staged changes: ${snapshot.staged.join(", ")}`);
  if (snapshot.tracked.length > 0) reasons.push(`tracked changes: ${snapshot.tracked.join(", ")}`);
  if (snapshot.untracked.length > 0) reasons.push(`untracked changes: ${snapshot.untracked.join(", ")}`);
  if (snapshot.inProgressOperation) reasons.push(`${snapshot.inProgressOperation} in progress`);
  return reasons;
}

export function decideDeploymentCheckout(
  snapshot: DeploymentCheckoutSnapshot,
  policy: DeploymentRecoveryPolicy,
): DeploymentCheckoutDecision {
  const reasons = dirtyDeploymentReasons(snapshot);
  if (reasons.length === 0) return { action: "use", snapshot };

  if (snapshot.path !== policy.deploymentCheckoutPath) {
    return {
      action: "blocked",
      snapshot,
      reasons: [
        "dirty checkout is not the configured deployment checkout",
        ...reasons,
      ],
    };
  }

  if (policy.recoveryAttempts >= policy.maxRecoveryAttempts) {
    return {
      action: "blocked",
      snapshot,
      reasons: ["deployment checkout recovery budget exhausted", ...reasons],
    };
  }

  return { action: "recreate", snapshot, reasons };
}

export function parseAutoshipStatusReport(output: string): AutoshipStatusReport | null {
  const line = output
    .split(/\r?\n/)
    .find((candidate) => candidate.startsWith("::autoship:: "));
  if (!line) return null;

  const fields = new Map<string, string>();
  for (const token of line.slice("::autoship:: ".length).trim().split(/\s+/)) {
    const eq = token.indexOf("=");
    if (eq > 0) fields.set(token.slice(0, eq), token.slice(eq + 1));
  }

  const state = fields.get("state");
  if (!state || !(SHIP_STATES as readonly string[]).includes(state)) return null;

  const health = fields.get("health") ?? "unknown";
  return {
    state: state as AutoshipShipState,
    health: (HEALTH_STATES as readonly string[]).includes(health)
      ? (health as AutoshipHealthState)
      : "unknown",
    prHeadSha: nullableField(fields, "pr_head"),
    mergedSha: nullableField(fields, "merged"),
    deployedSha: nullableField(fields, "deployed"),
    rollbackSha: nullableField(fields, "rollback"),
    lastKnownGoodSha: nullableField(fields, "last_good"),
    deploymentCheckoutPath: nullableField(fields, "checkout"),
  };
}

/**
 * Compatibility with internal-tools' deployed ship contract, which predates the
 * `::autoship::` control line and emits newline-delimited AUTOSHIP_* fields. Parse it
 * explicitly so rollback/unknown states are not flattened into a generic exit failure.
 */
export function parseLegacyAutoshipStatusReport(output: string): AutoshipStatusReport | null {
  const fields = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^(AUTOSHIP_[A-Z_]+)=(.*)$/.exec(line.trim());
    if (match) fields.set(match[1]!, match[2]!);
  }
  const status = fields.get("AUTOSHIP_STATUS");
  if (!status) return null;

  const mapped: Record<string, { state: AutoshipShipState; health: AutoshipHealthState }> = {
    deployed: { state: "shipped", health: "pass" },
    deployment_failed_rollback_verified: {
      state: "deployment_failed_rollback_succeeded",
      health: "pass",
    },
    deployment_failed_rollback_failed: {
      state: "deployment_failed_rollback_failed",
      health: "fail",
    },
    deployment_state_unknown: {
      state: "deployment_state_unknown",
      health: "unknown",
    },
  };
  const classification = mapped[status];
  if (!classification) return null;

  const value = (name: string): string | null => {
    const raw = fields.get(name);
    return raw && raw !== "-" ? raw : null;
  };
  return {
    ...classification,
    prHeadSha: null,
    mergedSha: value("AUTOSHIP_REQUESTED_SHA"),
    deployedSha: value("AUTOSHIP_DEPLOYED_SHA"),
    rollbackSha: value("AUTOSHIP_ROLLBACK_SHA"),
    lastKnownGoodSha: value("AUTOSHIP_LAST_GOOD_SHA"),
    deploymentCheckoutPath: null,
  };
}

export function classifyShipResult(result: ExecResult): ClassifiedShipResult {
  const output = `${result.stdout}\n${result.stderr}`;
  const report =
    parseAutoshipStatusReport(output) ??
    parseLegacyAutoshipStatusReport(output);
  if (report) {
    return {
      state: report.state,
      health: report.health,
      report,
      detail: summarizeShipDetail(result),
    };
  }

  if (result.code === 0) {
    return {
      state: "shipped",
      health: "pass",
      report: null,
      detail: summarizeShipDetail(result),
    };
  }

  return {
    state: "deployment_state_unknown",
    health: "unknown",
    report: null,
    detail: summarizeShipDetail(result) || `exit ${result.code}`,
  };
}

function nullableField(fields: ReadonlyMap<string, string>, name: string): string | null {
  const value = fields.get(name);
  return value && value !== "-" ? value : null;
}

function summarizeShipDetail(result: ExecResult): string {
  return (result.stderr.trim() || result.stdout.trim()).slice(-500);
}
