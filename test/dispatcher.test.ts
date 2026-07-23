import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  selectResumable,
  shouldReleaseClaim,
  buildIssueComment,
  attemptRecordFromRun,
  runsToKeep,
  reconcile,
  MAX_AUTO_RESUMES,
  type DispatcherDeps,
} from "../src/dispatcher.ts";
import { StateStore } from "../src/state.ts";
import { createLogger } from "../src/logger.ts";
import type { RunRecord } from "../src/state.ts";
import type { DispatcherAgent } from "../src/labels.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "ai-dispatcher-loop-"));
}

function run(overrides: Partial<RunRecord>): RunRecord {
  return {
    id: overrides.id ?? "run-1",
    issueNumber: 1,
    issueTitle: "a thing",
    issueUrl: "https://x/1",
    agent: "claude",
    modelLabel: "model:claude-opus-4.8",
    cliModel: "claude-opus-4-8",
    effortLabel: "effort:high",
    cliEffort: "high",
    branch: "issue-1-a-thing",
    checkoutPath: "/w/issue-1-a-thing",
    planPath: null,
    status: "interrupted",
    trigger: "poll",
    lastCommit: null,
    prUrl: null,
    prNumber: null,
    exitCode: null,
    failureSummary: null,
    resumeCount: 0,
    lastProgressSeq: 0,
    outputSeq: 0,
    ciSelfHealAttempts: 0,
    ciEscalated: false,
    remotePid: null,
    createdAt: 1000,
    startedAt: 1000,
    finishedAt: null,
    ...overrides,
  };
}

// ── telemetry attempt mapping (#319) ────────────────────────────────────────────

test("attemptRecordFromRun maps a terminal run honestly", () => {
  const r = run({
    id: "run-x",
    status: "succeeded",
    resumeCount: 0,
    exitCode: 0,
    prUrl: "https://x/pull/9",
    startedAt: 1000,
    finishedAt: 4000,
  });
  const rec = attemptRecordFromRun(r, 5000);
  assert.equal(rec.issueNumber, 1);
  assert.equal(rec.attemptId, "run-x#0@4000"); // terminal timestamp keeps resumes distinct
  assert.equal(rec.provider, "anthropic"); // derived from the registry, not hard-coded
  assert.equal(rec.modelRequested, "claude-opus-4-8");
  assert.equal(rec.selectedModelLabel, "model:claude-opus-4.8");
  assert.equal(rec.activeDurationMs, 3000);
  assert.equal(rec.prCreated, true);
  assert.equal(rec.frontierModelUsed, true); // opus is frontier
  assert.equal(rec.terminalStatus, "succeeded");
  // Honest about what the launcher does not emit.
  assert.equal(rec.tokens.source, "unavailable");
  assert.equal(rec.tokens.inputTokens, null);
  assert.equal(rec.manualOverride, false);
});

test("attemptRecordFromRun disambiguates resumes and marks the retry reason", () => {
  const rec = attemptRecordFromRun(
    run({ id: "run-y", trigger: "resume", resumeCount: 2, status: "interrupted", finishedAt: null }),
    9000,
  );
  assert.equal(rec.attemptId, "run-y#2@9000"); // no finishedAt → falls back to nowMs
  assert.equal(rec.retryReason, "resume");
  assert.equal(rec.activeDurationMs, null); // no finishedAt → unknown duration
});

// ── resume selection ──────────────────────────────────────────────────────────

test("selectResumable returns the oldest eligible resumable run", () => {
  const none = () => false;
  const runs = [run({ id: "a", createdAt: 1 }), run({ id: "b", createdAt: 2 })];
  assert.equal(selectResumable(runs, none, MAX_AUTO_RESUMES)?.id, "a");
});

test("selectResumable skips a run whose provider is in a token cooldown", () => {
  const claudeDown = (agent: DispatcherAgent) => agent === "claude";
  const runs = [
    run({ id: "claude", agent: "claude" }),
    run({ id: "codex", agent: "codex", modelLabel: "model:gpt-5.5", cliModel: "gpt-5.5" }),
  ];
  assert.equal(selectResumable(runs, claudeDown, MAX_AUTO_RESUMES)?.id, "codex");
});

test("selectResumable skips a run that has hit the auto-resume cap", () => {
  const none = () => false;
  const runs = [run({ id: "capped", resumeCount: MAX_AUTO_RESUMES })];
  assert.equal(selectResumable(runs, none, MAX_AUTO_RESUMES), null);
});

// ── claim release ─────────────────────────────────────────────────────────────

