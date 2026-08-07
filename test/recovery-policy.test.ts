import test from "node:test";
import assert from "node:assert/strict";
import {
  attemptFingerprint,
  decideRecovery,
  phaseReachedFrontier,
  phaseRungModel,
  recoveryState,
  updateRecovery,
} from "../src/recovery-policy.ts";

test("recovery retries the assigned model, then escalates once, then exhausts (legacy)", () => {
  let ledger = {};
  const d1 = decideRecovery(ledger, "merge", 2);
  assert.equal(d1.action, "retry");
  assert.equal(d1.attempt, 1);
  ledger = updateRecovery(ledger, "merge", { attempts: 1 });

  const d2 = decideRecovery(ledger, "merge", 2);
  assert.equal(d2.action, "retry");
  assert.equal(d2.attempt, 2);
  ledger = updateRecovery(ledger, "merge", { attempts: 2 });

  const d3 = decideRecovery(ledger, "merge", 2);
  assert.equal(d3.action, "escalate");
  ledger = updateRecovery(ledger, "merge", { escalated: true });

  const d4 = decideRecovery(ledger, "merge", 2);
  assert.equal(d4.action, "exhausted");
});

test("recovery budgets are independent by delivery phase", () => {
  const ledger = updateRecovery({}, "ci", { attempts: 2, escalated: true });
  const ciState = recoveryState(ledger, "ci");
  assert.equal(ciState.attempts, 2);
  assert.equal(ciState.escalated, true);

  const deployState = recoveryState(ledger, "deploy");
  assert.equal(deployState.attempts, 0);
  assert.equal(deployState.escalated, false);

  assert.equal(decideRecovery(ledger, "deploy", 2).action, "retry");
});

test("recovery keeps climbing until the current phase reaches frontier", () => {
  let ledger = updateRecovery({}, "agent", { attempts: 2, escalated: true });

  const sonnetFailure = decideRecovery(
    ledger,
    "agent",
    2,
    "implementation-failure",
    { frontierReached: false },
  );
  assert.equal(sonnetFailure.action, "escalate");

  ledger = updateRecovery(ledger, "agent", {
    rung: {
      modelLabel: "model:claude-sonnet-5",
      cliModel: "claude-sonnet-5",
      effortLabel: "effort:high",
      reason: "escalate one tier",
      at: 1,
    },
  });
  assert.equal(ledger.agent!.ladder!.length, 1);
  assert.equal(ledger.agent!.rung!.modelLabel, "model:claude-sonnet-5");

  const frontierFailure = decideRecovery(
    ledger,
    "agent",
    2,
    "implementation-failure",
    { frontierReached: true },
  );
  assert.equal(frontierFailure.action, "exhausted");
});

// This is the invariant that used to live in planNextAttempt's exhaustion check: a
// frontier model borrowed to repair the CI phase must not make the deploy phase's FIRST
// ordinary repair a frontier attempt. It is enforced here, by reading each phase's own
// recorded rung instead of the run's last-used model, which is what lets the ladder
// terminate at frontier without permanently promoting the whole issue.
test("a frontier rung in one phase leaves the next phase's repairs on the assigned model", () => {
  // CI climbed all the way to Opus; the run's cliModel is now Opus for everyone.
  const ledger = updateRecovery({}, "ci", {
    attempts: 2,
    escalated: true,
    rung: {
      modelLabel: "model:claude-opus-4.8",
      cliModel: "claude-opus-4-8",
      effortLabel: "effort:max",
      reason: "final frontier attempt",
      at: 1,
    },
  });

  // The CI phase is frontier-complete and exhausts.
  assert.equal(phaseReachedFrontier(ledger, "ci", "claude-opus-4-8"), true);
  assert.equal(phaseRungModel(ledger, "ci", "claude-opus-4-8")?.cliModel, "claude-opus-4-8");

  // Deploy has its own untouched budget and must start from the assigned model, even
  // though the run's cliModel is the borrowed frontier one.
  assert.equal(phaseReachedFrontier(ledger, "deploy", "claude-haiku-4-5-20251001"), false);
  assert.equal(
    phaseRungModel(ledger, "deploy", "claude-haiku-4-5-20251001")?.cliModel,
    "claude-haiku-4-5-20251001",
  );
  assert.equal(decideRecovery(ledger, "deploy", 2, "test-failure", { frontierReached: false }).action, "retry");
});

