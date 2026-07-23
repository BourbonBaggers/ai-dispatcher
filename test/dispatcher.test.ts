import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  selectResumable,
  selectParked,
  shouldReleaseClaim,
  buildIssueComment,
  attemptRecordFromRun,
  runsToKeep,
  reconcile,
  recheckParkedRun,
  MAX_AUTO_RESUMES,
  type DispatcherDeps,
} from "../src/dispatcher.ts";
import { StateStore } from "../src/state.ts";
import { createLogger } from "../src/logger.ts";
import type { RunRecord } from "../src/state.ts";
import type { DispatcherAgent } from "../src/labels.ts";
import type { DispatcherConfig } from "../src/config.ts";

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
    deployEscalated: false,
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
    status: "shipped",
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
  assert.equal(rec.terminalStatus, "shipped");
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

// ── parked (ci_pending) selection ───────────────────────────────────────────────

test("selectParked returns the oldest parked run", () => {
  const parked = [
    run({ id: "p1", status: "ci_pending", createdAt: 1 }),
    run({ id: "p2", status: "ci_pending", createdAt: 2 }),
  ];
  assert.equal(selectParked(parked)?.id, "p1");
});

test("selectParked returns null when nothing is parked", () => {
  assert.equal(selectParked([]), null);
});

// ── claim release ─────────────────────────────────────────────────────────────

test("resumable and parked statuses keep their claim; terminal ones release it", () => {
  // Resumable (crash/timeout -- the next scan relaunches the agent).
  assert.equal(shouldReleaseClaim("interrupted"), false);
  assert.equal(shouldReleaseClaim("timed_out"), false);
  assert.equal(shouldReleaseClaim("token_exhausted"), false);
  // Parked (ci_pending -- the next scan only re-checks CI) and mid-ladder (ci_failed --
  // resolved synchronously, never actually left across a scan boundary, but must still
  // hold the claim defensively).
  assert.equal(shouldReleaseClaim("ci_pending"), false);
  assert.equal(shouldReleaseClaim("ci_failed"), false);
  // Truly terminal: a run is only "shipped" once autoship has actually merged + deployed
  // (#366) -- it, `held`, `failed`, and `abandoned` all release the claim.
  assert.equal(shouldReleaseClaim("shipped"), true);
  assert.equal(shouldReleaseClaim("held"), true);
  assert.equal(shouldReleaseClaim("failed"), true);
  assert.equal(shouldReleaseClaim("abandoned"), true);
});

// ── issue comment ─────────────────────────────────────────────────────────────

