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
import type {
  GithubBranchPullRequest,
  GithubCreatedIssue,
  GithubLabelSpec,
  GithubPrDiff,
  GithubPrFile,
} from "../src/github.ts";
import type { CheckoutSnapshot } from "../src/run-reconciliation.ts";
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
    assert.equal(handoff.value.modelLabel, "model:gpt-6-sol");
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
  /** When set, GitHub also answers prChecksEvidence; read at call time, so tests can mutate it. */
  checkCount?: number | null;
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
      ...(opts.checkCount === undefined
        ? {}
        : {
          prChecksEvidence: async () => ({
            state: opts.ci ?? "pending",
            checkCount: opts.checkCount ?? null,
          }),
        }),
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
      prDiff: async () => ({ state: "ok", diff: "" }),
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

test("a parked run whose CI did not start stays parked without relaunching or spending recovery (#96)", async () => {
  const dir = tmp();
  try {
    const store = StateStore.open(dir);
    const run1 = parkedRun(store);
    // gh's "no checks reported on the '<branch>' branch", as GithubClient now reads it.
    const { deps, ships, comments } = parkedDeps(store, { ci: "pending", checkCount: 0 });
    let launches = 0;
    deps.launch = async (relaunched) => {
      launches += 1;
      return relaunched;
    };

    await recheckParkedRun(deps, run1);

    const after = store.getRun(run1.id)!;
    assert.equal(after.status, "ci_pending");
    assert.deepEqual(after.recovery, {});
    assert.equal(typeof after.ciChecksFirstObservedAt, "number", "the grace clock started");
    assert.equal(launches, 0);
    assert.equal(ships.count, 0);
    assert.equal(comments.length, 0);
    store.releaseLock();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the missing-checks grace restarts once checks appear, so a later empty read spends no recovery (#96)", async () => {
  const dir = tmp();
  try {
    const store = StateStore.open(dir);
    const stale = Date.now() - 10 * 60 * 1000;
    const run1 = store.updateRun(parkedRun(store).id, { ciChecksFirstObservedAt: stale });
    const github = { ci: "pending" as const, checkCount: 2 as number | null };
    let launches = 0;
    const first = parkedDeps(store, github);
    first.deps.launch = async (relaunched) => {
      launches += 1;
      return relaunched;
    };

    await recheckParkedRun(first.deps, run1);
    assert.equal(store.getRun(run1.id)?.ciChecksFirstObservedAt, undefined, "a suite exists: that absence is over");

    // Restart: the cleared start must not come back from disk.
    store.releaseLock();
    const restarted = StateStore.open(dir);
    assert.equal(restarted.getRun(run1.id)?.ciChecksFirstObservedAt, undefined);

    // A new head commit (say, a repair push) has no checks registered yet.
    github.checkCount = 0;
    const second = parkedDeps(restarted, github);
    second.deps.launch = first.deps.launch;
    await recheckParkedRun(second.deps, restarted.getRun(run1.id)!);

    const after = restarted.getRun(run1.id)!;
    assert.equal(after.status, "ci_pending");
    assert.deepEqual(after.recovery, {}, "a fresh absence must not spend a CI repair attempt");
    assert.ok((after.ciChecksFirstObservedAt ?? 0) > stale, "a fresh grace began");
    assert.equal(launches, 0);
    assert.equal(first.ships.count + second.ships.count, 0);
    restarted.releaseLock();
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

test("merged PR infrastructure failure backs off without launching an agent", async () => {
  const dir = tmp();
  try {
    const store = StateStore.open(dir);
    const parked = parkedRun(store);
    const { deps, ships } = parkedDeps(store, {
      prState: "merged",
      shipResult: { ok: false, stdout: "", stderr: "PROD_SSH_HOST is required", code: 1 },
    });
    await recheckParkedRun(deps, parked);
    const retry = store.getRun(parked.id)!;
    assert.equal(retry.status, "ci_pending");
    assert.equal(retry.deployRetry?.attempts, 1);
    assert.deepEqual(retry.mergedDelivery, { pr: parked.prNumber, sha: "merged" });
    assert.equal(ships.count, 1);
    await recheckParkedRun(deps, retry);
    assert.equal(ships.count, 1, "the next probe waits for the durable backoff");
    assert.equal(retry.recovery?.deploy?.attempts ?? 0, 0);
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
      cliModel: "claude-opus-5-5",
      recovery: { ci: { attempts: 2, escalated: true, rung: {
        modelLabel: "model:claude-opus-5.5", cliModel: "claude-opus-5-5",
        effortLabel: "effort:max", reason: "final attempt", at: 1000,
      } } },
    });
    const { deps, comments, labels, notifications } = parkedDeps(store, { ci: "fail" });
    deps.config.ciEscalationModel = "claude-opus-5-5";

    await recheckParkedRun(deps, exhausted);

    assert.equal(store.getRun(exhausted.id)?.status, "held");
    assert.ok(labels.includes("autoship-held"));
    assert.equal(notifications.count, 1, "one final operator page");
    assert.match(comments.at(-1) ?? "", /Dispatcher exhausted/i);
    assert.match(comments.at(-1) ?? "", /Final attempt: `claude-opus-5-5`/);
    assert.doesNotMatch(comments.at(-1) ?? "", /Final attempt: `gpt-5.6-sol`/);
    store.releaseLock();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a non-frontier final model cannot create a false exhaustion hold", async () => {
  const dir = tmp();
  try {
    const store = StateStore.open(dir);
    const created = parkedRun(store);
    const current = store.updateRun(created.id, {
      cliModel: "gpt-5.6-sol",
      recovery: { ci: { attempts: 2, escalated: true } },
    });
    const { deps, labels } = parkedDeps(store, { ci: "fail" });
    deps.config.ciEscalationModel = "claude-opus-5-5";
    const launched: string[] = [];
    deps.launch = async (retry) => {
      launched.push(retry.cliModel);
      return store.updateRun(retry.id, { status: "abandoned" });
    };
    await recheckParkedRun(deps, current);
    assert.deepEqual(launched, ["claude-opus-5-5"]);
    assert.ok(!labels.includes("autoship-held"));
    assert.equal(store.getRun(current.id)?.exhaustion, undefined);
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

test("recheckHeldRun reopens a prematurely closed issue and verifies its merged PR", async () => {
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

    assert.equal(rechecked, true);
    assert.equal(store.getRun(run1.id)?.status, "shipped");
    assert.equal(reopened.count, 1, "closure without verified production is repaired");
    assert.equal(reads.issueLabels, 1);
    assert.equal(ships.count, 1);
    assert.equal(comments.length, 0);
    assert.equal(labels.length, 0);
    assert.deepEqual(removedLabels, ["autoship-held"]);
    assert.equal(notifications.count, 1);
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

// Codex is nearly through its window and Claude has ample headroom. Cheapest-first alone
// would keep feeding Codex (GPT-6 Luna is the cheaper standard lane), which is exactly how
// a pool gets driven into a multi-day lockout. Scarcity weighting must move this pickup to
// Claude even though the per-attempt list price is higher.
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
              windows: [{ name: "five-hour", usedPercent: 20, resetAt: nowMs + 60_000 }],
              reason: "test Claude capacity",
            }],
            ["codex-subscription", {
              pool: "codex-subscription",
              confidence: "cli-reported",
              observedAt: nowMs,
              windows: [{ name: "five-hour", usedPercent: 99, resetAt: nowMs + 60_000 }],
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
    assert.match(result.message, /Ran claude/);
    // One read at pickup, then one per escalation rung as the interrupted run climbs the
    // ladder. The scan's reading can be hours stale by the time a long run finishes, and
    // escalation is rare and expensive, so each rung re-reads rather than choosing its
    // model from a stale window. This stub interrupts every relaunch instantly, so the
    // whole ladder collapses into one scan; a real run would spread these across attempts.
    // The exact count is incidental — what matters is that it is bounded, which is only
    // true because the climb terminates at frontier.
    assert.ok(capacityReads > 1 && capacityReads <= 6, `bounded capacity reads, got ${capacityReads}`);
    assert.equal(claimed.assignedModelLabel, "model:claude-haiku-4.5");
    assert.equal(claimed.assignedEffortLabel, "effort:medium");
    assert.equal(claimed.routing?.source, "automatic");
    // The label must say scarcity moved this pick, not that Claude was the only option.
    assert.equal(claimed.routing?.capacitySelection, "scarcity-weighted");
    assert.ok(claimed.routing?.rationaleLabels.includes("route:portfolio-balance"));
    assert.equal(claimed.routing?.selectedPool, "claude-subscription");
    assert.equal(store.getSettings().lastInitialCapacityPool, "claude-subscription");
    assert.equal(store.getProviderSuppression("codex"), null);
    assert.ok(added.includes("agent:claude"));
    assert.ok(added.includes("model:claude-haiku-4.5"));
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

test("recheckHeldRun completes a merged PR already in production despite a stale hold", async () => {
  const dir = tmp();
  try {
    const store = StateStore.open(dir);
    const held = heldRun(store);
    const run1 = store.updateRun(held.id, { mergedDelivery: { pr: held.prNumber!, sha: "merged" } });
    const { deps, removedLabels, ships } = parkedDeps(store, {
      ci: "pass", prState: "merged", issueLabels: ["autoship-held"],
    });
    const result = await recheckHeldRun(deps, run1);
    assert.equal(result.rechecked, true);
    assert.equal(ships.count, 1);
    assert.equal(store.getRun(run1.id)?.status, "shipped");
    assert.ok(removedLabels.includes("autoship-held"));
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

// ── post-ship audit retries (#98: backoff, a cap, and a terminal state) ─────────

const AUDIT_START = 10_000_000;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

interface AuditSweepHarness {
  deps: DispatcherDeps;
  clock: { now: number };
  /** Every attempt reads the issue body first, so this counts attempts. */
  bodyReads: number[];
  judgeCalls: { count: number };
  logs: Array<{ level: string; msg: string } & Record<string, unknown>>;
}

function auditSweepHarness(
  store: StateStore,
  opts: {
    issueBody?: () => Promise<string | null>;
    prDiff?: () => Promise<GithubPrDiff>;
    prFiles?: () => Promise<GithubPrFile[] | null>;
    createIssue?: () => Promise<GithubCreatedIssue>;
    createLabel?: (spec: GithubLabelSpec) => Promise<boolean>;
    judge?: DispatcherDeps["judgeAcceptance"];
  } = {},
): AuditSweepHarness {
  const clock = { now: AUDIT_START };
  const bodyReads: number[] = [];
  const judgeCalls = { count: 0 };
  const logs: AuditSweepHarness["logs"] = [];
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
    logger: createLogger("info", (line) => logs.push(JSON.parse(line))),
    notifier: { send: async () => undefined },
    github: {
      // An idle queue: the audit sweep is the only work these scans can do.
      listOpenIssues: async () => ({ ok: true, issues: [] }),
      issueBody: async () => {
        bodyReads.push(clock.now);
        return opts.issueBody
          ? opts.issueBody()
          : ["## Acceptance criteria", "- [ ] Retries back off", "- [ ] Tests cover it"].join("\n");
      },
      issueLabels: async () => [],
      prDiff: opts.prDiff ?? (async () => ({ state: "ok", diff: "+export const backoff = true;" })),
      prFiles: opts.prFiles ?? (async () => null),
      issuesWithLabel: async () => [],
      createIssue: opts.createIssue ?? (async () => ({ ok: false, error: "no follow-up expected" })),
      createLabel: opts.createLabel ?? (async () => false),
      comment: async () => true,
    } as unknown as DispatcherDeps["github"],
    judgeAcceptance: async (request) => {
      judgeCalls.count += 1;
      return opts.judge
        ? opts.judge(request)
        : request.criteria.map((criterion) => ({ criterion, result: "addressed" as const }));
    },
    readCapacity: async () => ({ snapshots: new Map(), errors: new Map() }),
    blockedQueueAuditor: async () => {
      throw new Error("an empty queue has no blocked candidates to audit");
    },
    now: () => clock.now,
  };
  return { deps, clock, bodyReads, judgeCalls, logs };
}

/** A shipped run whose audit was queued exactly as releases before #98 queued it. */
function shippedRunAwaitingAudit(store: StateStore): RunRecord {
  const created = store.createRun({
    issueNumber: 737,
    issueTitle: "Delete plan files for closed issues",
    issueUrl: "https://x/737",
    agent: "codex",
    modelLabel: "model:gpt-5.5",
    cliModel: "gpt-5.5",
    effortLabel: "effort:medium",
    cliEffort: "medium",
    branch: "issue-737-x",
    checkoutPath: "/w/issue-737-x",
    planPath: null,
    trigger: "poll",
  });
  return store.updateRun(created.id, {
    status: "shipped",
    prNumber: 760,
    prUrl: "https://x/pull/760",
    finishedAt: AUDIT_START,
    audit: { status: "pending", at: AUDIT_START },
  });
}

test("an unreadable audit backs off with growing delays, never calls the judge, and goes terminal at the cap (#98)", async () => {
  const dir = tmp();
  try {
    const store = StateStore.open(dir);
    const shipped = shippedRunAwaitingAudit(store);
    const h = auditSweepHarness(store, { issueBody: async () => null });

    // Scan every 20 seconds — faster than any production interval — for 52 hours, which
    // spans every backoff window.
    const end = AUDIT_START + 52 * HOUR_MS;
    for (; h.clock.now <= end; h.clock.now += 20_000) await runScanOnce(h.deps);

    const gaps = h.bodyReads.slice(1).map((at, index) => at - h.bodyReads[index]!);
    assert.equal(h.bodyReads.length, 6, "the cap bounds attempts, not the scan count");
    assert.deepEqual(gaps, [5 * MINUTE_MS, 30 * MINUTE_MS, 2 * HOUR_MS, 24 * HOUR_MS, 24 * HOUR_MS]);
    assert.equal(h.judgeCalls.count, 0, "no evidence, no judge call");

    const audit = store.getRun(shipped.id)?.audit;
    assert.equal(audit?.status, "unavailable");
    assert.equal(audit?.attempts, 6);
    assert.equal(audit?.reason, "gave up after 6 attempts: could not read the issue body");

    const terminal = h.logs.filter((line) => line.msg === "audit: giving up; marked unavailable");
    assert.equal(terminal.length, 1, "one clear line when the audit goes terminal");
    assert.equal(terminal[0]!.level, "warn");
    assert.equal(terminal[0]!.issue, 737);
    assert.equal(terminal[0]!.reason, audit?.reason);

    // Terminal is final: a year of further scans makes no attempt.
    h.clock.now += 365 * 24 * HOUR_MS;
    await runScanOnce(h.deps);
    assert.equal(h.bodyReads.length, 6);
    // The audit never touched delivery: the run is still shipped and claims nothing.
    assert.equal(store.getRun(shipped.id)?.status, "shipped");
    store.releaseLock();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an audit that fails once and then reads its evidence resolves normally (#98)", async () => {
  const dir = tmp();
  try {
    const store = StateStore.open(dir);
    const shipped = shippedRunAwaitingAudit(store);
    let readable = false;
    const h = auditSweepHarness(store, {
      issueBody: async () =>
        readable ? ["## Acceptance criteria", "- [ ] Retries back off"].join("\n") : null,
    });

    await runScanOnce(h.deps);
    assert.equal(store.getRun(shipped.id)?.audit?.attempts, 1);
    assert.equal(store.getRun(shipped.id)?.audit?.nextAttemptAt, AUDIT_START + 5 * MINUTE_MS);
    assert.ok(
      h.logs.some((line) => line.msg === "audit: attempt failed; retrying after backoff" && line.attempt === 1),
    );

    readable = true;
    h.clock.now = AUDIT_START + 4 * MINUTE_MS;
    await runScanOnce(h.deps);
    assert.equal(h.bodyReads.length, 1, "still inside the first backoff window");

    h.clock.now = AUDIT_START + 5 * MINUTE_MS;
    await runScanOnce(h.deps);
    assert.equal(h.judgeCalls.count, 1);
    assert.deepEqual(store.getRun(shipped.id)?.audit, { status: "done", at: AUDIT_START + 5 * MINUTE_MS });
    store.releaseLock();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a thrown audit attempt is counted and backed off instead of retried every scan (#98)", async () => {
  const dir = tmp();
  try {
    const store = StateStore.open(dir);
    const shipped = shippedRunAwaitingAudit(store);
    const h = auditSweepHarness(store, {
      issueBody: async () => {
        throw new Error("gh vanished");
      },
    });

    for (let scan = 0; scan < 10; scan += 1, h.clock.now += 20_000) await runScanOnce(h.deps);

    assert.equal(h.bodyReads.length, 1);
    const audit = store.getRun(shipped.id)?.audit;
    assert.equal(audit?.status, "pending");
    assert.equal(audit?.attempts, 1);
    assert.equal(audit?.reason, "audit threw: gh vanished");
    store.releaseLock();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// #737 in production: its PR deleted 302 files, GitHub refuses the diff, and the audit was
// retried every scan for hours. A record queued before #98 now resolves on its first sweep.
test("a legacy pending audit whose diff is too large resolves from the changed-file list (#98)", async () => {
  const dir = tmp();
  try {
    const store = StateStore.open(dir);
    const shipped = shippedRunAwaitingAudit(store);
    const judged: string[] = [];
    const h = auditSweepHarness(store, {
      prDiff: async () => ({
        state: "too_large",
        error: "could not find pull request diff: HTTP 406: Sorry, the diff exceeded the maximum number of files (300).",
      }),
      prFiles: async () => [
        { filename: "scripts/lib/plan-discovery.sh", status: "modified", additions: 9, deletions: 1, patch: "@@ -1 +1,9 @@\n+rm_plan" },
        ...Array.from({ length: 302 }, (_, index) => ({
          filename: `docs/plans/plan-${index}.md`,
          status: "removed",
          additions: 0,
          deletions: 40,
        })),
      ],
      judge: async (request) => {
        judged.push(request.evidence);
        return request.criteria.map((criterion) => ({ criterion, result: "addressed" as const }));
      },
    });

    await runScanOnce(h.deps);

    assert.deepEqual(judged, ["changed-files"]);
    assert.deepEqual(store.getRun(shipped.id)?.audit, { status: "done", at: AUDIT_START });
    assert.ok(h.logs.some((line) => line.msg === "audit: PR diff too large; auditing its changed-file list"));
    store.releaseLock();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A judge that is sure one criterion was never attempted, so the audit files work. */
const confidentOmission: NonNullable<DispatcherDeps["judgeAcceptance"]> = async (request) =>
  request.criteria.map((criterion) => ({
    criterion,
    result: "not_addressed" as const,
    citation: "nothing in the diff targets this",
  }));

// #728 in production: the judge reached a verdict, filing the follow-up failed the same way
// every time, and each retry bought another ~48-second judge call — once a minute at a
// 60-second scan interval.
test("a follow-up creation that fails the same way twice goes terminal after two judge calls (#98)", async () => {
  const dir = tmp();
  try {
    const store = StateStore.open(dir);
    const shipped = shippedRunAwaitingAudit(store);
    let creations = 0;
    const h = auditSweepHarness(store, {
      judge: confidentOmission,
      createIssue: async () => {
        creations += 1;
        return { ok: false, error: "GraphQL: Title is too long (maximum is 256 characters) (createIssue)" };
      },
    });
    const judgeCalls = (): number => h.judgeCalls.count;

    await runScanOnce(h.deps);
    assert.equal(judgeCalls(), 1);
    assert.equal(store.getRun(shipped.id)?.audit?.status, "pending");

    // Scans every 20 seconds inside the five-minute backoff buy nothing.
    for (h.clock.now += 20_000; h.clock.now < AUDIT_START + 5 * MINUTE_MS; h.clock.now += 20_000) {
      await runScanOnce(h.deps);
    }
    assert.equal(judgeCalls(), 1);

    h.clock.now = AUDIT_START + 5 * MINUTE_MS;
    await runScanOnce(h.deps);
    assert.equal(judgeCalls(), 2);
    const audit = store.getRun(shipped.id)?.audit;
    assert.equal(audit?.status, "unavailable");
    assert.equal(
      audit?.reason,
      "failed the same way twice: follow-up issue could not be created: " +
        "GraphQL: Title is too long (maximum is 256 characters) (createIssue)",
    );

    for (let day = 1; day <= 7; day += 1) {
      h.clock.now = AUDIT_START + day * 24 * HOUR_MS;
      await runScanOnce(h.deps);
    }
    assert.equal(judgeCalls(), 2, "terminal: no further judge calls, ever");
    assert.equal(creations, 2);
    assert.equal(h.logs.filter((line) => line.msg === "audit: giving up; marked unavailable").length, 1);
    store.releaseLock();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The actual #728 cause: the target repository lacked `audit-followup` and `audit:depth-1`.
test("a repository missing the audit's labels gets them and files the follow-up on the first attempt (#98)", async () => {
  const dir = tmp();
  try {
    const store = StateStore.open(dir);
    const shipped = shippedRunAwaitingAudit(store);
    const repoLabels = new Set(["dispatch:ready"]);
    const created: string[] = [];
    const h = auditSweepHarness(store, {
      judge: confidentOmission,
      createIssue: async () => {
        for (const label of ["audit-followup", "audit:depth-1", "dispatch:ready"]) {
          if (!repoLabels.has(label)) {
            return { ok: false, error: `could not add label: '${label}' not found`, missingLabel: label };
          }
        }
        return { ok: true, issue: 801 };
      },
      createLabel: async (spec) => {
        if (!repoLabels.has(spec.name)) created.push(spec.name);
        repoLabels.add(spec.name);
        return true;
      },
    });

    await runScanOnce(h.deps);

    assert.deepEqual(created, ["audit-followup", "audit:depth-1"]);
    assert.equal(h.judgeCalls.count, 1);
    assert.deepEqual(store.getRun(shipped.id)?.audit, {
      status: "done",
      at: AUDIT_START,
      followUpIssue: 801,
    });
    store.releaseLock();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── reconcile before relaunch (#109) ──────────────────────────────────────────
//
// internal-tools #773: every launch ended `interrupted` (launcher exit 75) while PR #787
// sat open, mergeable, and green, and the resume cap turned those relaunches into model
// "exhaustion". A branch that already carries its finished work must resume autoship.

const PR_HEAD = "7ac045908c2a1670d34675f0ddde19d54b2942e8";

function branchPr(overrides: Partial<GithubBranchPullRequest> = {}): GithubBranchPullRequest {
  return {
    number: 42,
    state: "open",
    isDraft: false,
    headRefOid: PR_HEAD,
    url: "https://github.com/o/r/pull/42",
    ...overrides,
  };
}

/** A finished checkout: HEAD is the PR head, nothing uncommitted, every milestone [DONE]. */
function finishedCheckout(overrides: Partial<Extract<CheckoutSnapshot, { state: "present" }>> = {}): CheckoutSnapshot {
  return {
    state: "present",
    head: PR_HEAD,
    dirty: [],
    plan: { path: "docs/plans/2026-10-01-issue1-x.md", total: 4, done: 4 },
    ...overrides,
  };
}

/** The #773 shape: the launcher's unpublished-work exit after a clean provider exit. */
function interruptedRun(store: StateStore, overrides: Partial<RunRecord> = {}): RunRecord {
  return store.updateRun(parkedRun(store).id, {
    status: "interrupted",
    phase: "recovering",
    exitCode: 75,
    failureSummary: "The launcher found unpublished work. Resume this checkout to commit or push it.",
    finalizationPending: false,
    ...overrides,
  });
}

function reconcileHarness(store: StateStore, opts: {
  prs?: GithubBranchPullRequest[] | null;
  checkout?: CheckoutSnapshot;
  published?: boolean | null;
  ci?: "pass" | "pending" | "fail" | "unknown";
  isDraft?: boolean;
  mergeStateStatus?: string;
} = {}) {
  const parked = parkedDeps(store, { ci: opts.ci ?? "pass", ...(opts.isDraft === undefined ? {} : { isDraft: opts.isDraft }) });
  const launched: RunRecord[] = [];
  const promotions = { count: 0 };
  const github = parked.deps.github as unknown as Record<string, unknown>;
  const prMergeInfo = github.prMergeInfo as () => Promise<Record<string, unknown>>;
  const deps: DispatcherDeps = {
    ...parked.deps,
    config: {
      ...autoshipConfig(),
      dryRun: false,
      worktreeDir: "/w",
      authorAuth: { ok: true, mode: "none", trustedAuthors: new Set() },
    } as DispatcherConfig,
    github: {
      ...github,
      branchPullRequests: async () => (opts.prs === undefined ? [branchPr()] : opts.prs),
      prMergeInfo: async () => ({
        ...(await prMergeInfo()),
        headRefOid: PR_HEAD,
        mergeStateStatus: opts.mergeStateStatus ?? "CLEAN",
      }),
      markPrReady: async () => {
        promotions.count += 1;
        return true;
      },
    } as unknown as DispatcherDeps["github"],
    inspectCheckout: {
      inspect: async () => opts.checkout ?? finishedCheckout(),
      headContainedIn: async () => opts.published ?? true,
    },
    readCapacity: async () => ({ snapshots: new Map(), errors: new Map() }),
    repairGeneratedConflicts: async () => ({
      ok: false,
      conflictPaths: ["src/feature.ts"],
      decision: null,
      reason: "conflicts are not generated-only",
    }),
    launch: async (relaunched) => {
      launched.push(relaunched);
      return store.updateRun(relaunched.id, { status: "abandoned", finishedAt: 6_000 });
    },
  };
  return { ...parked, deps, launched, promotions };
}

test("a resumable run whose branch has a finished green PR ships it without launching a model (#109)", async () => {
  const dir = tmp();
  try {
    const store = StateStore.open(dir);
    const run1 = interruptedRun(store);
    const h = reconcileHarness(store);

    const result = await runScanOnce(h.deps);

    const after = store.getRun(run1.id)!;
    assert.match(result.message, /already has its finished work on PR #42; resumed autoship without relaunching/);
    assert.equal(h.launched.length, 0, "no agent relaunch");
    assert.equal(h.ships.count, 1, "autoship merges and deploys the existing PR");
    assert.equal(after.status, "shipped");
    assert.equal(after.prNumber, 42);
    assert.deepEqual(after.recovery, {}, "no repair or frontier budget spent");
    assert.equal(after.resumeCount, 0, "no resume budget spent");
    assert.equal(after.exhaustion, undefined);
    assert.equal(after.reconciledDelivery?.basis, "agent-finished");
    assert.ok(h.removedLabels.includes("agent-working"));
    assert.ok(!h.labels.includes("autoship-held"));
    assert.match(h.comments[0] ?? "", /^## Dispatcher: finished work found on PR #42/);
    store.releaseLock();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a reconciled PR whose checks are pending waits, parked, without a launch (#109)", async () => {
  const dir = tmp();
  try {
    const store = StateStore.open(dir);
    const run1 = interruptedRun(store);
    const h = reconcileHarness(store, { ci: "pending" });

    await runScanOnce(h.deps);

    const after = store.getRun(run1.id)!;
    assert.equal(after.status, "ci_pending");
    assert.equal(after.prNumber, 42);
    assert.equal(h.launched.length, 0);
    assert.equal(h.ships.count, 0);
    assert.deepEqual(after.recovery, {});

    // The parked recheck keeps trusting the reconciled delivery once checks go green.
    const green = reconcileHarness(store, { ci: "pass" });
    await recheckParkedRun(green.deps, after);
    assert.equal(store.getRun(run1.id)?.status, "shipped");
    store.releaseLock();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a reconciled PR with red checks takes the CI repair path and keeps its PR (#109)", async () => {
  const dir = tmp();
  try {
    const store = StateStore.open(dir);
    const run1 = interruptedRun(store, { cliModel: "claude-opus-5-5", modelLabel: "model:claude-opus-5.5" });
    const h = reconcileHarness(store, { ci: "fail" });

    await runScanOnce(h.deps);

    assert.equal(h.launched.length, 1, "one CI repair launch");
    const repair = h.launched[0]!;
    assert.equal(repair.prNumber, 42, "the PR association survives the repair");
    assert.equal(repair.recovery?.ci?.attempts, 1, "a real red check spends CI repair budget");
    assert.equal(repair.recovery?.agent, undefined, "nothing is charged to the agent phase");
    assert.equal(repair.cliModel, "claude-sonnet-5", "repairs return to the immutable assigned model");
    assert.match(repair.failureSummary ?? "", /PR #42 CI is still failing/);
    assert.equal(store.getRun(run1.id)?.reconciledDelivery, undefined, "the relaunch supersedes the evidence");
    store.releaseLock();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a reconciled PR with merge conflicts takes the merge repair path and keeps its PR (#109)", async () => {
  const dir = tmp();
  try {
    const store = StateStore.open(dir);
    interruptedRun(store);
    const h = reconcileHarness(store, { mergeStateStatus: "DIRTY" });

    await runScanOnce(h.deps);

    assert.equal(h.launched.length, 1, "one merge repair launch");
    assert.equal(h.launched[0]!.prNumber, 42);
    assert.equal(h.launched[0]!.recovery?.merge?.attempts, 1);
    assert.match(h.launched[0]!.failureSummary ?? "", /PR #42 merge-conflict recovery failed/);
    assert.equal(h.ships.count, 0);
    store.releaseLock();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a reconciled draft PR is promoted and shipped, keeping its PR (#109)", async () => {
  const dir = tmp();
  try {
    const store = StateStore.open(dir);
    const run1 = interruptedRun(store);
    const h = reconcileHarness(store, { prs: [branchPr({ isDraft: true })], isDraft: true });

    await runScanOnce(h.deps);

    assert.equal(h.promotions.count, 1, "the draft is marked ready");
    assert.equal(store.getRun(run1.id)?.status, "shipped");
    assert.equal(h.launched.length, 0);
    store.releaseLock();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a resumable run with no PR still resumes its saved checkout (#109)", async () => {
  const dir = tmp();
  try {
    const store = StateStore.open(dir);
    const run1 = interruptedRun(store, { exitCode: 143, prNumber: null, prUrl: null });
    const h = reconcileHarness(store, { prs: [] });

    const result = await runScanOnce(h.deps);

    assert.match(result.message, /Resumed the interrupted run on issue #1/);
    assert.equal(h.launched.length, 1);
    assert.equal(h.launched[0]!.id, run1.id, "the same run record, branch, and checkout");
    assert.equal(h.launched[0]!.trigger, "resume");
    assert.equal(h.launched[0]!.resumeCount, 1);
    assert.equal(h.ships.count, 0);
    assert.equal(h.comments.length, 0);
    store.releaseLock();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unpublished work is resumed, never shipped: a dirty tail or unpushed commits relaunch the checkout (#109)", async () => {
  for (const [label, opts] of [
    ["dirty tail", { checkout: finishedCheckout({ head: "1".repeat(40), dirty: [" M src/feature.ts"] }) }],
    ["unpushed commit", { checkout: finishedCheckout({ head: "1".repeat(40) }), published: false }],
  ] as const) {
    const dir = tmp();
    try {
      const store = StateStore.open(dir);
      const run1 = interruptedRun(store);
      const h = reconcileHarness(store, opts);

      const result = await runScanOnce(h.deps);

      assert.match(result.message, /Resumed the interrupted run/, label);
      assert.equal(h.launched.length, 1, label);
      assert.equal(h.ships.count, 0, `${label}: the PR lacks local work, so it must not ship`);
      assert.equal(h.launched[0]!.prNumber, 42, label);
      assert.equal(store.getRun(run1.id)?.reconciledDelivery, undefined, label);
      store.releaseLock();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("an unreadable GitHub neither relaunches nor charges the resumable run (#109)", async () => {
  const dir = tmp();
  try {
    const store = StateStore.open(dir);
    const run1 = interruptedRun(store);
    const h = reconcileHarness(store, { prs: null });

    const result = await runScanOnce(h.deps);

    assert.match(result.message, /Could not reconcile issue #1 with GitHub/);
    assert.equal(h.launched.length, 0);
    const after = store.getRun(run1.id)!;
    assert.equal(after.status, "interrupted");
    assert.equal(after.resumeCount, 0);
    assert.deepEqual(after.recovery, {});
    store.releaseLock();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a restart-interrupted run with a finished plan ships on reconciliation evidence alone (#109)", async () => {
  const dir = tmp();
  try {
    const store = StateStore.open(dir);
    // reconcile() leaves no exit code and, before any result line, no PR on the record.
    const run1 = interruptedRun(store, { exitCode: null, prNumber: null, prUrl: null });
    const h = reconcileHarness(store);

    await runScanOnce(h.deps);

    const after = store.getRun(run1.id)!;
    assert.equal(after.status, "shipped");
    assert.equal(after.prNumber, 42);
    assert.equal(after.reconciledDelivery?.basis, "plan-complete");
    assert.equal(h.launched.length, 0);
    store.releaseLock();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed exit after the plan was finished and published delivers instead of charging the model ladder (#109)", async () => {
  const dir = tmp();
  try {
    const store = StateStore.open(dir);
    const failed = store.updateRun(parkedRun(store).id, {
      status: "failed",
      exitCode: 1,
      failureSummary: "The agent exited with code 1.",
      finalizationPending: true,
    });
    const h = reconcileHarness(store);

    await finalizeRun(h.deps, failed);

    const after = store.getRun(failed.id)!;
    assert.equal(after.status, "shipped");
    assert.equal(after.recovery?.agent, undefined, "no model failure was recorded");
    assert.equal(h.launched.length, 0);
    store.releaseLock();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed exit on unfinished work still enters the agent repair ladder (#109)", async () => {
  const dir = tmp();
  try {
    const store = StateStore.open(dir);
    const failed = store.updateRun(parkedRun(store).id, {
      status: "failed",
      exitCode: 1,
      failureSummary: "The agent exited with code 1.",
      finalizationPending: true,
    });
    const h = reconcileHarness(store, {
      checkout: finishedCheckout({ plan: { path: "p.md", total: 4, done: 2 } }),
    });

    await finalizeRun(h.deps, failed);

    assert.equal(h.launched.length, 1);
    assert.equal(h.launched[0]!.recovery?.agent?.attempts, 1);
    assert.equal(h.ships.count, 0);
    store.releaseLock();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed exit that cannot be reconciled stays pending and charges nothing (#109)", async () => {
  const dir = tmp();
  try {
    const store = StateStore.open(dir);
    const failed = store.updateRun(parkedRun(store).id, {
      status: "failed",
      exitCode: 1,
      failureSummary: "The agent exited with code 1.",
      finalizationPending: true,
    });
    const h = reconcileHarness(store, { prs: null });

    await finalizeRun(h.deps, failed);

    const after = store.getRun(failed.id)!;
    assert.equal(after.status, "failed");
    assert.equal(after.finalizationPending, true, "the next scan finishes this finalization");
    assert.deepEqual(after.recovery, {});
    assert.equal(h.launched.length, 0);
    store.releaseLock();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── interruptions are infrastructure, never model failures (#109) ─────────────

const LAUNCHER_UNPUBLISHED = "The launcher found unpublished work. Resume this checkout to commit or push it.";

/** Every launch is interrupted by the launcher's unpublished-work recovery, like #773. */
function interruptionHarness(
  store: StateStore,
  clock: { now: number },
  opts: Parameters<typeof reconcileHarness>[1] = {},
) {
  const h = reconcileHarness(store, opts);
  const notifications: string[] = [];
  const deps: DispatcherDeps = {
    ...h.deps,
    config: { ...h.deps.config, ciEscalationModel: "claude-opus-5-5" } as DispatcherConfig,
    github: {
      ...(h.deps.github as unknown as Record<string, unknown>),
      listOpenIssues: async () => ({ ok: true, issues: [] }),
    } as unknown as DispatcherDeps["github"],
    notifier: {
      send: async (title: string) => {
        notifications.push(title);
      },
    },
    now: () => clock.now,
    launch: async (relaunched) => {
      h.launched.push(relaunched);
      return store.updateRun(relaunched.id, {
        status: "interrupted",
        phase: "recovering",
        exitCode: 75,
        failureSummary: LAUNCHER_UNPUBLISHED,
        finishedAt: clock.now,
        finalizationPending: true,
      });
    },
  };
  return { ...h, deps, notifications };
}

test("repeated launcher interruptions never charge the model ladder: one frontier rung, then a back-off, never a hold (#109)", async () => {
  const dir = tmp();
  try {
    const store = StateStore.open(dir);
    const clock = { now: 10_000_000 };
    // The assigned rung already spent its resumes; the checkout keeps a tail the agent
    // declines to commit, so reconciliation can never deliver and every launch is interrupted.
    const run1 = interruptedRun(store, {
      resumeCount: MAX_AUTO_RESUMES,
      attemptNumber: 4,
      interruptions: {
        count: 4,
        byModel: { "claude-sonnet-5": 4 },
        lastAttempt: 4,
        lastReason: LAUNCHER_UNPUBLISHED,
        lastAt: 1,
      },
    });
    const h = interruptionHarness(store, clock, {
      checkout: finishedCheckout({ dirty: ["?? coverage/"] }),
    });
    const backoffComments = () => h.comments.filter((c) => /agent launches keep being interrupted/.test(c));

    // Assigned rung spent: one move to the frontier rung, recorded as interruptions.
    const escalated = await runScanOnce(h.deps);
    assert.match(escalated.message, /Moved interrupted issue #1 to the frontier model; no model failure was recorded/);
    assert.equal(h.launched.length, 1);
    assert.equal(h.launched[0]!.cliModel, "claude-opus-5-5");
    assert.equal(h.launched[0]!.recovery?.agent?.attempts, 0, "no repair attempt is fabricated");
    assert.match(h.launched[0]!.recovery?.agent?.rung?.reason ?? "", /interrupted 4 times/);
    assert.match(h.launched[0]!.failureSummary ?? "", /Last interruption: The launcher found unpublished work/);

    // The frontier rung's own resumes are interrupted too.
    for (let scan = 0; scan < MAX_AUTO_RESUMES; scan += 1) {
      assert.match((await runScanOnce(h.deps)).message, /Resumed the interrupted run/);
    }
    assert.equal(h.launched.length, 4);

    // Frontier rung spent: back off, with one accurate comment -- no hold, no page.
    const backoff = await runScanOnce(h.deps);
    assert.match(backoff.message, /keeps being interrupted; retrying after/);
    let after = store.getRun(run1.id)!;
    assert.equal(after.status, "interrupted", "the claim is retained");
    assert.deepEqual(after.interruptions?.byModel, { "claude-sonnet-5": 4, "claude-opus-5-5": 4 });
    assert.equal(after.interruptions?.count, 8);
    assert.equal(after.interruptions?.stalls, 1);
    assert.equal(after.interruptions?.retryAfter, clock.now + 60 * 60_000);
    assert.equal(backoffComments().length, 1);
    assert.match(backoffComments()[0]!, /interrupted 8 times \(`claude-sonnet-5` ×4, `claude-opus-5-5` ×4\)/);

    // While backing off it never blocks other work.
    assert.match((await runScanOnce(h.deps)).message, /No eligible issues/);
    assert.equal(h.launched.length, 4);

    // After the back-off: exactly one more launch, then a longer back-off and no new comment.
    clock.now += 60 * 60_000;
    assert.match((await runScanOnce(h.deps)).message, /Retried interrupted issue #1 after its back-off/);
    assert.equal(h.launched.length, 5);
    assert.equal(store.getRun(run1.id)?.interruptions?.retryAfter, undefined);
    await runScanOnce(h.deps);
    after = store.getRun(run1.id)!;
    assert.equal(after.interruptions?.stalls, 2);
    assert.equal(after.interruptions?.retryAfter, clock.now + 4 * 60 * 60_000);
    assert.equal(backoffComments().length, 1);

    // Throughout: no model failure, no exhaustion, no hold, no page.
    assert.equal(after.recovery?.agent?.attempts, 0);
    assert.equal(after.exhaustion, undefined);
    assert.ok(!h.labels.includes("autoship-held"));
    assert.deepEqual(h.notifications, []);
    assert.ok(h.comments.every((c) => !/exhausted/i.test(c)));
    store.releaseLock();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a resume-capped run whose branch already has its finished PR ships instead of escalating (#109)", async () => {
  const dir = tmp();
  try {
    const store = StateStore.open(dir);
    const clock = { now: 10_000_000 };
    const run1 = interruptedRun(store, { resumeCount: MAX_AUTO_RESUMES, attemptNumber: 4 });
    const h = interruptionHarness(store, clock);

    const result = await runScanOnce(h.deps);

    assert.match(result.message, /already has its finished work on PR #42/);
    const after = store.getRun(run1.id)!;
    assert.equal(after.status, "shipped");
    assert.equal(h.launched.length, 0, "neither an escalation nor a resume");
    assert.deepEqual(after.recovery, {});
    assert.deepEqual(h.notifications, ["Shipped #1: a thing"]);
    store.releaseLock();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("each interrupted launch is counted once, including restarts and replayed finalizations (#109)", async () => {
  const dir = tmp();
  try {
    const store = StateStore.open(dir);
    const clock = { now: 10_000_000 };
    const h = interruptionHarness(store, clock);
    const inFlight = store.updateRun(parkedRun(store).id, { status: "running", attemptNumber: 3, prNumber: null });

    reconcile({ ...h.deps, processCommand: () => null });
    const restarted = store.getRun(inFlight.id)!;
    assert.equal(restarted.status, "interrupted");
    assert.equal(restarted.interruptions?.count, 1);
    assert.equal(restarted.interruptions?.lastAttempt, 3);
    assert.match(restarted.interruptions?.lastReason ?? "", /dispatcher restarted/);

    // The next launch is interrupted, and its finalization is replayed after a crash.
    const next = store.updateRun(inFlight.id, {
      attemptNumber: 4,
      exitCode: 143,
      failureSummary: "The agent process was interrupted by signal (exit 143).",
      finalizationPending: true,
    });
    await finalizeRun(h.deps, next);
    await finalizeRun(h.deps, store.getRun(inFlight.id)!);
    const after = store.getRun(inFlight.id)!;
    assert.equal(after.interruptions?.count, 2);
    assert.deepEqual(after.interruptions?.byModel, { "claude-sonnet-5": 2 });
    assert.deepEqual(after.recovery, {}, "never charged as a model failure");
    store.releaseLock();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a resumable run's comment says an interruption spends no repair budget (#109)", () => {
  const comment = buildIssueComment(run({ status: "interrupted" }), true);
  assert.match(comment, /If the branch's PR already carries the finished work, autoship takes it over instead/);
  assert.match(comment, /An interruption is not a model failure and spends no repair budget/);
});