// Records written before rungs existed carry only the boolean flag. Granting them a
// ladder retroactively would restart escalation for runs that already exhausted it.
test("a legacy escalated record with no rung is still treated as frontier-complete", () => {
  const legacy = updateRecovery({}, "agent", { attempts: 2, escalated: true });
  assert.equal(phaseReachedFrontier(legacy, "agent", "claude-haiku-4-5-20251001"), true);
  assert.equal(decideRecovery(legacy, "agent", 2, "implementation-failure").action, "exhausted");
});

test("transient failure: retry same model without escalating", () => {
  const ledger = {};
  const decision = decideRecovery(ledger, "agent", 3, "transient");
  assert.equal(decision.action, "retry");
  assert.equal(decision.attempt, 1);
  assert(decision.reason.includes("Transient"));
});

test("transient failure: escalates after retries exhausted", () => {
  let ledger = updateRecovery({}, "agent", { attempts: 3 });
  const decision = decideRecovery(ledger, "agent", 3, "transient");
  assert.equal(decision.action, "escalate");
  assert(decision.reason.includes("Transient"));
});

test("usage-limit: hand off to available capacity without retrying", () => {
  const ledger = {};
  const decision = decideRecovery(ledger, "agent", 3, "usage-limit");
  assert.equal(decision.action, "escalate");
  assert(decision.reason.includes("capacity"));
});

test("context-exhaustion: escalate to larger context model", () => {
  const ledger = {};
  const decision = decideRecovery(ledger, "agent", 3, "context-exhaustion");
  assert.equal(decision.action, "escalate");
  assert(decision.reason.includes("Context"));
});

test("test-failure: retry once then escalate", () => {
  let ledger = {};
  const d1 = decideRecovery(ledger, "ci", 2, "test-failure");
  assert.equal(d1.action, "retry");
  assert.equal(d1.attempt, 1);

  ledger = updateRecovery(ledger, "ci", { attempts: 2 });
  const d2 = decideRecovery(ledger, "ci", 2, "test-failure");
  assert.equal(d2.action, "escalate");
  assert(d2.reason.includes("Deterministic test"));
});

test("implementation-failure: retry once then escalate", () => {
  let ledger = {};
  const d1 = decideRecovery(ledger, "agent", 2, "implementation-failure");
  assert.equal(d1.action, "retry");

  ledger = updateRecovery(ledger, "agent", { attempts: 2 });
  const d2 = decideRecovery(ledger, "agent", 2, "implementation-failure");
  assert.equal(d2.action, "escalate");
  assert(d2.reason.includes("Implementation"));
});

test("requirements-block: hold without retry or escalate", () => {
  const ledger = {};
  const decision = decideRecovery(ledger, "ci", 3, "requirements-block");
  assert.equal(decision.action, "hold");
  assert(decision.reason.includes("Requirements"));
});

test("human-intervention: hold without retry or escalate", () => {
  const ledger = {};
  const decision = decideRecovery(ledger, "deploy", 3, "human-intervention");
  assert.equal(decision.action, "hold");
  assert(decision.reason.toLowerCase().includes("explicit") || decision.reason.toLowerCase().includes("human"));
});

test("unknown: park and recheck without spending budget", () => {
  const ledger = {};
  const decision = decideRecovery(ledger, "agent", 3, "unknown");
  assert.equal(decision.action, "unknown");
  assert(decision.reason.includes("park"));
});

// #84: on issue #82 the same failure was re-attempted three times against an unchanged
// head. Identical inputs cannot produce a different result, so a repeat must advance the
// ladder rather than spend the remaining allowance on provably redundant work.
test("no-progress guard: an unchanged commit + reason does not spend another attempt", () => {
  const reason = "PR #83 merge is blocked.";
  const fingerprint = attemptFingerprint("abc123", reason);

  let ledger = updateRecovery({}, "merge", { attempts: 1, lastFingerprint: fingerprint });
  const repeated = decideRecovery(ledger, "merge", 2, undefined, {
    frontierReached: false,
    fingerprint,
  });
  assert.equal(repeated.action, "escalate");
  assert(repeated.reason.includes("no change"));

  // A genuinely new failure against the same budget still gets its ordinary retry.
  const moved = decideRecovery(ledger, "merge", 2, undefined, {
    frontierReached: false,
    fingerprint: attemptFingerprint("def456", reason),
  });
  assert.equal(moved.action, "retry");
  assert.equal(moved.attempt, 2);

  // A repeat after the frontier rung is exhaustion, not another escalation.
  ledger = updateRecovery(ledger, "merge", { escalated: true });
  const afterFrontier = decideRecovery(ledger, "merge", 2, undefined, {
    frontierReached: true,
    fingerprint,
  });
  assert.equal(afterFrontier.action, "exhausted");
});

