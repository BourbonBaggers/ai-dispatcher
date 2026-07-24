import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore, LockHeldError, StateCorruptionError } from "../src/state.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "ai-dispatcher-state-"));
}

function claimData(issueNumber: number) {
  return {
    issueNumber,
    issueTitle: `issue ${issueNumber}`,
    issueUrl: `https://x/${issueNumber}`,
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

test("createRun claims an issue and persists across reopen", () => {
  const dir = tmp();
  try {
    const store = StateStore.open(dir);
    const run = store.createRun(claimData(1));
    assert.equal(run.status, "claimed");
    store.releaseLock();

    const reopened = StateStore.open(dir);
    assert.equal(reopened.allRuns().length, 1);
    assert.equal(reopened.claimingRunsByIssue().get(1), "claimed");
    reopened.releaseLock();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createRun refuses a second active run (serial execution)", () => {
  const dir = tmp();
  try {
    const store = StateStore.open(dir);
    store.createRun(claimData(1));
    assert.throws(() => store.createRun(claimData(2)), /serial/);
    store.releaseLock();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createRun refuses to double-claim the same issue even after it is resumable", () => {
  const dir = tmp();
  try {
    const store = StateStore.open(dir);
    const run = store.createRun(claimData(1));
    store.updateRun(run.id, { status: "interrupted", finishedAt: Date.now() });
    // no active run now, but the issue still has a claiming (resumable) run
    assert.equal(store.activeRun(), null);
    assert.throws(() => store.createRun(claimData(1)), /already has a claiming run/);
    // a different issue is fine
    assert.doesNotThrow(() => store.createRun(claimData(2)));
    store.releaseLock();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the single-instance lock blocks a second live opener", () => {
  const dir = tmp();
  try {
    const first = StateStore.open(dir);
    assert.throws(() => StateStore.open(dir), LockHeldError);
    first.releaseLock();
    // after release, opening succeeds
    const second = StateStore.open(dir);
    second.releaseLock();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a stale lock from a dead pid is reclaimed", () => {
  const dir = tmp();
  try {
    // pid 2^31-1 is almost certainly not a live process
    writeFileSync(join(dir, "dispatcher.lock"), JSON.stringify({ pid: 2147483646 }));
    const store = StateStore.open(dir); // should not throw
    store.releaseLock();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a lock whose pid was reused by another process identity is reclaimed", () => {
  const dir = tmp();
  try {
    writeFileSync(
      join(dir, "dispatcher.lock"),
      JSON.stringify({ pid: process.pid, processIdentity: "not-this-process" }),
    );
    const store = StateStore.open(dir);
    store.releaseLock();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("concurrent stale-lock reclaimers cannot both become dispatchers", async () => {
  const dir = tmp();
  const ready = join(dir, "ready");
  const start = join(dir, "start");
  const release = join(dir, "release");
  const winners = join(dir, "winners");
  const fixture = join(import.meta.dirname, "fixtures", "lock-contender.mjs");
  try {
    writeFileSync(join(dir, "dispatcher.lock"), JSON.stringify({ pid: 2147483646 }));
    const launch = () =>
      new Promise<number | null>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [fixture, dir, ready, start, release, winners],
          { stdio: "ignore" },
        );
        child.once("error", reject);
        child.once("close", resolve);
      });
    const children = [launch(), launch(), launch(), launch()];
    for (;;) {
      const count = existsSync(ready)
        ? readFileSync(ready, "utf8").trim().split("\n").filter(Boolean).length
        : 0;
      if (count === children.length) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    writeFileSync(start, "");
    await new Promise((resolve) => setTimeout(resolve, 500));
    writeFileSync(release, "");
    const exits = await Promise.all(children);
    const acquired = existsSync(winners)
      ? readFileSync(winners, "utf8").trim().split("\n").filter(Boolean)
      : [];
    assert.equal(acquired.length, 1);
    assert.equal(exits.filter((code) => code === 0).length, 1);
    assert.equal(exits.filter((code) => code === 2).length, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("suppression windows round-trip", () => {
  const dir = tmp();
  try {
    const store = StateStore.open(dir);
    store.setSuppressedUntil("claude", 12345);
    assert.equal(store.getSettings().claudeSuppressedUntil, 12345);
    assert.equal(store.getSettings().codexSuppressedUntil, null);
    store.releaseLock();

    const reopened = StateStore.open(dir);
    assert.equal(reopened.getSettings().claudeSuppressedUntil, 12345);
    reopened.releaseLock();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resumableRuns returns only interrupted/timed_out/token_exhausted, oldest-first", () => {
  const dir = tmp();
  try {
    const store = StateStore.open(dir);
    const a = store.createRun(claimData(1));
    store.updateRun(a.id, { status: "timed_out", createdAt: 100 });
    const b = store.createRun(claimData(2));
    store.updateRun(b.id, { status: "shipped" });
    const c = store.createRun(claimData(3));
    store.updateRun(c.id, { status: "interrupted", createdAt: 50 });

    const resumable = store.resumableRuns();
    assert.deepEqual(
      resumable.map((r) => r.issueNumber),
      [3, 1], // createdAt 50 then 100
    );
    store.releaseLock();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parkedRuns returns only ci_pending runs, oldest-first", () => {
  const dir = tmp();
  try {
    const store = StateStore.open(dir);
    const a = store.createRun(claimData(1));
    store.updateRun(a.id, { status: "ci_pending", createdAt: 100 });
    const b = store.createRun(claimData(2));
    store.updateRun(b.id, { status: "shipped" });
    const c = store.createRun(claimData(3));
    store.updateRun(c.id, { status: "ci_pending", createdAt: 50 });

    const parked = store.parkedRuns();
    assert.deepEqual(
      parked.map((r) => r.issueNumber),
      [3, 1], // createdAt 50 then 100
    );
    store.releaseLock();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("heldRuns returns only held runs, and a held run still holds its claim (#10)", () => {
  const dir = tmp();
  try {
    const store = StateStore.open(dir);
    const a = store.createRun(claimData(1));
    store.updateRun(a.id, { status: "held", createdAt: 100 });
    const b = store.createRun(claimData(2));
    store.updateRun(b.id, { status: "shipped" });
    const c = store.createRun(claimData(3));
    store.updateRun(c.id, { status: "held", createdAt: 50 });

    assert.deepEqual(
      store.heldRuns().map((r) => r.issueNumber),
      [3, 1], // createdAt 50 then 100
    );
    // A held run keeps its claim so the issue is not re-dispatched from scratch while a
    // human decides — clearing autoship-held resumes autoship of the ready PR instead.
    assert.equal(store.claimingRunsByIssue().get(1), "held");
    assert.equal(store.claimingRunsByIssue().get(3), "held");
    // A shipped run, by contrast, releases its claim.
    assert.equal(store.claimingRunsByIssue().has(2), false);
    store.releaseLock();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pr_ready retains its issue claim without becoming resumable or parked", () => {
  const dir = tmp();
  try {
    const store = StateStore.open(dir);
    const run = store.createRun(claimData(7));
    store.updateRun(run.id, { status: "pr_ready" });

    assert.equal(store.claimingRunsByIssue().get(7), "pr_ready");
    assert.deepEqual(store.resumableRuns(), []);
    assert.deepEqual(store.parkedRuns(), []);
    store.releaseLock();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("terminal finalization checkpoints and immutable assignment survive restart", () => {
  const dir = tmp();
  try {
    const store = StateStore.open(dir);
    const run = store.createRun(claimData(8));
    assert.equal(run.assignedCliModel, "gpt-5.5");
    store.updateRun(run.id, {
      status: "pr_ready",
      cliModel: "claude-opus-4-8",
      finalizationPending: true,
    });
    store.releaseLock();

    const reopened = StateStore.open(dir);
    assert.equal(reopened.pendingFinalizations()[0]?.id, run.id);
    assert.equal(reopened.getRun(run.id)?.assignedCliModel, "gpt-5.5");
    reopened.releaseLock();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy succeeded rows are re-finalized as unverified PR handoffs", () => {
  const dir = tmp();
  try {
    const store = StateStore.open(dir);
    const run = store.createRun(claimData(10));
    store.releaseLock();
    const statePath = join(dir, "state.json");
    const raw = JSON.parse(readFileSync(statePath, "utf8")) as {
      runs: Array<Record<string, unknown>>;
    };
    raw.runs[0]!.status = "succeeded";
    writeFileSync(statePath, JSON.stringify(raw));

    const reopened = StateStore.open(dir);
    assert.equal(reopened.getRun(run.id)?.status, "pr_ready");
    assert.equal(reopened.getRun(run.id)?.finalizationPending, true);
    reopened.releaseLock();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy shipped rows without a recovery ledger are reverified after closure races", () => {
  const dir = tmp();
  try {
    const store = StateStore.open(dir);
    const run = store.createRun(claimData(11));
    store.releaseLock();
    const statePath = join(dir, "state.json");
    const raw = JSON.parse(readFileSync(statePath, "utf8")) as {
      runs: Array<Record<string, unknown>>;
    };
    raw.runs[0]!.status = "shipped";
    delete raw.runs[0]!.recovery;
    writeFileSync(statePath, JSON.stringify(raw));

    const reopened = StateStore.open(dir);
    assert.equal(reopened.getRun(run.id)?.status, "pr_ready");
    assert.equal(reopened.getRun(run.id)?.finalizationPending, true);
    reopened.releaseLock();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("duplicate legacy successes collapse to the newest delivery verification per issue", () => {
  const dir = tmp();
  try {
    const store = StateStore.open(dir);
    const older = store.createRun(claimData(12));
    store.updateRun(older.id, { status: "shipped", createdAt: 1 });
    const newer = store.createRun(claimData(12));
    store.updateRun(newer.id, { status: "shipped", createdAt: 2 });
    store.releaseLock();
    const statePath = join(dir, "state.json");
    const raw = JSON.parse(readFileSync(statePath, "utf8")) as {
      runs: Array<Record<string, unknown>>;
    };
    for (const row of raw.runs) delete row.recovery;
    writeFileSync(statePath, JSON.stringify(raw));

    const reopened = StateStore.open(dir);
    assert.deepEqual(reopened.pendingFinalizations().map((run) => run.id), [newer.id]);
    assert.equal(reopened.getRun(older.id)?.status, "abandoned");
    reopened.releaseLock();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a corrupt primary state recovers durable claims from its atomic backup", () => {
  const dir = tmp();
  try {
    const original = StateStore.open(dir);
    const run = original.createRun(claimData(99));
    original.updateRun(run.id, { status: "ci_pending" });
    original.releaseLock();
    writeFileSync(join(dir, "state.json"), "{ not valid json ");
    const recovered = StateStore.open(dir);
    assert.equal(recovered.getRun(run.id)?.status, "ci_pending");
    assert.ok(readdirSync(dir).some((name) => name.startsWith("state.json.corrupt-")));
    recovered.releaseLock();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("valid JSON with no runs ledger is corruption, not an empty queue", () => {
  const dir = tmp();
  try {
    const original = StateStore.open(dir);
    const run = original.createRun(claimData(101));
    original.updateRun(run.id, { status: "ci_pending" });
    original.releaseLock();
    writeFileSync(join(dir, "state.json"), "{}");

    const recovered = StateStore.open(dir);

    assert.equal(recovered.getRun(run.id)?.status, "ci_pending");
    recovered.releaseLock();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unrecoverable state corruption fails closed and releases the instance lock", () => {
  const dir = tmp();
  try {
    const original = StateStore.open(dir);
    original.createRun(claimData(100));
    original.releaseLock();
    writeFileSync(join(dir, "state.json"), "{ bad primary ");
    writeFileSync(join(dir, "state.json.backup"), "{ bad backup ");
    assert.throws(() => StateStore.open(dir), StateCorruptionError);
    assert.equal(existsSync(join(dir, "dispatcher.lock")), false);
    assert.throws(() => StateStore.open(dir), StateCorruptionError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy CI/deploy recovery fields migrate into the unified ledger", () => {
  const dir = tmp();
  try {
    const store = StateStore.open(dir);
    store.createRun(claimData(7));
    store.releaseLock();

    const statePath = join(dir, "state.json");
    const raw = JSON.parse(readFileSync(statePath, "utf8")) as {
      runs: Array<Record<string, unknown>>;
    };
    delete raw.runs[0]!.recovery;
    raw.runs[0]!.ciSelfHealAttempts = 2;
    raw.runs[0]!.ciEscalated = true;
    raw.runs[0]!.deployEscalated = true;
    writeFileSync(statePath, JSON.stringify(raw));

    const reopened = StateStore.open(dir);
    assert.deepEqual(reopened.allRuns()[0]!.recovery, {
      ci: { attempts: 2, escalated: true },
      deploy: { attempts: 0, escalated: true },
    });
    reopened.releaseLock();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("frontier exhaustion proof persists across restart", () => {
  const dir = tmp();
  try {
    const store = StateStore.open(dir);
    const run = store.createRun(claimData(9));
    store.updateRun(run.id, {
      status: "held",
      exhaustion: { kind: "deploy", reason: "rollback failed", at: 12345 },
    });
    store.releaseLock();

    const reopened = StateStore.open(dir);
    assert.deepEqual(reopened.getRun(run.id)?.exhaustion, {
      kind: "deploy",
      reason: "rollback failed",
      at: 12345,
    });
    reopened.releaseLock();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
