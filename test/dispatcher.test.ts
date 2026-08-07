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
  recheckHeldRun,
  runScanOnce,
  finalizeRun,
  assignedIdentity,
  nextResumeCount,
  nextRecoveryLaunch,
  isOwnedLauncherCommand,
  checkpointLadderRun,
  planQuotaHandoff,
  MAX_AUTO_RESUMES,
  type DispatcherDeps,
} from "../src/dispatcher.ts";
import { StateStore } from "../src/state.ts";
import { createLogger } from "../src/logger.ts";
import type { RunRecord } from "../src/state.ts";
import type { DispatcherConfig } from "../src/config.ts";
import { assessCapacity } from "../src/capacity.ts";

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
    assignedAgent: "claude",
    assignedModelLabel: "model:claude-opus-4.8",
    assignedCliModel: "claude-opus-4-8",
    assignedEffortLabel: "effort:high",
    assignedCliEffort: "high",
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
    attemptNumber: 1,
    lastProgressSeq: 0,
    outputSeq: 0,
    recovery: {},
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
    routing: {
      source: "human-override",
      minimumTier: "frontier",
      characteristicLabels: ["complexity:complex"],
      rationaleLabels: ["route:human-override"],
      confidence: "high",
      capacitySelection: "human-override",
      selectedPool: "claude-subscription",
      effortReason: "explicit human override effort:high",
      capacity: [{
        pool: "claude-subscription",
        state: "available",
        confidence: "provider-reported",
        observedAt: 900,
        resetAt: null,
        headroomPercent: 50,
        reason: "test",
      }],
      assignedAt: 900,
    },
  });
  const rec = attemptRecordFromRun(r, 5000);
  assert.equal(rec.issueNumber, 1);
  assert.equal(rec.attemptId, "run-x#1");
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
  assert.equal(rec.manualOverride, true);
  assert.equal(rec.effortLabel, "effort:high");
  assert.equal(rec.capacityStateAtAssignment, "available");
  assert.deepEqual(rec.issueCharacteristicLabels, ["complexity:complex"]);
});

test("attemptRecordFromRun disambiguates resumes and marks the retry reason", () => {
  const rec = attemptRecordFromRun(
    run({
      id: "run-y",
      trigger: "resume",
      resumeCount: 2,
      attemptNumber: 4,
      status: "interrupted",
      finishedAt: null,
    }),
    9000,
  );
  assert.equal(rec.attemptId, "run-y#4");
  assert.equal(rec.retryReason, "resume");
  assert.equal(rec.activeDurationMs, null); // no finishedAt → unknown duration
});

test("later-phase repairs restore the immutable assigned model after frontier use", () => {
  const escalated = run({
    agent: "claude",
    modelLabel: "model:claude-opus-4.8",
    cliModel: "claude-opus-4-8",
    effortLabel: "effort:max",
    cliEffort: "xhigh",
    assignedAgent: "codex",
    assignedModelLabel: "model:gpt-5.5",
    assignedCliModel: "gpt-5.5",
    assignedEffortLabel: "effort:medium",
    assignedCliEffort: "medium",
  });
  assert.deepEqual(assignedIdentity(escalated), {
    agent: "codex",
    modelLabel: "model:gpt-5.5",
    cliModel: "gpt-5.5",
    effortLabel: "effort:medium",
    cliEffort: "medium",
  });
});

test("quota handoff changes provider without consuming frontier or changing assigned effort", () => {
  const blocked = run({
    status: "token_exhausted",
    agent: "claude",
    modelLabel: "model:claude-sonnet-5",
    cliModel: "claude-sonnet-5",
    effortLabel: "effort:high",
    cliEffort: "high",
    assignedAgent: "claude",
    assignedModelLabel: "model:claude-sonnet-5",
    assignedCliModel: "claude-sonnet-5",
    assignedEffortLabel: "effort:high",
    assignedCliEffort: "high",
  });
  const capacities = new Map([
    ["claude-subscription", assessCapacity("claude-subscription", 10_000, 5_000)],
    ["codex-subscription", assessCapacity("codex-subscription", null, 5_000)],
  ]);
  const handoff = planQuotaHandoff(blocked, capacities);
  assert.equal(handoff.ok, true);
  if (handoff.ok) {
    assert.equal(handoff.value.modelLabel, "model:gpt-5.6-terra");
    assert.equal(handoff.value.effortLabel, "effort:high");
    assert.notEqual(handoff.value.modelLabel, "model:claude-opus-4.8");
  }
});

// ── resume selection ──────────────────────────────────────────────────────────

test("selectResumable returns the oldest eligible resumable run", () => {
  const none = () => false;
  const runs = [run({ id: "a", createdAt: 1 }), run({ id: "b", createdAt: 2 })];
  assert.equal(selectResumable(runs, none, MAX_AUTO_RESUMES)?.id, "a");
});

