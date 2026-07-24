import { test } from "node:test";
import assert from "node:assert/strict";
import {
  shouldCaptureUncommittedWork,
  shouldRepairUnpublishedDirtyWork,
} from "../src/capture.ts";

// The TS mirror of scripts/lib/dispatch-capture.sh's decision. Capture ONLY when all
// three hold: clean exit, no agent commits ahead, and a dirty tree.

test("captures a clean exit that left uncommitted work with no commits", () => {
  assert.equal(shouldCaptureUncommittedWork(0, 0, true), true);
});

test("does NOT capture when the exit was non-zero — the tree may be half-written", () => {
  assert.equal(shouldCaptureUncommittedWork(1, 0, true), false);
  assert.equal(shouldCaptureUncommittedWork(124, 0, true), false);
});

test("does NOT capture when the agent already has commits ahead of main", () => {
  assert.equal(shouldCaptureUncommittedWork(0, 1, true), false);
});

test("does NOT capture a clean tree — there is nothing to rescue", () => {
  assert.equal(shouldCaptureUncommittedWork(0, 0, false), false);
});

test("a clean exit with commits plus dirty tail work re-enters repair instead of shipping", () => {
  assert.equal(shouldRepairUnpublishedDirtyWork(0, 1, true), true);
  assert.equal(shouldRepairUnpublishedDirtyWork(0, 1, false), false);
  assert.equal(shouldRepairUnpublishedDirtyWork(1, 1, true), false);
});
