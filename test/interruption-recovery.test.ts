import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decideResumeCap,
  describeInterruptions,
  interruptionBackoffComment,
  interruptionRetryDelayMs,
  isBackingOff,
  recordInterruption,
  INTERRUPTION_RETRY_DELAYS_MS,
  type InterruptionLedger,
} from "../src/interruption-recovery.ts";

const HOUR = 60 * 60_000;

function launch(attemptNumber: number, cliModel = "claude-sonnet-5") {
  return {
    attemptNumber,
    cliModel,
    reason: "The launcher found unpublished work. Resume this checkout to commit or push it.",
    at: 1_000 * attemptNumber,
  };
}

test("each interrupted launch is counted once, per model, and a replay counts nothing", () => {
  let ledger: InterruptionLedger | undefined;
  for (let attempt = 1; attempt <= 4; attempt += 1) ledger = recordInterruption(ledger, launch(attempt));
  for (let attempt = 5; attempt <= 8; attempt += 1) {
    ledger = recordInterruption(ledger, launch(attempt, "claude-opus-5-5"));
  }
  assert.deepEqual(ledger, {
    count: 8,
    byModel: { "claude-sonnet-5": 4, "claude-opus-5-5": 4 },
    lastAttempt: 8,
    lastReason: "The launcher found unpublished work. Resume this checkout to commit or push it.",
    lastAt: 8_000,
  });
  // A crash between the runner's checkpoint and finalization replays the same attempt.
  assert.equal(recordInterruption(ledger, launch(8, "claude-opus-5-5")), ledger);
  assert.equal(recordInterruption(ledger, launch(3)), ledger);
});

test("recording keeps an existing back-off and bounds the stored reason", () => {
  const backingOff: InterruptionLedger = {
    count: 8,
    byModel: { m: 8 },
    lastAttempt: 8,
    lastReason: "x",
    lastAt: 1,
    stalls: 2,
  };
  const next = recordInterruption(backingOff, { ...launch(9, "m"), reason: "y".repeat(2_000) });
  assert.equal(next.stalls, 2);
  assert.equal(next.lastReason.length, 500);
});

test("the back-off grows 1 h, 4 h, then holds at once a day", () => {
  assert.deepEqual([0, 1, 2, 3, 10].map(interruptionRetryDelayMs), [HOUR, 4 * HOUR, 24 * HOUR, 24 * HOUR, 24 * HOUR]);
  assert.deepEqual(INTERRUPTION_RETRY_DELAYS_MS, [HOUR, 4 * HOUR, 24 * HOUR]);
});

test("an interrupted-out assigned rung escalates once; nothing is charged to a model", () => {
  assert.deepEqual(decideResumeCap({ reachedFrontier: false, ledger: undefined, nowMs: 0 }), {
    action: "escalate",
  });
});

test("an interrupted-out frontier rung backs off instead of holding, longer each round", () => {
  const first = decideResumeCap({ reachedFrontier: true, ledger: undefined, nowMs: 10 });
  assert.deepEqual(first, { action: "back-off", retryAfter: 10 + HOUR, stalls: 1 });

  const ledger: InterruptionLedger = { count: 9, byModel: {}, lastAttempt: 9, lastReason: "", lastAt: 0, stalls: 1 };
  assert.deepEqual(decideResumeCap({ reachedFrontier: true, ledger, nowMs: 10 }), {
    action: "back-off",
    retryAfter: 10 + 4 * HOUR,
    stalls: 2,
  });
});

test("a run waits out its back-off, then retries exactly once", () => {
  const ledger: InterruptionLedger = {
    count: 8,
    byModel: {},
    lastAttempt: 8,
    lastReason: "",
    lastAt: 0,
    stalls: 1,
    retryAfter: 5_000,
  };
  assert.equal(isBackingOff(ledger, 4_999), true);
  assert.deepEqual(decideResumeCap({ reachedFrontier: true, ledger, nowMs: 4_999 }), { action: "wait" });
  assert.equal(isBackingOff(ledger, 5_000), false);
  assert.deepEqual(decideResumeCap({ reachedFrontier: true, ledger, nowMs: 5_000 }), { action: "retry" });
  assert.equal(isBackingOff(undefined, 5_000), false);
});

test("interruptions are described by count and model, never as failures", () => {
  assert.equal(
    describeInterruptions({ count: 8, byModel: { a: 4, b: 4 }, lastAttempt: 8, lastReason: "", lastAt: 0 }),
    "8 times (`a` ×4, `b` ×4)",
  );
  assert.equal(
    describeInterruptions({ count: 1, byModel: {}, lastAttempt: 1, lastReason: "", lastAt: 0 }),
    "1 time",
  );
});

test("the back-off comment says no budget was spent, the issue is not held, and when it retries", () => {
  const comment = interruptionBackoffComment(
    { branch: "issue-773-x" },
    { count: 8, byModel: { "claude-sonnet-5": 4, "claude-opus-5-5": 4 }, lastAttempt: 8, lastReason: "The launcher found unpublished work.", lastAt: 0 },
    Date.UTC(2026, 9, 2, 6, 0, 0),
  );
  assert.match(comment, /^## Dispatcher: agent launches keep being interrupted/);
  assert.match(comment, /interrupted 8 times \(`claude-sonnet-5` ×4, `claude-opus-5-5` ×4\) without returning a result/);
  assert.match(comment, /Last interruption: The launcher found unpublished work\./);
  assert.match(comment, /not model failures: no repair or frontier budget was spent, and this issue is not held/);
  assert.match(comment, /after 2026-10-02T06:00:00\.000Z/);
  assert.doesNotMatch(comment, /exhaust/i);
});