test("resumable statuses keep their claim; terminal ones release it", () => {
  assert.equal(shouldReleaseClaim("interrupted"), false);
  assert.equal(shouldReleaseClaim("timed_out"), false);
  assert.equal(shouldReleaseClaim("token_exhausted"), false);
  assert.equal(shouldReleaseClaim("succeeded"), true);
  assert.equal(shouldReleaseClaim("failed"), true);
  assert.equal(shouldReleaseClaim("abandoned"), true);
});

// ── issue comment ─────────────────────────────────────────────────────────────

test("a succeeded run's comment reads 'complete' and lists the PR", () => {
  const comment = buildIssueComment(
    run({ status: "succeeded", prUrl: "https://x/pull/9", lastCommit: "abc123" }),
    false,
    null,
  );
  assert.match(comment, /Dispatcher run complete/);
  assert.match(comment, /https:\/\/x\/pull\/9/);
  assert.match(comment, /abc123/);
});

test("a resumable run's comment promises an automatic resume", () => {
  const comment = buildIssueComment(run({ status: "interrupted" }), true, null);
  assert.match(comment, /resume this run on its next/i);
  assert.match(comment, /completed work is not redone/i);
});

test("a failed run's comment surfaces the failure summary and any deferral", () => {
  const comment = buildIssueComment(
    run({ status: "failed", failureSummary: "made no commits" }),
    false,
    "deferred after 3 matching failures",
  );
  assert.match(comment, /Dispatcher run failed/);
  assert.match(comment, /made no commits/);
  assert.match(comment, /deferred after 3 matching failures/);
});

// ── retention ─────────────────────────────────────────────────────────────────

test("runsToKeep always retains claiming/resumable runs plus the newest terminal ones", () => {
  const runs = [
    run({ id: "active", status: "running", createdAt: 1 }),
    run({ id: "resumable", status: "interrupted", createdAt: 2 }),
    run({ id: "old", status: "succeeded", createdAt: 3 }),
    run({ id: "new", status: "failed", createdAt: 4 }),
  ];
  // Budget of 3: both claim-holders are kept unconditionally, then the newest terminal.
  const keep = runsToKeep(runs, 3);
  assert.ok(keep.has("active"));
  assert.ok(keep.has("resumable"));
  assert.ok(keep.has("new"));
  assert.ok(!keep.has("old"));
});

// ── reconcile ─────────────────────────────────────────────────────────────────

function depsWith(store: StateStore): DispatcherDeps {
  return {
    config: {} as DispatcherDeps["config"],
    store,
    logger: createLogger("error", () => undefined),
    github: {} as DispatcherDeps["github"],
    notifier: { send: async () => undefined },
    now: () => 5000,
  };
}

test("reconcile turns an orphaned claimed/running run into a resumable interrupted one", () => {
  const dir = tmp();
  try {
    const store = StateStore.open(dir);
    const claimed = store.createRun({
      issueNumber: 7,
      issueTitle: "orphan",
      issueUrl: "https://x/7",
      agent: "codex",
      modelLabel: "model:gpt-5.5",
      cliModel: "gpt-5.5",
      effortLabel: "effort:medium",
      cliEffort: "medium",
      branch: "issue-7-orphan",
      checkoutPath: "/w/issue-7-orphan",
      planPath: null,
      trigger: "poll",
    });
    assert.equal(claimed.status, "claimed");

    reconcile(depsWith(store));

    const after = store.getRun(claimed.id);
    assert.equal(after?.status, "interrupted");
    assert.equal(after?.finishedAt, 5000);
    // It is now resumable and still holds its claim.
    assert.equal(store.resumableRuns().length, 1);
    assert.equal(store.claimingRunsByIssue().get(7), "interrupted");
    store.releaseLock();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reconcile leaves already-terminal runs untouched", () => {
  const dir = tmp();
  try {
    const store = StateStore.open(dir);
    const r = store.createRun({
      issueNumber: 8,
      issueTitle: "done",
      issueUrl: "https://x/8",
      agent: "codex",
      modelLabel: "model:gpt-5.5",
      cliModel: "gpt-5.5",
      effortLabel: "effort:medium",
      cliEffort: "medium",
      branch: "issue-8-done",
      checkoutPath: "/w/issue-8-done",
      planPath: null,
      trigger: "poll",
    });
    store.updateRun(r.id, { status: "succeeded", finishedAt: 100 });

    reconcile(depsWith(store));

    const after = store.getRun(r.id);
    assert.equal(after?.status, "succeeded");
    assert.equal(after?.finishedAt, 100);
    store.releaseLock();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
