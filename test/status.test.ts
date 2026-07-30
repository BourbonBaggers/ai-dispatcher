import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../src/state.ts";
import {
  historySnapshot,
  renderHistoryHuman,
  renderStatusHuman,
  runHistoryCommand,
  runStatusCommand,
  statusSnapshot,
  statusSnapshotWithGithub,
} from "../src/status.ts";
import { appendRunOutputEntry } from "../src/run-output.ts";
import { runOutputPath } from "../src/state.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "ai-dispatcher-status-"));
}

function claimData(issueNumber: number) {
  return {
    issueNumber,
    issueTitle: `issue ${issueNumber}`,
    issueUrl: `https://github.com/acme/widgets/issues/${issueNumber}`,
    agent: "codex" as const,
    modelLabel: "model:gpt-5.5",
    cliModel: "gpt-5.5",
    effortLabel: "effort:medium",
    cliEffort: "medium",
    branch: `issue-${issueNumber}-x`,
    checkoutPath: `/w/issue-${issueNumber}-x`,
    planPath: null,
    trigger: "poll" as const,
  };
}

async function collectStatus(args: string[], env: NodeJS.ProcessEnv = {}) {
  let stdout = "";
  let stderr = "";
  const code = await runStatusCommand(
    args,
    env,
    (s) => {
      stdout += s;
    },
    (s) => {
      stderr += s;
    },
  );
  return { code, stdout, stderr };
}

function collectHistory(args: string[], env: NodeJS.ProcessEnv = {}) {
  let stdout = "";
  let stderr = "";
  const code = runHistoryCommand(
    args,
    env,
    (s) => {
      stdout += s;
    },
    (s) => {
      stderr += s;
    },
  );
  return { code, stdout, stderr };
}

test("status is offline and does not create missing state", () => {
  const dir = join(tmpdir(), `ai-dispatcher-missing-${Date.now()}-${process.pid}`);
  assert.equal(existsSync(dir), false);
  const snapshot = statusSnapshot(dir);
  assert.equal(renderStatusHuman(snapshot), "offline");
  assert.equal(existsSync(dir), false);
});

