import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  createCheckoutHousekeeping,
  lastActivityAt,
  listCheckoutDirs,
  processesUsing,
  readDiskUsage,
  unpushedCommits,
  type CheckoutHousekeepingOptions,
} from "../src/checkout-cleanup.ts";
import { GIB, type DiskUsage, type ProcessUse } from "../src/checkout-retention.ts";
import { run as execRun, type ExecFn } from "../src/exec.ts";
import { createLogger } from "../src/logger.ts";
import type { RunRecord } from "../src/state.ts";

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "init.defaultBranch=main", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

interface Fixture {
  root: string;
  worktreeDir: string;
  remote: string;
  mirror: string;
}

/** A bare "GitHub" remote, the mirror the launcher clones from, and an empty worktree dir. */
function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "ai-dispatcher-checkouts-"));
  const remote = join(root, "remote.git");
  const seed = join(root, "seed");
  git(root, "init", "-q", "--bare", remote);
  git(root, "init", "-q", seed);
  writeFileSync(join(seed, "README.md"), "seed\n");
  git(seed, "add", "README.md");
  git(seed, "commit", "-q", "-m", "seed");
  git(seed, "push", "-q", remote, "HEAD:main");
  const mirror = join(root, "mirror");
  git(root, "clone", "-q", remote, mirror);
  const worktreeDir = join(root, "worktrees");
  mkdirSync(worktreeDir);
  return { root, worktreeDir, remote, mirror };
}

/** A checkout made the way dispatch-agent.sh makes one, holding one pushed commit. */
function checkout(f: Fixture, branch: string, opts: { unpushed?: number } = {}): string {
  const dir = join(f.worktreeDir, branch);
  git(f.root, "clone", "-q", f.mirror, dir);
  git(dir, "remote", "set-url", "origin", f.remote);
  git(dir, "fetch", "-q", "origin", "main");
  git(dir, "checkout", "-q", "-b", branch, "origin/main");
  writeFileSync(join(dir, "work.txt"), `${branch}\n`);
  git(dir, "add", "work.txt");
  git(dir, "commit", "-q", "-m", `work for ${branch}`);
  git(dir, "push", "-q", "-u", "origin", branch);
  for (let i = 0; i < (opts.unpushed ?? 0); i += 1) {
    writeFileSync(join(dir, `local-${i}.txt`), "local\n");
    git(dir, "add", `local-${i}.txt`);
    git(dir, "commit", "-q", "-m", `local ${i}`);
  }
  return dir;
}

/** Backdates every modification time under `path`, as if it had sat untouched for `ms`. */
function age(path: string, ms: number): void {
  const when = new Date(Date.now() - ms);
  const visit = (current: string): void => {
    const info = lstatSync(current);
    if (info.isSymbolicLink()) return;
    if (info.isDirectory()) for (const name of readdirSync(current)) visit(join(current, name));
    utimesSync(current, when, when);
  };
  visit(path);
}

function runFor(dir: string, overrides: Partial<RunRecord> = {}): RunRecord {
  const branch = basename(dir);
  const at = Date.now() - 10 * DAY;
  return {
    id: `run-${branch}`,
    issueNumber: Number(/^issue-(\d+)/.exec(branch)?.[1] ?? 1),
    issueTitle: branch,
    issueUrl: "https://example.test/issue",
    agent: "claude",
    modelLabel: "model:claude-sonnet-5",
    cliModel: "claude-sonnet-5",
    effortLabel: "effort:medium",
    cliEffort: "medium",
    assignedAgent: "claude",
    assignedModelLabel: "model:claude-sonnet-5",
    assignedCliModel: "claude-sonnet-5",
    assignedEffortLabel: "effort:medium",
    assignedCliEffort: "medium",
    branch,
    checkoutPath: dir,
    planPath: null,
    status: "shipped",
    trigger: "poll",
    lastCommit: null,
    prUrl: null,
    prNumber: null,
    exitCode: 0,
    failureSummary: null,
    resumeCount: 0,
    attemptNumber: 1,
    lastProgressSeq: 0,
    outputSeq: 0,
    recovery: {},
    remotePid: null,
    createdAt: at,
    startedAt: at,
    finishedAt: at,
    finalizationPending: false,
    ...overrides,
  };
}

