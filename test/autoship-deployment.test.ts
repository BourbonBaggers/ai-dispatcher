import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyShipResult,
  decideDeploymentCheckout,
  dirtyDeploymentReasons,
  parseAutoshipStatusReport,
  type DeploymentCheckoutSnapshot,
} from "../src/autoship-deployment.ts";

const cleanSnapshot: DeploymentCheckoutSnapshot = {
  path: "/deploy/acme-widgets",
  branch: "main",
  headSha: "abc123",
  staged: [],
  tracked: [],
  untracked: [],
  inProgressOperation: null,
};

describe("deployment checkout decisions", () => {
  it("uses a clean deployment checkout", () => {
    assert.deepEqual(
      decideDeploymentCheckout(cleanSnapshot, {
        deploymentCheckoutPath: "/deploy/acme-widgets",
        recoveryAttempts: 0,
        maxRecoveryAttempts: 1,
      }),
      { action: "use", snapshot: cleanSnapshot },
    );
  });

  it("allows bounded recreation only for the configured deployment checkout", () => {
    const dirty = { ...cleanSnapshot, tracked: ["src/app.ts"] };
    const decision = decideDeploymentCheckout(dirty, {
      deploymentCheckoutPath: "/deploy/acme-widgets",
      recoveryAttempts: 0,
      maxRecoveryAttempts: 1,
    });
    assert.equal(decision.action, "recreate");
    assert.match(decision.reasons[0]!, /tracked changes/);
  });

  it("blocks dirty non-deployment checkouts so agent work is never discarded", () => {
    const dirty = { ...cleanSnapshot, path: "/agents/issue-6", staged: ["src/app.ts"] };
    const decision = decideDeploymentCheckout(dirty, {
      deploymentCheckoutPath: "/deploy/acme-widgets",
      recoveryAttempts: 0,
      maxRecoveryAttempts: 1,
    });
    assert.equal(decision.action, "blocked");
    assert.match(decision.reasons.join("\n"), /not the configured deployment checkout/);
  });

  it("blocks when deployment checkout recovery is exhausted", () => {
    const dirty = { ...cleanSnapshot, untracked: ["tmp.log"] };
    const decision = decideDeploymentCheckout(dirty, {
      deploymentCheckoutPath: "/deploy/acme-widgets",
      recoveryAttempts: 1,
      maxRecoveryAttempts: 1,
    });
    assert.equal(decision.action, "blocked");
    assert.match(decision.reasons.join("\n"), /budget exhausted/);
  });

  it("reports merge/rebase/cherry-pick state as dirty", () => {
    assert.deepEqual(
      dirtyDeploymentReasons({ ...cleanSnapshot, inProgressOperation: "merge" }),
      ["merge in progress"],
    );
  });
});

describe("autoship status report parsing", () => {
  it("parses the ship command control line", () => {
    const report = parseAutoshipStatusReport(
      "log\n::autoship:: state=deployment_failed_rollback_succeeded health=pass pr_head=h merged=m deployed=- rollback=g last_good=g checkout=/deploy/repo\n",
    );
    assert.deepEqual(report, {
      state: "deployment_failed_rollback_succeeded",
      health: "pass",
      prHeadSha: "h",
      mergedSha: "m",
      deployedSha: null,
      rollbackSha: "g",
      lastKnownGoodSha: "g",
      deploymentCheckoutPath: "/deploy/repo",
    });
  });

  it("rejects unknown states", () => {
    assert.equal(parseAutoshipStatusReport("::autoship:: state=rolled_back health=pass"), null);
  });
});

describe("ship result classification", () => {
  it("honors explicit rollback success only when the ship command reports it", () => {
    const result = classifyShipResult({
      ok: false,
      code: 1,
      stdout: "::autoship:: state=deployment_failed_rollback_succeeded health=pass rollback=good\n",
      stderr: "deploy failed",
    });
    assert.equal(result.state, "deployment_failed_rollback_succeeded");
    assert.equal(result.health, "pass");
  });

  it("treats a non-zero exit without a report as unknown production state", () => {
    const result = classifyShipResult({
      ok: false,
      code: 1,
      stdout: "",
      stderr: "checkout failed",
    });
    assert.equal(result.state, "deployment_state_unknown");
    assert.equal(result.health, "unknown");
  });

  it("keeps legacy zero-exit ship commands compatible", () => {
    const result = classifyShipResult({ ok: true, code: 0, stdout: "ok", stderr: "" });
    assert.equal(result.state, "shipped");
    assert.equal(result.health, "pass");
  });
});