test("a provisionally-shipped run's comment reads 'complete' and lists the PR", () => {
  // "shipped" at buildIssueComment time is the agent's own hand-off observation (CI was
  // green when it finished), not confirmation that autoship has actually merged +
  // deployed yet -- evaluateAutoship's own follow-up comment covers that.
  const comment = buildIssueComment(
    run({ status: "shipped", prUrl: "https://x/pull/9", lastCommit: "abc123" }),
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

test("a parked (ci_pending) run's comment says it will re-check CI, NOT relaunch the agent", () => {
  const comment = buildIssueComment(run({ status: "ci_pending" }), true, null);
  assert.match(comment, /check back once CI resolves/i);
  assert.match(comment, /will NOT relaunch the agent/i);
  // Must not also show the generic "resume this run" language -- that would wrongly
  // imply a full agent relaunch is coming.
  assert.doesNotMatch(comment, /resume this run on its next/i);
});

test("a ci_failed run's comment describes the self-heal/escalate ladder", () => {
  const comment = buildIssueComment(run({ status: "ci_failed" }), true, null);
  assert.match(comment, /self-heal/i);
  assert.match(comment, /escalating/i);
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
    run({ id: "old", status: "shipped", createdAt: 3 }),
    run({ id: "new", status: "failed", createdAt: 4 }),
  ];
  // Budget of 3: both claim-holders are kept unconditionally, then the newest terminal.
  const keep = runsToKeep(runs, 3);
  assert.ok(keep.has("active"));
  assert.ok(keep.has("resumable"));
  assert.ok(keep.has("new"));
  assert.ok(!keep.has("old"));
});

test("runsToKeep also retains a parked (ci_pending) run unconditionally, like a claim-holder", () => {
  const runs = [
    run({ id: "parked", status: "ci_pending", createdAt: 1 }),
    run({ id: "a", status: "shipped", createdAt: 2 }),
    run({ id: "b", status: "shipped", createdAt: 3 }),
  ];
  const keep = runsToKeep(runs, 1);
  assert.ok(keep.has("parked"), "a parked run must never be pruned out from under its claim");
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
    store.updateRun(r.id, { status: "shipped", finishedAt: 100 });

    reconcile(depsWith(store));

    const after = store.getRun(r.id);
    assert.equal(after?.status, "shipped");
    assert.equal(after?.finishedAt, 100);
    store.releaseLock();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


// ── recheckParkedRun / evaluateAutoship (#366: park on CI-pending, don't relaunch) ──

function autoshipConfig(overrides: Partial<DispatcherConfig> = {}): DispatcherConfig {
  return {
    repo: { owner: "o", repo: "r", slug: "o/r" },
    autoshipCmd: "ship.sh",
    autoshipDeploymentDir: "/deploy/o-r",
    generatedConflictAllowlist: [],
    generatedConflictRegenCmd: null,
    generatedConflictMaxAttempts: 1,
    generatedConflictCiWaitSeconds: 900,
    ciSelfHealMaxAttempts: 2,
    ciEscalationModel: "claude-opus-4-8",
    ...overrides,
  } as DispatcherConfig;
}

function parkedDeps(store: StateStore, opts: {
  ci?: "pass" | "pending" | "fail";
  isDraft?: boolean;
  issueLabels?: string[];
}): { deps: DispatcherDeps; comments: string[]; labels: string[]; ships: { count: number } } {
  const comments: string[] = [];
  const labels: string[] = [];
  const ships = { count: 0 };
  const deps: DispatcherDeps = {
    config: autoshipConfig(),
    store,
    logger: createLogger("error", () => undefined),
    github: {
      prChecksState: async () => opts.ci ?? "pending",
      waitForPrChecks: async () => opts.ci ?? "pending",
      prMergeInfo: async () => ({
        baseRefName: "main",
        baseRefOid: "base",
        headRefName: "issue-1-x",
        headRefOid: "head",
        isDraft: opts.isDraft ?? false,
        mergeStateStatus: "CLEAN",
        reviewDecision: null,
      }),
      prDiff: async () => "",
      comment: async (_i: number, b: string) => { comments.push(b); return true; },
      addLabel: async (_i: number, l: string) => { labels.push(l); return true; },
      removeLabel: async () => true,
      issueLabels: async () => opts.issueLabels ?? [],
      markPrReady: async () => true,
      closeIssue: async () => true,
    } as unknown as DispatcherDeps["github"],
    notifier: { send: async () => undefined },
    ship: async () => { ships.count += 1; return { ok: true, stdout: "", stderr: "", code: 0 }; },
    now: () => 5000,
  };
  return { deps, comments, labels, ships };
}

function parkedRun(store: StateStore): RunRecord {
  const created = store.createRun({
    issueNumber: 1,
    issueTitle: "a thing",
    issueUrl: "https://x/1",
    agent: "claude",
    modelLabel: "model:claude-sonnet-5",
    cliModel: "claude-sonnet-5",
    effortLabel: "effort:high",
    cliEffort: "high",
    branch: "issue-1-x",
    checkoutPath: "/w/issue-1-x",
    planPath: null,
    trigger: "poll",
  });
  return store.updateRun(created.id, {
    status: "ci_pending",
    exitCode: 0,
    prUrl: "https://x/pull/42",
    prNumber: 42,
    finishedAt: 1000,
  });
}

test("recheckParkedRun stays parked, silently, when CI is still pending", async () => {
  const dir = tmp();
  try {
    const store = StateStore.open(dir);
    const run1 = parkedRun(store);
    const { deps, comments, labels } = parkedDeps(store, { ci: "pending" });

    await recheckParkedRun(deps, run1);

    const after = store.getRun(run1.id);
    assert.equal(after?.status, "ci_pending", "still parked -- no agent relaunch, no status churn");
    assert.equal(comments.length, 0, "a still-pending recheck must not post a new comment");
    assert.equal(labels.length, 0, "a still-pending recheck must not touch labels");
    store.releaseLock();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recheckParkedRun ships once CI has resolved to green, without relaunching the agent", async () => {
  const dir = tmp();
  try {
    const store = StateStore.open(dir);
    const run1 = parkedRun(store);
    const { deps, ships } = parkedDeps(store, { ci: "pass" });

    await recheckParkedRun(deps, run1);

    const after = store.getRun(run1.id);
    assert.equal(after?.status, "shipped");
    assert.equal(ships.count, 1, "the ship command runs exactly once");
    store.releaseLock();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recheckParkedRun promotes a draft PR and ships it once CI is green (no human-review-required)", async () => {
  const dir = tmp();
  try {
    const store = StateStore.open(dir);
    const run1 = parkedRun(store);
    const { deps, ships } = parkedDeps(store, { ci: "pass", isDraft: true });

    await recheckParkedRun(deps, run1);

    const after = store.getRun(run1.id);
    assert.equal(after?.status, "shipped");
    assert.equal(ships.count, 1);
    store.releaseLock();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recheckParkedRun holds a draft PR when the issue carries human-review-required", async () => {
  const dir = tmp();
  try {
    const store = StateStore.open(dir);
    const run1 = parkedRun(store);
    const { deps, labels } = parkedDeps(store, {
      ci: "pass",
      isDraft: true,
      issueLabels: ["human-review-required"],
    });

    await recheckParkedRun(deps, run1);

    const after = store.getRun(run1.id);
    assert.equal(after?.status, "held");
    assert.ok(labels.includes("autoship-held"));
    store.releaseLock();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
