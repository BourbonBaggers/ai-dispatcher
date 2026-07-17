import { test } from "node:test";
import assert from "node:assert/strict";
import {
  recordTerminalRunOutcome,
  getBlockingIssueDeferrals,
  type IssueFailureRecord,
  type TerminalRunLike,
} from "../src/failure-policy.ts";

const NOW = 1_000_000_000_000;

function failedRun(overrides: Partial<TerminalRunLike> = {}): TerminalRunLike {
  return {
    issueNumber: 42,
    agent: "codex",
    status: "failed",
    exitCode: 1,
    failureSummary: "npm test failed: 3 tests red",
    lastCommit: null,
    prUrl: null,
    ...overrides,
  };
}

test("three identical failures defers the issue and notifies once", () => {
  let records: IssueFailureRecord[] = [];
  let notifications = 0;

  for (let i = 1; i <= 3; i++) {
    const out = recordTerminalRunOutcome(records, failedRun(), NOW + i * 1000);
    records = out.records;
    if (out.notification) notifications++;
    if (i < 3) assert.equal(out.deferred, false, `attempt ${i} should not defer`);
    else assert.equal(out.deferred, true, "third failure defers");
  }
  assert.equal(notifications, 1);

  const blocking = getBlockingIssueDeferrals(records, NOW + 4000);
  assert.ok(blocking.has(42));
  assert.match(blocking.get(42)!, /deferred after 3 matching failures/);
});

test("a fourth failure inside the window does not re-notify", () => {
  let records: IssueFailureRecord[] = [];
  for (let i = 1; i <= 3; i++) {
    records = recordTerminalRunOutcome(records, failedRun(), NOW + i).records;
  }
  const fourth = recordTerminalRunOutcome(records, failedRun(), NOW + 10);
  assert.equal(fourth.notification, null);
});

test("a differing failure signature restarts the counter", () => {
  let records = recordTerminalRunOutcome([], failedRun(), NOW).records;
  records = recordTerminalRunOutcome(records, failedRun(), NOW + 1).records;
  // different summary → different signature → count resets to 1
  const out = recordTerminalRunOutcome(
    records,
    failedRun({ failureSummary: "totally different error" }),
    NOW + 2,
  );
  const rec = out.records.find((r) => r.issueNumber === 42)!;
  assert.equal(rec.consecutiveFailures, 1);
  assert.equal(out.deferred, false);
});

test("a succeeded run resolves and clears the deferral", () => {
  let records: IssueFailureRecord[] = [];
  for (let i = 1; i <= 3; i++) {
    records = recordTerminalRunOutcome(records, failedRun(), NOW + i).records;
  }
  const success = recordTerminalRunOutcome(
    records,
    failedRun({ status: "succeeded" }),
    NOW + 10,
  );
  const blocking = getBlockingIssueDeferrals(success.records, NOW + 11);
  assert.equal(blocking.has(42), false);
});

test("a failed run that produced a commit does not count against the issue", () => {
  const out = recordTerminalRunOutcome([], failedRun({ lastCommit: "abc123" }), NOW);
  assert.equal(out.deferred, false);
  assert.equal(out.records.length, 0);
});

test("non-terminal-failure statuses are ignored", () => {
  for (const status of ["interrupted", "timed_out", "token_exhausted", "abandoned"]) {
    const out = recordTerminalRunOutcome([], failedRun({ status }), NOW);
    assert.equal(out.records.length, 0, `${status} must not record a failure`);
  }
});

test("deferral stops blocking after the retry time passes", () => {
  let records: IssueFailureRecord[] = [];
  for (let i = 1; i <= 3; i++) {
    records = recordTerminalRunOutcome(records, failedRun(), NOW + i).records;
  }
  const later = NOW + 86_400_000 + 5000; // just past the 24h window
  assert.equal(getBlockingIssueDeferrals(records, later).has(42), false);
});
