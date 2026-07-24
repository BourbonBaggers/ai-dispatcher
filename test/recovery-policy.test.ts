import test from "node:test";
import assert from "node:assert/strict";
import { decideRecovery, recoveryState, updateRecovery } from "../src/recovery-policy.ts";

test("recovery retries the assigned model, then escalates once, then exhausts", () => {
  let ledger = {};
  assert.deepEqual(decideRecovery(ledger, "merge", 2), {
    action: "retry",
    attempt: 1,
    maxAttempts: 2,
  });
  ledger = updateRecovery(ledger, "merge", { attempts: 1 });
  assert.deepEqual(decideRecovery(ledger, "merge", 2), {
    action: "retry",
    attempt: 2,
    maxAttempts: 2,
  });
  ledger = updateRecovery(ledger, "merge", { attempts: 2 });
  assert.deepEqual(decideRecovery(ledger, "merge", 2), { action: "escalate" });
  ledger = updateRecovery(ledger, "merge", { escalated: true });
  assert.deepEqual(decideRecovery(ledger, "merge", 2), { action: "exhausted" });
});

test("recovery budgets are independent by delivery phase", () => {
  const ledger = updateRecovery({}, "ci", { attempts: 2, escalated: true });
  assert.deepEqual(recoveryState(ledger, "ci"), { attempts: 2, escalated: true });
  assert.deepEqual(recoveryState(ledger, "deploy"), { attempts: 0, escalated: false });
  assert.equal(decideRecovery(ledger, "deploy", 2).action, "retry");
});