/** No process uses anything: keeps these tests independent of the host's /proc. */
const idle = (paths: readonly string[]): Map<string, ProcessUse[]> =>
  new Map(paths.map((path) => [path, []]));

function housekeeping(f: Fixture, overrides: Partial<CheckoutHousekeepingOptions> = {}) {
  const lines: Array<Record<string, unknown>> = [];
  const sends: Array<{ title: string; body: string; priority: number | undefined }> = [];
  const keeper = createCheckoutHousekeeping({
    worktreeDir: f.worktreeDir,
    repoDir: f.mirror,
    retentionMs: 3 * DAY,
    floor: { minFreeBytes: 10 * GIB, minFreePercent: 10 },
    logger: createLogger("debug", (line) => lines.push(JSON.parse(line) as Record<string, unknown>)),
    notifier: {
      send: async (title, body, priority) => {
        sends.push({ title, body, priority });
      },
    },
    processesUsing: idle,
    tools: { ionice: false, nice: false },
    ...overrides,
  });
  const logged = (msg: string) => lines.filter((line) => line.msg === msg);
  return { keeper, lines, sends, logged };
}

const plenty = (path: string): DiskUsage => ({ availableBytes: 100 * GIB, totalBytes: 200 * GIB, path });
const scarce = (path: string): DiskUsage => ({ availableBytes: 2 * GIB, totalBytes: 200 * GIB, path });

// ── shipped ───────────────────────────────────────────────────────────────────

