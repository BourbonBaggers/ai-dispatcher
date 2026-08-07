import test from "node:test";
import assert from "node:assert/strict";
import { decideRecovery, recoveryState, updateRecovery } from "../src/recovery-policy.ts";
import { modelByLabel, buildModelLadder } from "../src/models.ts";

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

test("recovery state preserves ladder and ladder index", () => {
  const haiku = modelByLabel("model:claude-haiku-4.5")!;
  const ladder = buildModelLadder(haiku);
  let ledger = {};

  ledger = updateRecovery(ledger, "agent", { attempts: 1, ladder, ladderIndex: 0 });
  const state = recoveryState(ledger, "agent");
  assert.equal(state.attempts, 1);
  assert.equal(state.ladder, ladder);
  assert.equal(state.ladderIndex, 0);
});

test("recovery state updates ladder index on escalation", () => {
  const haiku = modelByLabel("model:claude-haiku-4.5")!;
  const sonnet = modelByLabel("model:claude-sonnet-5")!;
  const ladder = buildModelLadder(haiku);
  let ledger = updateRecovery({}, "agent", { attempts: 0, ladder, ladderIndex: 0 });

  // Move to next rung
  ledger = updateRecovery(ledger, "agent", { attempts: 1, ladderIndex: 1 });
  const state = recoveryState(ledger, "agent");
  assert.equal(state.ladderIndex, 1);
  assert.equal(ladder[state.ladderIndex!]!.modelLabel, "model:claude-sonnet-5");
});

test("unknown: park and recheck without spending budget", () => {
  const ledger = {};
  const decision = decideRecovery(ledger, "agent", 3, "unknown");
  assert.equal(decision.action, "unknown");
  assert(decision.reason.includes("park"));
});