test("selectResumable skips a run whose provider is in a token cooldown", () => {
  const claudeDown = (candidate: RunRecord) => candidate.agent === "claude";
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

test("provider output never resets the finite resume budget", () => {
  assert.equal(nextResumeCount(run({ resumeCount: 2, outputSeq: 500, lastProgressSeq: 1 })), 3);
});

test("frontier and repair rungs receive a fresh finite resume budget", () => {
  assert.deepEqual(nextRecoveryLaunch(run({ resumeCount: 3, outputSeq: 500, attemptNumber: 7 })), {
    resumeCount: 0,
    lastProgressSeq: 500,
    attemptNumber: 8,
  });
});

test("orphan process ownership requires the exact issue and branch arguments", () => {
  const r = run({ issueNumber: 12, branch: "issue-12-fix-ci" });
  assert.equal(
    isOwnedLauncherCommand(
      "bash /srv/scripts/dispatch-agent.sh --issue 12 --agent codex --branch issue-12-fix-ci",
      r,
    ),
    true,
  );
  assert.equal(
    isOwnedLauncherCommand(
      "bash /srv/scripts/dispatch-agent.sh --issue 120 --branch issue-12-fix-ci",
      r,
    ),
    false,
  );
  assert.equal(isOwnedLauncherCommand("node unrelated.js", r), false);
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

test("shouldReleaseClaim marks a run done-working (drops agent-working, no resume message)", () => {
  // This governs the agent-working label + the "will auto-resume" comment, NOT issue-claim
  // retention (that is CLAIMING_STATUSES, exercised in state.test.ts).
  // Still working (agent-working stays): crash/timeout resumables, parked CI recheck, and
  // the mid-ladder ci_failed marker.
  assert.equal(shouldReleaseClaim("interrupted"), false);
  assert.equal(shouldReleaseClaim("timed_out"), false);
  assert.equal(shouldReleaseClaim("token_exhausted"), false);
  assert.equal(shouldReleaseClaim("ci_pending"), false);
  assert.equal(shouldReleaseClaim("ci_failed"), false);
  // Done working (agent-working dropped, no resume message): pr_ready, shipped, held, failed,
  // abandoned. NB `held` still KEEPS its issue claim (see state.test.ts) even though no
  // agent is working it — the two concepts are distinct.
  assert.equal(shouldReleaseClaim("pr_ready"), true);
  assert.equal(shouldReleaseClaim("shipped"), true);
  assert.equal(shouldReleaseClaim("held"), true);
  assert.equal(shouldReleaseClaim("failed"), true);
  assert.equal(shouldReleaseClaim("abandoned"), true);
});

test("a pre-launch closed issue clears its working label without spending recovery", async () => {
  const dir = tmp();
  try {
    const store = StateStore.open(dir);
    const created = parkedRun(store);
    const abandoned = store.updateRun(created.id, {
      status: "abandoned",
      finalizationPending: true,
    });
    const { deps, removedLabels } = parkedDeps(store, {});

    await finalizeRun(deps, abandoned);

    assert.deepEqual(removedLabels, ["agent-working"]);
    assert.equal(store.getRun(abandoned.id)?.finalizationPending, false);
    store.releaseLock();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── issue comment ─────────────────────────────────────────────────────────────

test("a PR-ready run's comment describes the autoship handoff and lists the PR", () => {
  const comment = buildIssueComment(
    run({ status: "pr_ready", prUrl: "https://x/pull/9", lastCommit: "abc123" }),
    false,
  );
  assert.match(comment, /Dispatcher run PR ready/);
  assert.match(comment, /https:\/\/x\/pull\/9/);
  assert.match(comment, /abc123/);
});

test("a resumable run's comment promises an automatic resume", () => {
  const comment = buildIssueComment(run({ status: "interrupted" }), true);
  assert.match(comment, /resume this run on its next/i);
  assert.match(comment, /completed work is not redone/i);
});

test("a parked (ci_pending) run's comment says it will re-check CI, NOT relaunch the agent", () => {
  const comment = buildIssueComment(run({ status: "ci_pending" }), true);
  assert.match(comment, /check back once CI resolves/i);
  assert.match(comment, /will NOT relaunch the agent/i);
  // Must not also show the generic "resume this run" language -- that would wrongly
  // imply a full agent relaunch is coming.
  assert.doesNotMatch(comment, /resume this run on its next/i);
});

test("a ci_failed run's comment describes the self-heal/escalate ladder", () => {
  const comment = buildIssueComment(run({ status: "ci_failed" }), true);
  assert.match(comment, /self-heal/i);
  assert.match(comment, /escalating/i);
});

test("a failed run's comment surfaces the failure and automatic repair", () => {
  const comment = buildIssueComment(
    run({ status: "failed", failureSummary: "made no commits" }),
    false,
  );
  assert.match(comment, /Dispatcher run failed/);
  assert.match(comment, /made no commits/);
  assert.match(comment, /relaunching the agent/i);
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

test("runsToKeep retains a PR-ready handoff so an open issue is not redispatched", () => {
  const runs = [
    run({ id: "ready", status: "pr_ready", createdAt: 1 }),
    run({ id: "newer", status: "failed", createdAt: 2 }),
  ];
  const keep = runsToKeep(runs, 1);
  assert.ok(keep.has("ready"));
});

test("runsToKeep retains a held run unconditionally — its claim keeps the issue from being re-dispatched (#10)", () => {
  const runs = [
    run({ id: "held", status: "held", createdAt: 1 }),
    run({ id: "a", status: "shipped", createdAt: 2 }),
    run({ id: "b", status: "failed", createdAt: 3 }),
  ];
  // Budget of 1: without special-casing, the newest terminal (b) would win the only slot and
  // the held run would be pruned, dropping the claim that blocks a fresh re-dispatch.
  const keep = runsToKeep(runs, 1);
  assert.ok(keep.has("held"), "a held run must never be pruned out from under its claim");
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

test("reconcile kills a verified orphan launcher before making its run resumable", () => {
  const dir = tmp();
  try {
    const store = StateStore.open(dir);
    const created = store.createRun({
      issueNumber: 18,
      issueTitle: "orphan process",
      issueUrl: "https://x/18",
      agent: "codex",
      modelLabel: "model:gpt-5.5",
      cliModel: "gpt-5.5",
      effortLabel: "effort:medium",
      cliEffort: "medium",
      branch: "issue-18-orphan-process",
      checkoutPath: "/w/issue-18-orphan-process",
      planPath: null,
      trigger: "poll",
    });
    store.updateRun(created.id, { status: "running", remotePid: 4242 });
    const killed: number[] = [];
    reconcile({
      ...depsWith(store),
      processCommand: () =>
        "bash /srv/dispatch-agent.sh --issue 18 --branch issue-18-orphan-process",
      terminateOrphan: (pid) => killed.push(pid),
    });
    assert.deepEqual(killed, [4242]);
    assert.equal(store.getRun(created.id)?.remotePid, null);
    assert.equal(store.getRun(created.id)?.status, "interrupted");
    store.releaseLock();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


// ── recheckParkedRun / evaluateAutoship: park on CI-pending, don't relaunch ──

function autoshipConfig(overrides: Partial<DispatcherConfig> = {}): DispatcherConfig {
  return {
    repo: { owner: "o", repo: "r", slug: "o/r" },
    autoshipCmd: "ship.sh",
    autoshipTimeoutMinutes: 120,
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
  ci?: "pass" | "pending" | "fail" | "unknown";
  isDraft?: boolean;
  issueState?: "OPEN" | "CLOSED" | "UNKNOWN";
  issueLabels?: string[] | null;
  prState?: "open" | "merged" | "closed" | "unknown";
  shipResult?: { ok: boolean; stdout: string; stderr: string; code: number | null };
}): {
  deps: DispatcherDeps;
  comments: string[];
  labels: string[];
  removedLabels: string[];
  ships: { count: number };
  reads: { issueLabels: number };
  reopened: { count: number };
  notifications: { count: number };
  outcomes: Array<{ issue: number; productionStatus?: string; finalCompletingModel?: string | null }>;
} {
  const comments: string[] = [];
  const labels: string[] = [];
  const removedLabels: string[] = [];
  const ships = { count: 0 };
  const reads = { issueLabels: 0 };
  const reopened = { count: 0 };
  const notifications = { count: 0 };
  const outcomes: Array<{ issue: number; productionStatus?: string; finalCompletingModel?: string | null }> = [];
  const deps: DispatcherDeps = {
    config: autoshipConfig(),
    store,
    logger: createLogger("error", () => undefined),
    github: {
      prState: async () => opts.prState ?? "open",
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
        mergeCommitOid: "merged",
      }),
      prDiff: async () => "",
      comment: async (_i: number, b: string) => { comments.push(b); return true; },
      addLabel: async (_i: number, l: string) => { labels.push(l); return true; },
      removeLabel: async (_i: number, l: string) => { removedLabels.push(l); return true; },
      issueState: async () => opts.issueState ?? "OPEN",
      issueLabels: async () => {
        reads.issueLabels += 1;
        return opts.issueLabels === undefined ? [] : opts.issueLabels;
      },
      markPrReady: async () => true,
      closeIssue: async () => true,
      reopenIssue: async () => { reopened.count += 1; return true; },
    } as unknown as DispatcherDeps["github"],
    notifier: { send: async () => { notifications.count += 1; } },
    telemetry: {
      setIssueOutcome: (
        issue: number,
        outcome: { productionStatus?: string; finalCompletingModel?: string | null },
      ) => {
        outcomes.push({
          issue,
          ...(outcome.productionStatus === undefined ? {} : { productionStatus: outcome.productionStatus }),
          ...(outcome.finalCompletingModel === undefined
            ? {}
            : { finalCompletingModel: outcome.finalCompletingModel }),
        });
      },
    } as unknown as NonNullable<DispatcherDeps["telemetry"]>,
    ship: async () => {
      ships.count += 1;
      return opts.shipResult ?? {
        ok: true,
        stdout: "::autoship:: state=shipped health=pass merged=merged deployed=merged\n",
        stderr: "",
        code: 0,
      };
    },
    now: () => 5000,
  };
  return { deps, comments, labels, removedLabels, ships, reads, reopened, notifications, outcomes };
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

test("recheckParkedRun parks unknown GitHub state without burning a repair budget", async () => {
  const dir = tmp();
  try {
    const store = StateStore.open(dir);
    const run1 = parkedRun(store);
    const { deps, ships, notifications } = parkedDeps(store, {
      ci: "unknown",
      prState: "unknown",
    });

    await recheckParkedRun(deps, run1);

    const after = store.getRun(run1.id);
    assert.equal(after?.status, "ci_pending");
    assert.deepEqual(after?.recovery, {});
    assert.equal(ships.count, 0);
    assert.equal(notifications.count, 0);
    store.releaseLock();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parked-CI recovery checkpoints replay before relaunch", () => {
  const dir = tmp();
  try {
    const store = StateStore.open(dir);
    const run1 = parkedRun(store);
    checkpointLadderRun(store, run1);
    const after = store.getRun(run1.id);
    assert.equal(after?.status, "ci_failed");
    assert.equal(after?.finalizationPending, true);
    assert.equal(store.pendingFinalizations()[0]?.id, run1.id);
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
    const { deps, ships, outcomes } = parkedDeps(store, { ci: "pass" });

    await recheckParkedRun(deps, run1);

    const after = store.getRun(run1.id);
    assert.equal(after?.status, "shipped");
    assert.equal(ships.count, 1, "the ship command runs exactly once");
    assert.deepEqual(outcomes, [{
      issue: 1,
      productionStatus: "deployed",
      finalCompletingModel: "claude-sonnet-5",
    }]);
    store.releaseLock();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recheckParkedRun remains parked while detached systemd deployment verification is pending", async () => {
  const dir = tmp();
  try {
    const store = StateStore.open(dir);
    const run1 = parkedRun(store);
    const { deps, ships, notifications } = parkedDeps(store, {
      ci: "pass",
      shipResult: {
        ok: true,
        stdout:
          "::autoship:: state=merge_succeeded_deployment_not_attempted health=unknown merged=merged\n",
        stderr: "",
        code: 0,
      },
    });

    await recheckParkedRun(deps, run1);

    assert.equal(store.getRun(run1.id)?.status, "ci_pending");
    assert.equal(ships.count, 1);
    assert.equal(notifications.count, 0, "pending verification is not announced as success");
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

test("recheckParkedRun promotes and ships a draft PR even with human-review-required (no human gate)", async () => {
  const dir = tmp();
  try {
    const store = StateStore.open(dir);
    const run1 = parkedRun(store);
    const { deps, labels, ships } = parkedDeps(store, {
      ci: "pass",
      isDraft: true,
      issueLabels: ["human-review-required"],
    });

    await recheckParkedRun(deps, run1);

    const after = store.getRun(run1.id);
    assert.equal(after?.status, "shipped");
    assert.equal(ships.count, 1, "the draft is promoted and shipped, not held");
    assert.ok(!labels.includes("autoship-held"), "human-review-required must not hold under autoship-everything policy");
    store.releaseLock();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recheckParkedRun pages only after CI repairs and frontier escalation are exhausted", async () => {
  const dir = tmp();
  try {
    const store = StateStore.open(dir);
    const created = parkedRun(store);
    const exhausted = store.updateRun(created.id, {
      recovery: { ci: { attempts: 2, escalated: true } },
    });
    const { deps, comments, labels, notifications } = parkedDeps(store, { ci: "fail" });

    await recheckParkedRun(deps, exhausted);

    assert.equal(store.getRun(exhausted.id)?.status, "held");
    assert.ok(labels.includes("autoship-held"));
    assert.equal(notifications.count, 1, "one final operator page");
    assert.match(comments.at(-1) ?? "", /Dispatcher exhausted/i);
    store.releaseLock();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── recheckHeldRun (#10: un-hold resumes autoship of the ready PR, not a fresh run) ──

function heldRun(store: StateStore): RunRecord {
  const created = parkedRun(store);
  return store.updateRun(created.id, {
    status: "held",
    exitCode: 75,
    exhaustion: { kind: "ci", reason: "frontier failed", at: 1000, labelApplied: true },
  });
}

test("recheckHeldRun reopens a prematurely closed exhausted issue and retains its hold", async () => {
  const dir = tmp();
  try {
    const store = StateStore.open(dir);
    const run1 = heldRun(store);
    const { deps, comments, labels, removedLabels, ships, reads, reopened, notifications } = parkedDeps(store, {
      ci: "pass",
      issueState: "CLOSED",
      prState: "merged",
      issueLabels: ["autoship-held"],
    });

    const { rechecked } = await recheckHeldRun(deps, run1);

    assert.equal(rechecked, false);
    assert.equal(store.getRun(run1.id)?.status, "held");
    assert.equal(reopened.count, 1, "closure without verified production is repaired");
    assert.equal(reads.issueLabels, 1);
    assert.equal(ships.count, 0);
    assert.equal(comments.length, 0);
    assert.equal(labels.length, 0);
    assert.equal(removedLabels.length, 0);
    assert.equal(notifications.count, 0);
    store.releaseLock();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recheckHeldRun reopens and ships a closed legacy hold without exhaustion proof", async () => {
  const dir = tmp();
  try {
    const store = StateStore.open(dir);
    const created = parkedRun(store);
    const legacy = store.updateRun(created.id, { status: "held" });
    const { deps, removedLabels, ships, reopened } = parkedDeps(store, {
      ci: "pass",
      issueState: "CLOSED",
      prState: "merged",
      issueLabels: ["autoship-held"],
    });

    const { rechecked } = await recheckHeldRun(deps, legacy);

    assert.equal(rechecked, true);
    assert.equal(reopened.count, 1);
    assert.deepEqual(removedLabels, ["autoship-held"]);
    assert.equal(ships.count, 1);
    assert.equal(store.getRun(legacy.id)?.status, "shipped");
    store.releaseLock();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recheckHeldRun fails closed when the issue state cannot be read", async () => {
  const dir = tmp();
  try {
    const store = StateStore.open(dir);
    const run1 = heldRun(store);
    const { deps, comments, labels, ships, reads } = parkedDeps(store, {
      ci: "pass",
      issueState: "UNKNOWN",
    });

    const { rechecked } = await recheckHeldRun(deps, run1);

    assert.equal(rechecked, false);
    assert.equal(store.getRun(run1.id)?.status, "held");
    assert.equal(reads.issueLabels, 0);
    assert.equal(ships.count, 0);
    assert.equal(comments.length, 0);
    assert.equal(labels.length, 0);
    store.releaseLock();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recheckHeldRun does not mistake a failed label read for operator approval", async () => {
  const dir = tmp();
  try {
    const store = StateStore.open(dir);
    const run1 = heldRun(store);
    const { deps, ships } = parkedDeps(store, { issueLabels: null, ci: "pass" });

    const { rechecked } = await recheckHeldRun(deps, run1);

    assert.equal(rechecked, false);
    assert.equal(store.getRun(run1.id)?.status, "held");
    assert.equal(ships.count, 0);
    store.releaseLock();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runScanOnce completes a crash-interrupted PR finalization before fresh work", async () => {
  const dir = tmp();
  try {
    const store = StateStore.open(dir);
    const pending = store.updateRun(parkedRun(store).id, {
      status: "pr_ready",
      finalizationPending: true,
    });
    const harness = parkedDeps(store, { ci: "pass" });

    const result = await runScanOnce(harness.deps);

    assert.match(result.message, /Recovered finalization/);
    assert.equal(store.getRun(pending.id)?.status, "shipped");
    assert.equal(store.getRun(pending.id)?.finalizationPending, false);
    assert.equal(harness.ships.count, 1);
    store.releaseLock();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runScanOnce resumes autoship for a stranded pr_ready capacity exit", async () => {
  const dir = tmp();
  try {
    const store = StateStore.open(dir);
    const ready = store.updateRun(parkedRun(store).id, {
      status: "pr_ready",
      exitCode: 75,
      finalizationPending: false,
    });
    const harness = parkedDeps(store, { ci: "pass" });

    const result = await runScanOnce(harness.deps);

    assert.match(result.message, /Resumed autoship for ready issue/);
    assert.equal(store.getRun(ready.id)?.status, "shipped");
    assert.equal(harness.ships.count, 1);
    store.releaseLock();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Claude is 90% through its window and Codex is 10% through its own. Cheapest-first alone
// would keep feeding Claude (haiku is the cheaper standard lane), which is exactly how a
// pool gets driven into a multi-day lockout. Scarcity weighting must move this pickup to
// Codex even though the per-attempt list price is higher.
test("runScanOnce routes away from a nearly-spent pool after reading live capacity", async () => {
  const dir = tmp();
  try {
    const store = StateStore.open(dir);
    store.setProviderSuppression("codex", {
      kind: "unconfirmed-quota",
      until: 20_000,
      authoritative: false,
      detectedAt: 1_000,
      reportedResetLabel: null,
      excerpt: "quota-like test signal",
    });
    const added: string[] = [];
    let capacityReads = 0;
    const config = {
      ...autoshipConfig({ autoshipCmd: null }),
      dryRun: false,
      worktreeDir: "/worktrees",
      authorAuth: { ok: true, mode: "none", trustedAuthors: new Set() },
    } as DispatcherConfig;
    const deps: DispatcherDeps = {
      config,
      store,
      logger: createLogger("error", () => undefined),
      notifier: { send: async () => undefined },
      github: {
        listOpenIssues: async () => ({
          ok: true,
          issues: [{
            number: 34,
            title: "claim-time routing",
            url: "https://x/34",
            labels: ["dispatch:ready", "type:bug", "priority:normal", "risk:normal"],
            authorLogin: "BourbonBaggers",
          }],
        }),
        addLabel: async (_issue: number, label: string) => {
          added.push(label);
          return true;
        },
        removeLabel: async () => true,
        issueState: async () => "OPEN",
        issueBody: async () => "Add a retry helper in src/util.ts. Expected behaviour: retries twice.",
        comment: async () => true,
      } as unknown as DispatcherDeps["github"],
      readCapacity: async (nowMs) => {
        capacityReads += 1;
        return {
          errors: new Map(),
          snapshots: new Map([
            ["claude-subscription", {
              pool: "claude-subscription",
              confidence: "provider-reported",
              observedAt: nowMs,
              windows: [{ name: "five-hour", usedPercent: 90, resetAt: nowMs + 60_000 }],
              reason: "test Claude capacity",
            }],
            ["codex-subscription", {
              pool: "codex-subscription",
              confidence: "cli-reported",
              observedAt: nowMs,
              windows: [{ name: "five-hour", usedPercent: 10, resetAt: nowMs + 60_000 }],
              reason: "test Codex capacity",
            }],
          ]),
        };
      },
      launch: async (claimed) =>
        store.updateRun(claimed.id, {
          status: "interrupted",
          exitCode: 130,
          finishedAt: 6_000,
          failureSummary: "test interruption",
        }),
      now: () => 5_000,
    };

    const result = await runScanOnce(deps);
    const claimed = store.allRuns()[0]!;
    assert.match(result.message, /Ran codex/);
    // One read at pickup, then one per escalation rung as the interrupted run climbs the
    // ladder. The scan's reading can be hours stale by the time a long run finishes, and
    // escalation is rare and expensive, so each rung re-reads rather than choosing its
    // model from a stale window. This stub interrupts every relaunch instantly, so the
    // whole ladder collapses into one scan; a real run would spread these across attempts.
    // The exact count is incidental — what matters is that it is bounded, which is only
    // true because the climb terminates at frontier.
    assert.ok(capacityReads > 1 && capacityReads <= 6, `bounded capacity reads, got ${capacityReads}`);
    assert.equal(claimed.assignedModelLabel, "model:gpt-5.6-luna");
    assert.equal(claimed.assignedEffortLabel, "effort:medium");
    assert.equal(claimed.routing?.source, "automatic");
    // The label must say scarcity moved this pick, not that Codex was the only option.
    assert.equal(claimed.routing?.capacitySelection, "scarcity-weighted");
    assert.ok(claimed.routing?.rationaleLabels.includes("route:portfolio-balance"));
    assert.equal(claimed.routing?.selectedPool, "codex-subscription");
    assert.equal(store.getSettings().lastInitialCapacityPool, "codex-subscription");
    assert.equal(store.getProviderSuppression("codex"), null);
    assert.ok(added.includes("agent:codex"));
    assert.ok(added.includes("model:gpt-5.6-luna"));
    assert.ok(added.includes("effort:medium"));
    store.releaseLock();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runScanOnce does not audit blocked issues while normal eligible work exists", async () => {
  const dir = tmp();
  try {
    const store = StateStore.open(dir);
    let audited = false;
    const deps: DispatcherDeps = {
      config: {
        ...autoshipConfig({ autoshipCmd: null }),
        dryRun: false,
        worktreeDir: "/worktrees",
        authorAuth: { ok: true, mode: "none", trustedAuthors: new Set() },
        blockedQueueAuditModel: "claude-sonnet-5",
        blockedQueueAuditEffortLabel: "effort:low",
        blockedQueueAuditMaxCandidates: 3,
      } as DispatcherConfig,
      store,
      logger: createLogger("error", () => undefined),
      notifier: { send: async () => undefined },
      github: {
        listOpenIssues: async () => ({
          ok: true,
          issues: [
            {
              number: 28,
              title: "blocked",
              url: "https://x/28",
              labels: ["blocked", "dispatch:ready", "type:bug", "priority:normal", "risk:normal"],
              authorLogin: "BourbonBaggers",
            },
            {
              number: 29,
              title: "ready",
              url: "https://x/29",
              labels: ["dispatch:ready", "type:bug", "priority:normal", "risk:normal"],
              authorLogin: "BourbonBaggers",
            },
          ],
        }),
        addLabel: async () => true,
        removeLabel: async () => true,
        issueState: async () => "OPEN",
        issueBody: async () => "Normal eligible work.",
        comment: async () => true,
      } as unknown as DispatcherDeps["github"],
      blockedQueueAuditor: async () => {
        audited = true;
        return { ok: true, workable: true, rationale: "should not run" };
      },
      launch: async (claimed) =>
        store.updateRun(claimed.id, {
          status: "interrupted",
          exitCode: 130,
          finishedAt: 6_000,
          failureSummary: "test interruption",
        }),
      now: () => 5_000,
    };

    const result = await runScanOnce(deps);

    assert.match(result.message, /Ran/);
    assert.equal(audited, false);
    assert.equal(store.allRuns()[0]?.issueNumber, 29);
    store.releaseLock();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runScanOnce never claims an interactive-held issue, and migration never re-adds dispatch:ready to it (#82)", async () => {
  const dir = tmp();
  try {
    const store = StateStore.open(dir);
    const added: Array<{ issue: number; label: string }> = [];
    const deps: DispatcherDeps = {
      config: {
        ...autoshipConfig({ autoshipCmd: null }),
        dryRun: false,
        worktreeDir: "/worktrees",
        authorAuth: { ok: true, mode: "none", trustedAuthors: new Set() },
      } as DispatcherConfig,
      store,
      logger: createLogger("error", () => undefined),
      notifier: { send: async () => undefined },
      github: {
        listOpenIssues: async () => ({
          ok: true,
          issues: [
            {
              // Full legacy characteristic labels that would otherwise migrate to
              // dispatch:ready — interactive must suppress that migration entirely.
              number: 82,
              title: "owned interactively",
              url: "https://x/82",
              labels: ["interactive", "task:feature", "risk:medium"],
              authorLogin: "BourbonBaggers",
            },
            {
              number: 90,
              title: "ready",
              url: "https://x/90",
              labels: ["dispatch:ready", "type:bug", "priority:normal", "risk:normal"],
              authorLogin: "BourbonBaggers",
            },
          ],
        }),
        addLabel: async (issue: number, label: string) => {
          added.push({ issue, label });
          return true;
        },
        removeLabel: async () => true,
        issueState: async () => "OPEN",
        issueBody: async () => "Normal eligible work.",
        comment: async () => true,
      } as unknown as DispatcherDeps["github"],
      launch: async (claimed) =>
        store.updateRun(claimed.id, {
          status: "interrupted",
          exitCode: 130,
          finishedAt: 6_000,
          failureSummary: "test interruption",
        }),
      now: () => 5_000,
    };

    const result = await runScanOnce(deps);

    assert.match(result.message, /Ran/);
    // The dispatcher never claims issue 82, and migration never derives dispatch:ready
    // (or anything else) for it while interactive is present.
    assert.equal(store.allRuns()[0]?.issueNumber, 90);
    assert.ok(!added.some((a) => a.issue === 82));
    store.releaseLock();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runScanOnce removes blocked from the first stale blocked issue without claiming it", async () => {
  const dir = tmp();
  try {
    const store = StateStore.open(dir);
    const removed: Array<{ issue: number; label: string }> = [];
    const comments: Array<{ issue: number; body: string }> = [];
    let audits = 0;
    const deps: DispatcherDeps = {
      config: {
        ...autoshipConfig({ autoshipCmd: null }),
        dryRun: false,
        worktreeDir: "/worktrees",
        authorAuth: { ok: true, mode: "none", trustedAuthors: new Set() },
        blockedQueueAuditModel: "claude-sonnet-5",
        blockedQueueAuditEffortLabel: "effort:low",
        blockedQueueAuditMaxCandidates: 3,
      } as DispatcherConfig,
      store,
      logger: createLogger("error", () => undefined),
      notifier: { send: async () => undefined },
      github: {
        listOpenIssues: async () => ({
          ok: true,
          issues: [
            {
              number: 28,
              title: "blocked after deps",
              url: "https://x/28",
              labels: ["blocked", "dispatch:ready"],
              authorLogin: "BourbonBaggers",
            },
            {
              number: 29,
              title: "also blocked",
              url: "https://x/29",
              labels: ["blocked", "dispatch:ready"],
              authorLogin: "BourbonBaggers",
            },
          ],
        }),
        issueBody: async (issue: number) =>
          issue === 28 ? "Blocked by #26 and #27." : "Blocked by #26.",
        issueState: async () => "CLOSED",
        removeLabel: async (issue: number, label: string) => {
          removed.push({ issue, label });
          return true;
        },
        comment: async (issue: number, body: string) => {
          comments.push({ issue, body });
          return true;
        },
      } as unknown as DispatcherDeps["github"],
      blockedQueueAuditor: async (_prompt, config) => {
        audits += 1;
        assert.equal(config.model.cliModel, "claude-sonnet-5");
        assert.equal(config.cliEffort, "low");
        return { ok: true, workable: true, rationale: "all referenced blockers are closed" };
      },
      launch: async () => {
        throw new Error("audit path must not claim or launch");
      },
      now: () => 5_000,
    };

    const result = await runScanOnce(deps);

    assert.match(result.message, /Removed stale blocked label from issue #28/);
    assert.deepEqual(removed, [{ issue: 28, label: "blocked" }]);
    assert.equal(comments.length, 1);
    assert.match(comments[0]!.body, /Blocked queue audit/);
    assert.match(comments[0]!.body, /#26:CLOSED, #27:CLOSED/);
    assert.equal(audits, 1);
    assert.equal(store.allRuns().length, 0);
    store.releaseLock();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runScanOnce keeps unclear blocked issues held and can continue within the bound", async () => {
  const dir = tmp();
  try {
    const store = StateStore.open(dir);
    const removed: number[] = [];
    const auditedIssues: number[] = [];
    const deps: DispatcherDeps = {
      config: {
        ...autoshipConfig({ autoshipCmd: null }),
        dryRun: false,
        worktreeDir: "/worktrees",
        authorAuth: { ok: true, mode: "none", trustedAuthors: new Set() },
        blockedQueueAuditModel: "claude-sonnet-5",
        blockedQueueAuditEffortLabel: "effort:low",
        blockedQueueAuditMaxCandidates: 2,
      } as DispatcherConfig,
      store,
      logger: createLogger("error", () => undefined),
      notifier: { send: async () => undefined },
      github: {
        listOpenIssues: async () => ({
          ok: true,
          issues: [
            {
              number: 28,
              title: "unclear",
              url: "https://x/28",
              labels: ["blocked", "dispatch:ready"],
              authorLogin: "BourbonBaggers",
            },
            {
              number: 29,
              title: "stale",
              url: "https://x/29",
              labels: ["blocked", "dispatch:ready"],
              authorLogin: "BourbonBaggers",
            },
          ],
        }),
        issueBody: async (issue: number) =>
          issue === 28 ? "Blocked by #26." : "Blocked by #27.",
        issueState: async (issue: number) => (issue === 26 ? "UNKNOWN" : "CLOSED"),
        removeLabel: async (issue: number) => {
          removed.push(issue);
          return true;
        },
        comment: async () => true,
      } as unknown as DispatcherDeps["github"],
      blockedQueueAuditor: async (prompt) => {
        const parsed = JSON.parse(prompt.split("\n").at(-1)!) as { issue: { number: number } };
        auditedIssues.push(parsed.issue.number);
        return { ok: true, workable: true, rationale: "closed" };
      },
      now: () => 5_000,
    };

    const result = await runScanOnce(deps);

    assert.match(result.message, /issue #29/);
    assert.deepEqual(auditedIssues, [28, 29]);
    assert.deepEqual(removed, [29]);
    assert.equal(store.allRuns().length, 0);
    store.releaseLock();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runScanOnce fails closed when blocked-label removal fails", async () => {
  const dir = tmp();
  try {
    const store = StateStore.open(dir);
    let comments = 0;
    const deps: DispatcherDeps = {
      config: {
        ...autoshipConfig({ autoshipCmd: null }),
        dryRun: false,
        worktreeDir: "/worktrees",
        authorAuth: { ok: true, mode: "none", trustedAuthors: new Set() },
        blockedQueueAuditModel: "claude-sonnet-5",
        blockedQueueAuditEffortLabel: "effort:low",
        blockedQueueAuditMaxCandidates: 1,
      } as DispatcherConfig,
      store,
      logger: createLogger("error", () => undefined),
      notifier: { send: async () => undefined },
      github: {
        listOpenIssues: async () => ({
          ok: true,
          issues: [{
            number: 28,
            title: "blocked after deps",
            url: "https://x/28",
            labels: ["blocked", "dispatch:ready"],
            authorLogin: "BourbonBaggers",
          }],
        }),
        issueBody: async () => "Blocked by #26.",
        issueState: async () => "CLOSED",
        removeLabel: async () => false,
        comment: async () => {
          comments += 1;
          return true;
        },
      } as unknown as DispatcherDeps["github"],
      blockedQueueAuditor: async () => ({
        ok: true,
        workable: true,
        rationale: "all blockers closed",
      }),
      now: () => 5_000,
    };

    const result = await runScanOnce(deps);

    assert.match(result.message, /could not update issue #28/);
    assert.equal(comments, 0);
    assert.equal(store.allRuns().length, 0);
    store.releaseLock();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recheckHeldRun is a no-op while the issue still carries autoship-held", async () => {
  const dir = tmp();
  try {
    const store = StateStore.open(dir);
    const run1 = heldRun(store);
    // A current-version hold has durable proof that the full ladder was exhausted.
    const { deps, comments, labels, ships } = parkedDeps(store, {
      ci: "pass",
      issueLabels: ["autoship-held"],
    });

    const { rechecked } = await recheckHeldRun(deps, run1);

    assert.equal(rechecked, false, "a still-held run must not be resumed");
    assert.equal(store.getRun(run1.id)?.status, "held");
    assert.equal(ships.count, 0, "the ship command must not run while still held");
    assert.equal(comments.length, 0);
    assert.equal(labels.length, 0);
    store.releaseLock();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recheckHeldRun automatically clears a legacy hold with no exhaustion proof", async () => {
  const dir = tmp();
  try {
    const store = StateStore.open(dir);
    const created = parkedRun(store);
    const legacy = store.updateRun(created.id, { status: "held" });
    const { deps, removedLabels, ships } = parkedDeps(store, {
      ci: "pass",
      issueLabels: ["autoship-held"],
    });

    const { rechecked } = await recheckHeldRun(deps, legacy);

    assert.equal(rechecked, true);
    assert.ok(removedLabels.includes("autoship-held"));
    assert.equal(ships.count, 1);
    assert.equal(store.getRun(legacy.id)?.status, "shipped");
    store.releaseLock();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recheckHeldRun resumes autoship and ships once autoship-held is cleared, without relaunching the agent", async () => {
  const dir = tmp();
  try {
    const store = StateStore.open(dir);
    const run1 = heldRun(store);
    // Human approved: the autoship-held label is gone (issueLabels default []).
    const { deps, ships } = parkedDeps(store, { ci: "pass" });

    const { rechecked } = await recheckHeldRun(deps, run1);

    assert.equal(rechecked, true);
    assert.equal(store.getRun(run1.id)?.status, "shipped");
    assert.equal(ships.count, 1, "the existing ready PR is merged + deployed exactly once");
    store.releaseLock();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recheckHeldRun on an un-held already-merged PR deploys and verifies it", async () => {
  const dir = tmp();
  try {
    const store = StateStore.open(dir);
    const run1 = heldRun(store);
    // The human merged the PR by hand instead of un-holding, then cleared the label.
    const { deps, labels, ships } = parkedDeps(store, { ci: "pass", prState: "merged" });

    const { rechecked } = await recheckHeldRun(deps, run1);

    assert.equal(rechecked, true);
    assert.equal(store.getRun(run1.id)?.status, "shipped");
    assert.equal(ships.count, 1, "an already-merged PR still needs deployment verification");
    assert.ok(!labels.includes("autoship-held"));
    store.releaseLock();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