test("idle human status is exactly terse when the dispatcher is live with no run", () => {
  const dir = tmp();
  try {
    const store = StateStore.open(dir);
    assert.equal(renderStatusHuman(statusSnapshot(dir)), "idle");
    store.releaseLock();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("status surfaces GitHub agent-working when durable state has no current claim", async () => {
  const dir = tmp();
  try {
    const store = StateStore.open(dir);
    const old = store.createRun(claimData(3));
    store.updateRun(old.id, { status: "shipped", phase: "verifying", finishedAt: 2 });
    store.releaseLock();

    const snapshot = await statusSnapshotWithGithub(dir, null, async (_file, args) => {
      assert.deepEqual(args.slice(0, 8), [
        "issue",
        "list",
        "--repo",
        "acme/widgets",
        "--state",
        "open",
        "--label",
        "agent-working",
      ]);
      return {
        ok: true,
        stdout: JSON.stringify([
          {
            number: 513,
            title: "OMS rows need paid state",
            url: "https://github.com/acme/widgets/issues/513",
            labels: [{ name: "agent-working" }],
          },
        ]),
        stderr: "",
        code: 0,
      };
    });

    const human = renderStatusHuman(snapshot);
    assert.match(human, /^attention:/);
    assert.match(human, /no durable claiming run, but GitHub has agent-working/);
    assert.match(human, /issue: #513 OMS rows need paid state/);
    assert.match(human, /pr-search: gh pr list --repo acme\/widgets --state all --search "513"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("status warns when durable active work lacks the GitHub working label", async () => {
  const dir = tmp();
  try {
    const store = StateStore.open(dir);
    const run = store.createRun(claimData(7));
    store.updateRun(run.id, { status: "running", phase: "agent_working" });
    store.releaseLock();

    const snapshot = await statusSnapshotWithGithub(dir, "acme/widgets", async () => ({
      ok: true,
      stdout: "[]",
      stderr: "",
      code: 0,
    }));

    const human = renderStatusHuman(snapshot);
    assert.match(human, /^active:/);
    assert.match(human, /github: agent-working label is absent on current issue/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("durable claimed work is active even when the dispatcher process is offline", () => {
  const dir = tmp();
  try {
    const store = StateStore.open(dir);
    const run = store.createRun(claimData(7));
    store.updateRun(run.id, { status: "ci_pending", phase: "waiting_ci", prNumber: 12 });
    store.releaseLock();

    const human = renderStatusHuman(statusSnapshot(dir));
    assert.match(human, /^active:/);
    assert.match(human, /service: offline/);
    assert.match(human, /phase: waiting_ci/);
    assert.match(human, /inspect: gh pr view 12 --repo acme\/widgets --checks/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("status json is versioned and maps old runs without a phase", () => {
  const dir = tmp();
  try {
    writeFileSync(
      join(dir, "state.json"),
      JSON.stringify({
        version: 1,
        settings: { claudeSuppressedUntil: null, codexSuppressedUntil: null },
        runs: [
          {
            id: "run-1",
            ...claimData(9),
            status: "running",
            assignedAgent: "codex",
            assignedModelLabel: "model:gpt-5.5",
            assignedCliModel: "gpt-5.5",
            assignedEffortLabel: "effort:medium",
            assignedCliEffort: "medium",
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
            createdAt: 1,
            startedAt: 1,
            finishedAt: null,
          },
        ],
      }),
    );
    const snapshot = statusSnapshot(dir);
    assert.equal(snapshot.version, 1);
    assert.equal(snapshot.current?.phase, "agent_working");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("history is newest first and honors a positive limit", () => {
  const dir = tmp();
  try {
    const store = StateStore.open(dir);
    const older = store.createRun(claimData(1));
    store.updateRun(older.id, { status: "shipped", phase: "verifying", finishedAt: 2, createdAt: 1 });
    const newer = store.createRun(claimData(2));
    store.updateRun(newer.id, {
      status: "pr_ready",
      phase: "publishing",
      finishedAt: 4,
      createdAt: 3,
      prNumber: 22,
      prUrl: "https://github.com/acme/widgets/pull/22",
      lastCommit: "abc123",
    });
    store.releaseLock();

    const history = historySnapshot(dir, 1);
    assert.equal(history.version, 1);
    assert.equal(history.runs.length, 1);
    assert.equal(history.runs[0]?.issue.number, 2);
    assert.match(renderHistoryHuman(history), /PR #22/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("history rejects non-positive limits", () => {
  const result = collectHistory(["--limit", "0"]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /positive integer/);
});

test("status --follow replays available output and stops at a handoff", async () => {
  const dir = tmp();
  try {
    const store = StateStore.open(dir);
    const run = store.createRun(claimData(5));
    appendRunOutputEntry(dir, {
      version: 1,
      runId: run.id,
      seq: 1,
      timestamp: 10,
      type: "phase",
      stream: "control",
      phase: "agent_working",
      message: "Agent provider started.",
    });
    appendRunOutputEntry(dir, {
      version: 1,
      runId: run.id,
      seq: 2,
      timestamp: 11,
      type: "output",
      stream: "stdout",
      line: "rendered redacted line",
    });
    store.updateRun(run.id, { status: "pr_ready", phase: "publishing", outputSeq: 2 });
    store.releaseLock();

    const result = await collectStatus(["--state-dir", dir, "--follow"]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /active:/);
    assert.match(result.stdout, /\[phase:agent_working\] Agent provider started\./);
    assert.match(result.stdout, /rendered redacted line/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("status --json --follow emits newline-delimited versioned events", async () => {
  const dir = tmp();
  try {
    const store = StateStore.open(dir);
    const run = store.createRun(claimData(6));
    appendRunOutputEntry(dir, {
      version: 1,
      runId: run.id,
      seq: 1,
      timestamp: 10,
      type: "lifecycle",
      stream: "control",
      status: "pr_ready",
      message: "done",
    });
    store.updateRun(run.id, { status: "pr_ready", outputSeq: 1 });
    store.releaseLock();

    const result = await collectStatus(["--state-dir", dir, "--json", "--follow"]);
    assert.equal(result.code, 0);
    const lines = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(lines.length, 1);
    assert.equal(lines[0].version, 1);
    assert.equal(lines[0].event.type, "lifecycle");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run output artifacts are pruned with discarded run records", () => {
  const dir = tmp();
  try {
    const store = StateStore.open(dir);
    const keep = store.createRun(claimData(1));
    store.updateRun(keep.id, { status: "shipped", phase: "verifying", finishedAt: 2 });
    const drop = store.createRun(claimData(2));
    store.updateRun(drop.id, { status: "shipped", phase: "verifying", finishedAt: 3 });
    appendRunOutputEntry(dir, {
      version: 1,
      runId: keep.id,
      seq: 1,
      timestamp: 1,
      type: "lifecycle",
      stream: "control",
      status: "shipped",
      message: null,
    });
    appendRunOutputEntry(dir, {
      version: 1,
      runId: drop.id,
      seq: 1,
      timestamp: 1,
      type: "lifecycle",
      stream: "control",
      status: "shipped",
      message: null,
    });

    store.pruneRuns(new Set([keep.id]));
    assert.equal(existsSync(runOutputPath(dir, keep.id)), true);
    assert.equal(existsSync(runOutputPath(dir, drop.id)), false);
    store.releaseLock();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