test("a shipped run's checkout is removed once it is recorded as shipped, and its branch survives", async () => {
  const f = fixture();
  try {
    const dir = checkout(f, "issue-11-shipped-work");
    const { keeper, logged } = housekeeping(f);

    await keeper.tidy([runFor(dir, { status: "shipped" })]);

    assert.equal(existsSync(dir), false);
    const removed = logged("removed run checkout");
    assert.equal(removed.length, 1);
    assert.equal(removed[0]!.path, dir);
    assert.match(String(removed[0]!.reason), /issue #11 shipped/);
    // Cleanup deletes a directory, never a branch: the pushed work stays on the remote.
    assert.match(git(f.root, "ls-remote", f.remote, "refs/heads/issue-11-shipped-work"), /refs\/heads\/issue-11-shipped-work/);
    assert.equal(logged("checkout cleanup finished").length, 1);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("between daily sweeps, every scan still removes newly shipped checkouts", async () => {
  const f = fixture();
  try {
    let now = Date.now();
    const first = checkout(f, "issue-12-first");
    const { keeper } = housekeeping(f, { now: () => now });
    await keeper.tidy([runFor(first, { status: "ci_pending" })]);
    assert.equal(existsSync(first), true);

    // An hour later the run has shipped: the cheap per-scan pass removes it without
    // waiting for tomorrow's full sweep.
    now += HOUR;
    await keeper.tidy([runFor(first, { status: "shipped" })]);
    assert.equal(existsSync(first), false);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("a shipped checkout waits while its finalization is still pending", async () => {
  const f = fixture();
  try {
    const dir = checkout(f, "issue-13-pending");
    const { keeper } = housekeeping(f);
    await keeper.tidy([runFor(dir, { status: "shipped", finalizationPending: true })]);
    assert.equal(existsSync(dir), true);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

// ── live runs ─────────────────────────────────────────────────────────────────

test("active, held, interrupted, and other unfinished runs never lose their checkout", async () => {
  const f = fixture();
  try {
    const statuses = ["claimed", "running", "held", "interrupted", "timed_out", "token_exhausted", "ci_pending", "pr_ready", "ci_failed"] as const;
    const runs = statuses.map((status, index) => {
      const dir = checkout(f, `issue-${20 + index}-${status.replace("_", "-")}`);
      age(dir, 30 * DAY);
      return runFor(dir, { status, finishedAt: Date.now() - 30 * DAY });
    });
    const { keeper, logged } = housekeeping(f);

    await keeper.tidy(runs);

    for (const run of runs) assert.equal(existsSync(run.checkoutPath), true, run.status);
    assert.equal(logged("removed run checkout").length, 0);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

// ── failed / abandoned ────────────────────────────────────────────────────────

test("an abandoned checkout with unpushed commits is kept and logged, never silently deleted", async () => {
  const f = fixture();
  try {
    const dir = checkout(f, "issue-31-abandoned-local-work", { unpushed: 2 });
    age(dir, 5 * DAY);
    let now = Date.now();
    const { keeper, logged } = housekeeping(f, { now: () => now });
    const runs = [runFor(dir, { status: "abandoned", finishedAt: Date.now() - 5 * DAY })];

    await keeper.tidy(runs);

    assert.equal(existsSync(dir), true);
    const kept = logged("kept run checkout").filter((line) => line.path === dir);
    assert.equal(kept.length, 1);
    assert.equal(kept[0]!.level, "warn");
    assert.match(String(kept[0]!.reason), /holds 2 commits that were never pushed/);

    // Tomorrow's sweep keeps it again, without repeating the same warning.
    now += DAY;
    await keeper.tidy(runs);
    assert.equal(existsSync(dir), true);
    const again = logged("kept run checkout").filter((line) => line.path === dir);
    assert.deepEqual(again.map((line) => line.level), ["warn", "debug"]);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("failed and abandoned checkouts survive until retention expires, then go if fully pushed", async () => {
  const f = fixture();
  try {
    const expired = checkout(f, "issue-32-expired");
    age(expired, 4 * DAY);
    const retained = checkout(f, "issue-33-retained");
    age(retained, 4 * DAY);
    const { keeper } = housekeeping(f);

    await keeper.tidy([
      runFor(expired, { status: "failed", finishedAt: Date.now() - 4 * DAY }),
      // Ended a day ago: within the three-day retention, however old its files are.
      runFor(retained, { status: "abandoned", finishedAt: Date.now() - DAY }),
    ]);

    assert.equal(existsSync(expired), false);
    assert.equal(existsSync(retained), true);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("launcher plan checkpoints are not unpushed work, and an unreadable repository is", async () => {
  const f = fixture();
  try {
    const dir = checkout(f, "issue-34-checkpoints");
    writeFileSync(join(dir, "plan.md"), "## Milestone 1\n");
    git(dir, "add", "plan.md");
    git(dir, "commit", "-q", "-m", "plan: checkpoint");
    assert.deepEqual(await unpushedCommits(dir), { state: "none" });

    writeFileSync(join(dir, "more.txt"), "agent work\n");
    git(dir, "add", "more.txt");
    git(dir, "commit", "-q", "-m", "milestone(2): unpushed");
    assert.deepEqual(await unpushedCommits(dir), { state: "present", count: 1 });

    const bare = join(f.worktreeDir, "issue-35-no-git");
    mkdirSync(bare);
    assert.deepEqual(await unpushedCommits(bare), { state: "none" });

    const broken = join(f.worktreeDir, "issue-36-broken");
    mkdirSync(join(broken, ".git"), { recursive: true });
    const verdict = await unpushedCommits(broken);
    assert.equal(verdict.state, "unknown");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

// ── orphans ───────────────────────────────────────────────────────────────────

test("orphan directories older than the cutoff are removed, and recent ones are left alone", async () => {
  const f = fixture();
  try {
    const old = checkout(f, "issue-41-old-orphan");
    age(old, 4 * DAY);
    const recent = checkout(f, "issue-42-recent-orphan");
    age(recent, 2 * DAY);
    const oldWithWork = checkout(f, "issue-43-orphan-with-work", { unpushed: 1 });
    age(oldWithWork, 4 * DAY);
    const { keeper, logged } = housekeeping(f);

    await keeper.tidy([]);

    assert.equal(existsSync(old), false);
    assert.equal(existsSync(recent), true);
    // An orphan's unpushed commits are protected too: a pruned run record is not consent.
    assert.equal(existsSync(oldWithWork), true);
    assert.match(
      String(logged("kept run checkout").find((line) => line.path === oldWithWork)?.reason),
      /never pushed/,
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("only checkout-shaped directories are ever touched; other files and symlinks are not", async () => {
  const f = fixture();
  try {
    const notes = join(f.worktreeDir, "notes");
    mkdirSync(notes);
    writeFileSync(join(notes, "keep.txt"), "mine\n");
    age(notes, 30 * DAY);
    const outside = join(f.root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "keep.txt"), "mine\n");
    age(outside, 30 * DAY);
    const link = join(f.worktreeDir, "issue-44-link");
    symlinkSync(outside, link);
    const stray = join(f.worktreeDir, "issue-45.txt");
    writeFileSync(stray, "file\n");
    age(stray, 30 * DAY);
    const { keeper } = housekeeping(f);

    await keeper.tidy([runFor(link, { status: "shipped" })]);

    assert.equal(existsSync(join(notes, "keep.txt")), true);
    assert.equal(lstatSync(link).isSymbolicLink(), true);
    assert.equal(existsSync(join(outside, "keep.txt")), true);
    assert.equal(existsSync(stray), true);
    assert.deepEqual(listCheckoutDirs(f.worktreeDir), []);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("the dispatcher's own directories are never removed, whatever they are named", async () => {
  const f = fixture();
  try {
    const dir = checkout(f, "issue-46-own-dir");
    age(dir, 30 * DAY);
    const { keeper } = housekeeping(f, { protectedPaths: [join(dir, "state")] });
    await keeper.tidy([runFor(dir, { status: "shipped" })]);
    assert.equal(existsSync(dir), true);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

// ── processes ────────────────────────────────────────────────────────────────

test(
  "a checkout a process is using is skipped until the process is gone",
  { skip: existsSync("/proc/self") ? false : "needs /proc" },
  async () => {
    const f = fixture();
    const child = spawn("sleep", ["60"], { cwd: f.worktreeDir, stdio: "ignore" });
    try {
      const dir = checkout(f, "issue-51-busy");
      age(dir, 4 * DAY);
      const holder = spawn("sleep", ["60"], { cwd: dir, stdio: "ignore" });
      try {
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.deepEqual(processesUsing([dir])?.get(dir)?.map((use) => use.pid), [holder.pid]);
        let now = Date.now();
        const { keeper, logged } = housekeeping(f, {
          now: () => now,
          processesUsing: (paths) => processesUsing(paths),
        });

        await keeper.tidy([]);
        assert.equal(existsSync(dir), true);
        assert.match(
          String(logged("kept run checkout").find((line) => line.path === dir)?.reason),
          new RegExp(`in use by sleep \\(pid ${holder.pid}\\)`),
        );

        holder.kill();
        await new Promise((resolve) => holder.once("exit", resolve));
        now += DAY;
        await keeper.tidy([]);
        assert.equal(existsSync(dir), false);
      } finally {
        holder.kill();
      }
    } finally {
      child.kill();
      rmSync(f.root, { recursive: true, force: true });
    }
  },
);

test(
  "process use is found through a symlinked worktree directory",
  { skip: existsSync("/proc/self") ? false : "needs /proc" },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "ai-dispatcher-symlinked-"));
    try {
      const real = join(root, "real");
      mkdirSync(join(real, "issue-53-linked-parent"), { recursive: true });
      const link = join(root, "link");
      symlinkSync(real, link);
      const viaLink = join(link, "issue-53-linked-parent");
      const holder = spawn("sleep", ["60"], { cwd: viaLink, stdio: "ignore" });
      try {
        await new Promise((resolve) => setTimeout(resolve, 100));
        // The kernel reports the real path; the answer is keyed by the path asked about.
        assert.deepEqual(processesUsing([viaLink])?.get(viaLink)?.map((use) => use.pid), [holder.pid]);
      } finally {
        holder.kill();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("without a process table nothing is removed, because use cannot be ruled out", async () => {
  const f = fixture();
  try {
    const dir = checkout(f, "issue-52-no-proc");
    const { keeper, logged } = housekeeping(f, { processesUsing: () => null });
    await keeper.tidy([runFor(dir, { status: "shipped" })]);
    assert.equal(existsSync(dir), true);
    assert.match(
      String(logged("kept run checkout").find((line) => line.path === dir)?.reason),
      /could not verify that no process is using it/,
    );
    const empty = mkdtempSync(join(tmpdir(), "ai-dispatcher-noproc-"));
    try {
      assert.equal(processesUsing([dir], empty), null);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

// ── mechanics ────────────────────────────────────────────────────────────────

test("cleanup deletes one directory at a time, at the lowest I/O and CPU priority", async () => {
  const f = fixture();
  try {
    const dirs = [1, 2, 3].map((n) => checkout(f, `issue-6${n}-gentle`));
    const removals: string[][] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const exec: ExecFn = async (file, args, options) => {
      const argv = [file, ...args];
      if (!argv.includes("rm")) return execRun(file, args, options);
      removals.push(argv);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      rmSync(argv[argv.length - 1]!, { recursive: true, force: true });
      inFlight -= 1;
      return { ok: true, stdout: "", stderr: "", code: 0 };
    };
    const { keeper } = housekeeping(f, { exec, tools: { ionice: true, nice: true } });

    await keeper.tidy(dirs.map((dir) => runFor(dir, { status: "shipped" })));

    assert.equal(maxInFlight, 1);
    assert.deepEqual(
      removals,
      dirs.map((dir) => ["ionice", "-c2", "-n7", "nice", "-n", "19", "rm", "-rf", "--", dir]),
    );
    for (const dir of dirs) assert.equal(existsSync(dir), false);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("the real low-priority wrapper removes a checkout on this host", async () => {
  const f = fixture();
  try {
    const dir = checkout(f, "issue-64-real-wrapper");
    // No `tools` override: probe ionice/nice and use whichever this host supports.
    const { keeper } = housekeeping(f, { tools: undefined });
    await keeper.tidy([runFor(dir, { status: "shipped" })]);
    assert.equal(existsSync(dir), false);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("a legacy linked worktree is detached from the mirror as well as deleted", async () => {
  const f = fixture();
  try {
    const dir = join(f.worktreeDir, "issue-65-linked");
    git(f.mirror, "worktree", "add", "-q", "-b", "issue-65-linked", dir);
    assert.match(git(f.mirror, "worktree", "list", "--porcelain"), /issue-65-linked/);
    const { keeper } = housekeeping(f);

    await keeper.tidy([runFor(dir, { status: "shipped" })]);

    assert.equal(existsSync(dir), false);
    assert.doesNotMatch(git(f.mirror, "worktree", "list", "--porcelain"), /issue-65-linked/);
    // The branch ref itself is kept.
    assert.match(git(f.mirror, "branch", "--list", "issue-65-linked"), /issue-65-linked/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("a removal that fails is logged and retried by a later sweep", async () => {
  const f = fixture();
  try {
    const dir = checkout(f, "issue-66-stuck");
    let fail = true;
    const exec: ExecFn = async (file, args, options) =>
      fail && file === "rm"
        ? { ok: false, stdout: "", stderr: "rm: cannot remove: Permission denied", code: 1 }
        : execRun(file, args, options);
    let now = Date.now();
    const { keeper, logged } = housekeeping(f, { exec, now: () => now });

    await keeper.tidy([runFor(dir, { status: "shipped" })]);
    assert.equal(existsSync(dir), true);
    assert.match(String(logged("could not remove run checkout; retrying on a later sweep")[0]?.error), /Permission denied/);

    fail = false;
    now += HOUR;
    await keeper.tidy([runFor(dir, { status: "shipped" })]);
    assert.equal(existsSync(dir), false);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

// ── schedule ─────────────────────────────────────────────────────────────────

test("the full sweep runs on startup and then once a day", async () => {
  const f = fixture();
  try {
    const orphan = checkout(f, "issue-71-aging-orphan");
    age(orphan, 2.5 * DAY);
    let now = Date.now();
    const { keeper, logged } = housekeeping(f, { now: () => now });

    await keeper.tidy([]);
    assert.equal(existsSync(orphan), true, "2.5 days idle is inside the 3-day cutoff");
    assert.equal(logged("checkout cleanup finished")[0]?.trigger, "startup");

    now += 12 * HOUR; // idle 3 days now, but the next full sweep is not due yet
    await keeper.tidy([]);
    assert.equal(existsSync(orphan), true);

    now += 13 * HOUR;
    await keeper.tidy([]);
    assert.equal(existsSync(orphan), false);
    assert.equal(logged("checkout cleanup finished").at(-1)?.trigger, "daily");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("a sweep that runs out of time continues on the next scan", async () => {
  const f = fixture();
  try {
    const dirs = [1, 2, 3].map((n) => checkout(f, `issue-7${n + 1}-budget`));
    let now = Date.now();
    // Each deletion takes four minutes of the five-minute budget.
    const exec: ExecFn = async (file, args, options) => {
      if (file !== "rm") return execRun(file, args, options);
      now += 4 * 60_000;
      return execRun(file, args, options);
    };
    const { keeper, logged } = housekeeping(f, { exec, now: () => now });
    const runs = dirs.map((dir) => runFor(dir, { status: "shipped" }));

    await keeper.tidy(runs);
    assert.deepEqual(dirs.map((dir) => existsSync(dir)), [false, false, true]);
    assert.equal(logged("checkout cleanup finished")[0]?.continuesNextScan, true);

    await keeper.tidy(runs);
    assert.equal(existsSync(dirs[2]!), false);
    assert.equal(logged("checkout cleanup finished").at(-1)?.trigger, "continued");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

// ── disk guard ───────────────────────────────────────────────────────────────

test("a launch with too little free space cleans up first and proceeds when that is enough", async () => {
  const f = fixture();
  try {
    const shipped = checkout(f, "issue-81-reclaimable");
    const { keeper, sends, logged } = housekeeping(f, {
      // Space is short until the shipped checkout is gone.
      diskUsage: (path) => (existsSync(shipped) ? scarce(path) : plenty(path)),
    });

    const hold = await keeper.launchHold([runFor(shipped, { status: "shipped" })], "issue #9");

    assert.equal(hold, null);
    assert.equal(existsSync(shipped), false);
    assert.equal(logged("checkout cleanup finished")[0]?.trigger, "low-disk");
    assert.equal(sends.length, 0);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("a launch still short of space after cleanup is held with one clear message per episode", async () => {
  const f = fixture();
  try {
    const kept = checkout(f, "issue-82-unpushed", { unpushed: 1 });
    age(kept, 5 * DAY);
    let usage = scarce;
    let now = Date.now();
    const { keeper, sends, logged } = housekeeping(f, {
      now: () => now,
      diskUsage: (path) => usage(path),
    });
    const runs = [runFor(kept, { status: "failed", finishedAt: Date.now() - 5 * DAY })];

    const first = await keeper.launchHold(runs, "issue #9");
    assert.ok(first);
    assert.match(first, /^Holding the launch of issue #9: 2\.0 GB is free/);
    assert.match(first, /1 holding unpushed commits/);
    assert.match(first, /Nothing was claimed and no retry budget was spent/);
    assert.equal(sends.length, 1);
    assert.equal(sends[0]!.title, "Dispatcher holding launches: low disk");
    assert.equal(sends[0]!.body, first);
    assert.equal(sends[0]!.priority, 3, "default priority: low disk is not an exhausted-recovery page");
    assert.equal(logged("launch held for disk space").length, 1);

    // Still held a minute later: the same answer, but no second notification and no
    // second sweep inside the 15-minute window.
    now += 60_000;
    assert.ok(await keeper.launchHold(runs, "issue #10"));
    assert.equal(sends.length, 1);
    assert.equal(logged("checkout cleanup finished").length, 1);

    // Sixteen minutes on, cleanup is tried again before holding.
    now += 15 * 60_000;
    assert.ok(await keeper.launchHold(runs, "issue #10"));
    assert.equal(logged("checkout cleanup finished").length, 2);
    assert.equal(sends.length, 1);

    // Space comes back: the hold lifts on its own.
    usage = plenty;
    assert.equal(await keeper.launchHold(runs, "issue #10"), null);
    assert.equal(logged("enough disk space again; launches resume").length, 1);

    // A new shortage is a new episode, announced once more.
    usage = scarce;
    now += 16 * 60_000;
    assert.ok(await keeper.launchHold(runs, "issue #11"));
    assert.equal(sends.length, 2);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("unreadable free space never holds a launch", async () => {
  const f = fixture();
  try {
    const { keeper, logged } = housekeeping(f, { diskUsage: () => null });
    assert.equal(await keeper.launchHold([], "issue #9"), null);
    assert.equal(await keeper.launchHold([], "issue #9"), null);
    assert.equal(logged("free disk space is unreadable; launching without the disk guard").length, 1);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("free space is measured on the nearest existing ancestor of a missing worktree dir", () => {
  const root = mkdtempSync(join(tmpdir(), "ai-dispatcher-statfs-"));
  try {
    const missing = join(root, "not", "created", "yet");
    const usage = readDiskUsage(missing);
    assert.ok(usage);
    assert.equal(usage.path, missing);
    assert.ok(usage.totalBytes > 0);
    assert.ok(usage.availableBytes >= 0 && usage.availableBytes <= usage.totalBytes);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a checkout's activity includes git's own files, not just its top level", () => {
  const f = fixture();
  try {
    const dir = checkout(f, "issue-91-activity");
    age(dir, 10 * DAY);
    const stale = lastActivityAt(dir)!;
    assert.ok(Date.now() - stale > 9 * DAY);
    // A fetch touches only .git/FETCH_HEAD, deep inside the checkout.
    git(dir, "fetch", "-q", "origin", "main");
    assert.ok(Date.now() - lastActivityAt(dir)! < HOUR);
    assert.equal(lastActivityAt(join(f.worktreeDir, "issue-92-missing")), null);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

// ── service wiring ───────────────────────────────────────────────────────────

test("the service wires checkout cleanup and the disk guard from its configuration", async () => {
  const root = mkdtempSync(join(tmpdir(), "ai-dispatcher-wiring-"));
  try {
    const { buildDeps } = await import("../src/main.ts");
    const { parseCliConfig } = await import("../src/config.ts");
    const { StateStore } = await import("../src/state.ts");
    const configure = (env: Record<string, string>) => {
      const parsed = parseCliConfig(["--repo", "acme/widgets"], {
        DISPATCHER_REPO_DIR: join(root, "mirror"),
        DISPATCHER_WORKTREE_DIR: join(root, "worktrees"),
        DISPATCHER_STATE_DIR: join(root, "state"),
        ...env,
      });
      assert.equal(parsed.ok, true);
      return parsed.config!;
    };
    const store = StateStore.open(join(root, "state"));
    try {
      const quiet = createLogger("error", () => undefined);

      // A floor of the whole filesystem can never be met: proof the setting reaches the guard.
      const strict = buildDeps(configure({ DISPATCHER_MIN_FREE_DISK_PERCENT: "100", DISPATCHER_MIN_FREE_DISK_GB: "1000000" }), store, quiet);
      assert.ok(strict.checkouts);
      await strict.checkouts.tidy([]);
      assert.match((await strict.checkouts.launchHold([], "issue #5")) ?? "", /^Holding the launch of issue #5/);

      // Either floor at 0 disables the guard.
      const disabled = buildDeps(configure({ DISPATCHER_MIN_FREE_DISK_GB: "0" }), store, quiet);
      assert.equal(await disabled.checkouts!.launchHold([], "issue #5"), null);
    } finally {
      store.releaseLock();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
