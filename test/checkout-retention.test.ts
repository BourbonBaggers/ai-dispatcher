import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CHECKOUT_DIR_NAME,
  GIB,
  decideCheckout,
  formatBytes,
  formatDuration,
  isDiskLow,
  lowDiskHoldMessage,
  lowPriorityCommand,
  minimumFreeBytes,
  processUseVerdict,
  sweepDue,
  unpushedVerdict,
  type CheckoutRun,
} from "../src/checkout-retention.ts";
import type { DispatcherStatus } from "../src/labels.ts";

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const RETENTION = 3 * DAY;
const NOW = 100 * DAY;

function run(status: DispatcherStatus, overrides: Partial<CheckoutRun> = {}): CheckoutRun {
  return {
    issueNumber: 12,
    status,
    finalizationPending: false,
    createdAt: NOW - 10 * DAY,
    startedAt: NOW - 10 * DAY,
    finishedAt: NOW - 10 * DAY,
    ...overrides,
  };
}

// ── decideCheckout ────────────────────────────────────────────────────────────

test("a shipped run's checkout is removed at once, without waiting for retention", () => {
  const decision = decideCheckout(
    { runs: [run("shipped", { finishedAt: NOW - 1000 })], lastActivityAt: NOW - 1000 },
    NOW,
    RETENTION,
  );
  assert.equal(decision.action, "remove");
  if (decision.action === "remove") {
    assert.equal(decision.kind, "shipped");
    assert.equal(decision.checkUnpushed, false);
    assert.match(decision.reason, /issue #12 shipped/);
  }
});

test("every unfinished status keeps its checkout, however old", () => {
  const live: DispatcherStatus[] = [
    "claimed",
    "running",
    "interrupted",
    "timed_out",
    "token_exhausted",
    "ci_pending",
    "pr_ready",
    "ci_failed",
    "held",
  ];
  for (const status of live) {
    const decision = decideCheckout(
      { runs: [run(status, { finishedAt: NOW - 90 * DAY })], lastActivityAt: NOW - 90 * DAY },
      NOW,
      RETENTION,
    );
    assert.equal(decision.action, "keep", status);
    if (decision.action === "keep") {
      assert.equal(decision.category, "live");
      assert.match(decision.reason, new RegExp(`is ${status}`));
    }
  }
});

test("a status this module does not know keeps the checkout", () => {
  const decision = decideCheckout(
    { runs: [run("parked-somewhere-new" as DispatcherStatus)], lastActivityAt: NOW - 90 * DAY },
    NOW,
    RETENTION,
  );
  assert.equal(decision.action, "keep");
});

test("a shipped run whose finalization is still pending keeps its checkout", () => {
  // A pending finalization can be replayed into a resume-mode relaunch, and the launcher
  // refuses to resume without its checkout.
  const decision = decideCheckout(
    { runs: [run("shipped", { finalizationPending: true })], lastActivityAt: NOW - 90 * DAY },
    NOW,
    RETENTION,
  );
  assert.equal(decision.action, "keep");
  if (decision.action === "keep") assert.match(decision.reason, /finalization is still pending/);
});

test("an older shipped run never releases a checkout a newer run of the same issue is using", () => {
  const decision = decideCheckout(
    { runs: [run("shipped"), run("interrupted", { finishedAt: NOW - HOUR })], lastActivityAt: NOW - HOUR },
    NOW,
    RETENTION,
  );
  assert.equal(decision.action, "keep");
});

test("failed and abandoned checkouts survive until their retention expires", () => {
  for (const status of ["failed", "abandoned"] as const) {
    const fresh = decideCheckout(
      { runs: [run(status, { finishedAt: NOW - RETENTION + HOUR })], lastActivityAt: NOW - 5 * DAY },
      NOW,
      RETENTION,
    );
    assert.equal(fresh.action, "keep", status);
    if (fresh.action === "keep") {
      assert.equal(fresh.category, "retained");
      assert.match(fresh.reason, new RegExp(`is ${status}; kept until ${new Date(NOW + HOUR).toISOString()}`));
    }

    const expired = decideCheckout(
      { runs: [run(status, { finishedAt: NOW - RETENTION })], lastActivityAt: NOW - 5 * DAY },
      NOW,
      RETENTION,
    );
    assert.equal(expired.action, "remove", status);
    if (expired.action === "remove") {
      assert.equal(expired.kind, "expired");
      // Expiry alone never deletes: unpushed commits are checked first.
      assert.equal(expired.checkUnpushed, true);
    }
  }
});

test("recent activity in a failed run's checkout restarts its retention", () => {
  const decision = decideCheckout(
    { runs: [run("failed", { finishedAt: NOW - 10 * DAY })], lastActivityAt: NOW - HOUR },
    NOW,
    RETENTION,
  );
  assert.equal(decision.action, "keep");
});

test("a run with no end time is aged from when it started", () => {
  const decision = decideCheckout(
    { runs: [run("abandoned", { finishedAt: null, startedAt: NOW - DAY })], lastActivityAt: NOW - 10 * DAY },
    NOW,
    RETENTION,
  );
  assert.equal(decision.action, "keep");
});

test("a failed checkout whose modification time is unreadable is kept", () => {
  const decision = decideCheckout({ runs: [run("failed")], lastActivityAt: null }, NOW, RETENTION);
  assert.equal(decision.action, "keep");
  if (decision.action === "keep") assert.equal(decision.category, "unverified");
});

test("a shipped record mixed with a failed one gets the conservative failed rule", () => {
  const retained = decideCheckout(
    { runs: [run("shipped"), run("failed", { finishedAt: NOW - DAY })], lastActivityAt: NOW - DAY },
    NOW,
    RETENTION,
  );
  assert.equal(retained.action, "keep");

  const expired = decideCheckout(
    { runs: [run("shipped"), run("failed")], lastActivityAt: NOW - 10 * DAY },
    NOW,
    RETENTION,
  );
  assert.equal(expired.action, "remove");
  if (expired.action === "remove") {
    assert.equal(expired.kind, "expired");
    assert.equal(expired.checkUnpushed, true);
  }
});

test("an orphan is removed once unmodified for the cutoff, and a recent one is left alone", () => {
  const recent = decideCheckout({ runs: [], lastActivityAt: NOW - 2 * DAY }, NOW, RETENTION);
  assert.equal(recent.action, "keep");
  if (recent.action === "keep") {
    assert.equal(recent.category, "retained");
    assert.match(recent.reason, /no run record; modified 2 days ago/);
  }

  const old = decideCheckout({ runs: [], lastActivityAt: NOW - 4 * DAY }, NOW, RETENTION);
  assert.equal(old.action, "remove");
  if (old.action === "remove") {
    assert.equal(old.kind, "orphan");
    assert.equal(old.checkUnpushed, true);
    assert.match(old.reason, /unmodified for 4 days/);
  }
});

test("an orphan whose modification time is unreadable, or in the future, is kept", () => {
  assert.equal(decideCheckout({ runs: [], lastActivityAt: null }, NOW, RETENTION).action, "keep");
  assert.equal(decideCheckout({ runs: [], lastActivityAt: NOW + DAY }, NOW, RETENTION).action, "keep");
});

test("only the launcher's branch shape is ever a checkout name", () => {
  for (const name of ["issue-7", "issue-102-remove-a-run-s-checkout-after-it-ships-and-prune-s"]) {
    assert.ok(CHECKOUT_DIR_NAME.test(name), name);
  }
  for (const name of ["", ".", "..", "notes", "issue-", "issue-x", "Issue-7", "issue-7/..", "issue-7-UPPER", ".issue-7"]) {
    assert.ok(!CHECKOUT_DIR_NAME.test(name), name);
  }
});

// ── final gates ───────────────────────────────────────────────────────────────

test("a directory in use, or whose use cannot be checked, is never removed", () => {
  assert.equal(processUseVerdict([]), null);
  assert.deepEqual(processUseVerdict(null), {
    category: "unverified",
    reason: "could not verify that no process is using it",
  });
  const busy = processUseVerdict([
    { pid: 1, command: "node" },
    { pid: 2, command: "bash" },
    { pid: 3, command: "vim" },
    { pid: 4, command: "less" },
  ]);
  assert.equal(busy?.category, "in-use");
  assert.equal(busy?.reason, "in use by node (pid 1), bash (pid 2), vim (pid 3) and 1 more");
});

test("unpushed commits, or an unanswerable check, keep the checkout and say why", () => {
  assert.equal(unpushedVerdict({ state: "none" }), null);
  const one = unpushedVerdict({ state: "present", count: 1 });
  assert.equal(one?.category, "unpushed");
  assert.match(one?.reason ?? "", /holds 1 commit that was never pushed/);
  assert.match(unpushedVerdict({ state: "present", count: 3 })?.reason ?? "", /holds 3 commits that were never pushed/);
  const unknown = unpushedVerdict({ state: "unknown", reason: "git exited 128" });
  assert.equal(unknown?.category, "unverified");
  assert.match(unknown?.reason ?? "", /git exited 128/);
});

// ── disk guard ───────────────────────────────────────────────────────────────

test("the launch floor is the smaller of 10 GB and 10% of the filesystem", () => {
  const floor = { minFreeBytes: 10 * GIB, minFreePercent: 10 };
  // Large disk: the absolute floor applies.
  assert.equal(minimumFreeBytes(195 * GIB, floor), 10 * GIB);
  // Small disk: 10% applies, so it is not held forever behind a floor it cannot meet.
  assert.equal(minimumFreeBytes(40 * GIB, floor), 4 * GIB);
});

test("the disk is low only below the floor, and either floor at 0 disables the guard", () => {
  const floor = { minFreeBytes: 10 * GIB, minFreePercent: 10 };
  const usage = (availableGb: number) => ({
    availableBytes: availableGb * GIB,
    totalBytes: 195 * GIB,
    path: "/srv/worktrees",
  });
  assert.equal(isDiskLow(usage(9), floor), true);
  assert.equal(isDiskLow(usage(10), floor), false);
  assert.equal(isDiskLow(usage(13), floor), false);
  assert.equal(isDiskLow(usage(0), { minFreeBytes: 0, minFreePercent: 10 }), false);
  assert.equal(isDiskLow(usage(0), { minFreeBytes: 10 * GIB, minFreePercent: 0 }), false);
});

test("the hold message says what was held, why, what cleanup kept, and that nothing was spent", () => {
  const message = lowDiskHoldMessage(
    "issue #42",
    { availableBytes: 3 * GIB, totalBytes: 195 * GIB, path: "/srv/worktrees" },
    { minFreeBytes: 10 * GIB, minFreePercent: 10 },
    {
      freedBytes: 512 * 1024 ** 2,
      kept: [
        { path: "/srv/worktrees/issue-1-a", category: "unpushed", reason: "holds 1 commit" },
        { path: "/srv/worktrees/issue-2-b", category: "live", reason: "issue #2 is held" },
        { path: "/srv/worktrees/issue-3-c", category: "retained", reason: "issue #3 is failed" },
      ],
    },
  );
  assert.match(message, /^Holding the launch of issue #42: 3\.0 GB is free on the filesystem holding \/srv\/worktrees, below the 10\.0 GB minimum\./);
  assert.match(message, /freed 512 MB, which was not enough/);
  assert.match(message, /1 holding unpushed commits \(\/srv\/worktrees\/issue-1-a\)/);
  assert.match(message, /1 within their retention window \(\/srv\/worktrees\/issue-3-c\)/);
  // A live run's checkout is not something an operator should delete to make room.
  assert.doesNotMatch(message, /issue-2-b/);
  assert.match(message, /Nothing was claimed and no retry budget was spent/);
  assert.match(message, /DISPATCHER_MIN_FREE_DISK_GB/);
});

test("the hold message lists at most three paths per category", () => {
  const kept = [1, 2, 3, 4, 5].map((n) => ({
    path: `/w/issue-${n}`,
    category: "unpushed" as const,
    reason: "holds commits",
  }));
  const message = lowDiskHoldMessage(
    "issue #9",
    { availableBytes: GIB, totalBytes: 100 * GIB, path: "/w" },
    { minFreeBytes: 10 * GIB, minFreePercent: 10 },
    { freedBytes: null, kept },
  );
  assert.match(message, /could not free enough/);
  assert.match(message, /5 holding unpushed commits \(\/w\/issue-1, \/w\/issue-2, \/w\/issue-3, and 2 more\)/);
});

// ── mechanics ────────────────────────────────────────────────────────────────

test("deletion runs at the lowest I/O and CPU priority the host offers", () => {
  const argv = ["rm", "-rf", "--", "/w/issue-1"];
  assert.deepEqual(lowPriorityCommand(argv, { ionice: true, nice: true }), [
    "ionice", "-c2", "-n7", "nice", "-n", "19", "rm", "-rf", "--", "/w/issue-1",
  ]);
  assert.deepEqual(lowPriorityCommand(argv, { ionice: false, nice: true }), [
    "nice", "-n", "19", "rm", "-rf", "--", "/w/issue-1",
  ]);
  assert.deepEqual(lowPriorityCommand(argv, { ionice: false, nice: false }), argv);
});

test("a sweep is due on startup and again once its interval has passed", () => {
  assert.equal(sweepDue(null, NOW, DAY), true);
  assert.equal(sweepDue(NOW - DAY + 1, NOW, DAY), false);
  assert.equal(sweepDue(NOW - DAY, NOW, DAY), true);
});

test("byte and duration formatting stay readable", () => {
  assert.equal(formatBytes(13.4 * GIB), "13.4 GB");
  assert.equal(formatBytes(300 * 1024 ** 2), "300 MB");
  assert.equal(formatBytes(2048), "2 KB");
  assert.equal(formatBytes(-2 * GIB), "-2.0 GB");
  assert.equal(formatDuration(5 * 60_000), "5 min");
  assert.equal(formatDuration(30 * HOUR), "30 h");
  assert.equal(formatDuration(3 * DAY), "3 days");
});