test("no-progress guard: a run that committed nothing twice is still a repeat", () => {
  const reason = "CI is failing.";
  const fingerprint = attemptFingerprint(null, reason);
  const ledger = updateRecovery({}, "ci", { attempts: 1, lastFingerprint: fingerprint });
  const decision = decideRecovery(ledger, "ci", 3, "test-failure", {
    frontierReached: false,
    fingerprint,
  });
  assert.equal(decision.action, "escalate");
});

test("no-progress guard: callers passing no fingerprint keep attempt-count behavior", () => {
  const ledger = updateRecovery({}, "ci", {
    attempts: 1,
    lastFingerprint: attemptFingerprint("abc123", "CI is failing."),
  });
  const decision = decideRecovery(ledger, "ci", 3, "transient", { frontierReached: false });
  assert.equal(decision.action, "retry");
  assert.equal(decision.attempt, 2);
});

test("no-progress guard: the previous attempt's identity survives an unrelated patch", () => {
  const fingerprint = attemptFingerprint("abc123", "CI is failing.");
  let ledger = updateRecovery({}, "ci", { attempts: 1, lastFingerprint: fingerprint });
  ledger = updateRecovery(ledger, "ci", { escalated: false });
  assert.equal(recoveryState(ledger, "ci").lastFingerprint, fingerprint);
});

// #87: `updateRecovery` spreads `recoveryState` before applying its patch, so any field
// that function drops is erased by every patch that does not restate it. `rung` decides
// whether a phase already made its frontier attempt, and `ladder` is the launch-order
// record the progressive climb (#81) depends on.
test("a rung survives a later patch that does not restate it", () => {
  let ledger = updateRecovery({}, "ci", {
    attempts: 1,
    rung: {
      modelLabel: "model:claude-sonnet-5",
      cliModel: "claude-sonnet-5",
      effortLabel: "effort:high",
      reason: "escalate one tier",
      at: 1,
    },
  });

  ledger = updateRecovery(ledger, "ci", { attempts: 2 });
  assert.equal(ledger.ci!.rung!.cliModel, "claude-sonnet-5");
  assert.equal(phaseRungModel(ledger, "ci", "claude-haiku-4-5-20251001")?.cliModel, "claude-sonnet-5");
});

test("the ladder accumulates one entry per rung, in launch order", () => {
  let ledger = updateRecovery({}, "agent", {
    attempts: 1,
    rung: {
      modelLabel: "model:claude-haiku-4.5",
      cliModel: "claude-haiku-4-5-20251001",
      effortLabel: "effort:medium",
      reason: "assigned model",
      at: 1,
    },
  });
  ledger = updateRecovery(ledger, "agent", {
    rung: {
      modelLabel: "model:claude-sonnet-5",
      cliModel: "claude-sonnet-5",
      effortLabel: "effort:high",
      reason: "escalate one tier",
      at: 2,
    },
  });
  ledger = updateRecovery(ledger, "agent", {
    rung: {
      modelLabel: "model:claude-opus-4.8",
      cliModel: "claude-opus-4-8",
      effortLabel: "effort:max",
      reason: "final frontier attempt",
      at: 3,
    },
  });

  assert.deepEqual(
    ledger.agent!.ladder!.map((rung) => rung.cliModel),
    ["claude-haiku-4-5-20251001", "claude-sonnet-5", "claude-opus-4-8"],
  );
  // The frontier rung is now the current one, so this phase is genuinely exhausted.
  assert.equal(phaseReachedFrontier(ledger, "agent", "claude-haiku-4-5-20251001"), true);
});

test("a phase that has not reached frontier is not marked frontier-complete by an unrelated patch", () => {
  let ledger = updateRecovery({}, "deploy", {
    attempts: 1,
    rung: {
      modelLabel: "model:claude-haiku-4.5",
      cliModel: "claude-haiku-4-5-20251001",
      effortLabel: "effort:medium",
      reason: "assigned model",
      at: 1,
    },
  });
  ledger = updateRecovery(ledger, "deploy", { lastFailureCategory: "test-failure" });
  assert.equal(phaseReachedFrontier(ledger, "deploy", "claude-haiku-4-5-20251001"), false);
});
