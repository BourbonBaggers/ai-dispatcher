/**
 * Durable dispatcher state on disk.
 *
 * The embedded dispatcher used Postgres partial unique indexes to guarantee one agent
 * at a time and restart-safe claims. The standalone service is a single long-running
 * process, so the same guarantees come from two simpler things:
 *   1. a single-instance lock file (a second dispatcher refuses to start), and
 *   2. one JSON state file written atomically (temp file + rename), so a crash mid-write
 *      never corrupts state.
 *
 * State that must survive a restart to prevent duplicate/lost work: active claims, run
 * status, resume/progress counters, provider cooldowns, and per-issue failure deferrals.
 */

import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { ACTIVE_STATUSES, CLAIMING_STATUSES, RESUMABLE_STATUSES } from "./labels.ts";
import type { DispatcherAgent, DispatcherStatus } from "./labels.ts";
import type { IssueFailureRecord } from "./failure-policy.ts";

export type RunTrigger = "poll" | "manual" | "resume";

export interface RunRecord {
  id: string;
  issueNumber: number;
  issueTitle: string;
  issueUrl: string;
  agent: DispatcherAgent;
  modelLabel: string;
  cliModel: string;
  effortLabel: string;
  cliEffort: string;
  branch: string;
  checkoutPath: string;
  planPath: string | null;
  status: DispatcherStatus;
  trigger: RunTrigger;
  lastCommit: string | null;
  prUrl: string | null;
  prNumber: number | null;
  exitCode: number | null;
  failureSummary: string | null;
  resumeCount: number;
  /** Output sequence at the start of the last resume — progress-aware resume budget. */
  lastProgressSeq: number;
  /** Total output lines seen this run. */
  outputSeq: number;
  remotePid: number | null;
  createdAt: number;
  startedAt: number;
  finishedAt: number | null;
}

export interface SettingsRecord {
  claudeSuppressedUntil: number | null;
  codexSuppressedUntil: number | null;
}

interface PersistedState {
  version: 1;
  settings: SettingsRecord;
  runs: RunRecord[];
  issueFailures: IssueFailureRecord[];
}

const STATE_FILE = "state.json";
const LOCK_FILE = "dispatcher.lock";

function emptyState(): PersistedState {
  return {
    version: 1,
    settings: { claudeSuppressedUntil: null, codexSuppressedUntil: null },
    runs: [],
    issueFailures: [],
  };
}

/** A live process holds this lock. */
export class LockHeldError extends Error {
  readonly pid: number;
  constructor(pid: number) {
    super(`another ai-dispatcher instance is already running (pid ${pid})`);
    this.name = "LockHeldError";
    this.pid = pid;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH → no such process; EPERM → exists but not ours (still alive).
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class StateStore {
  private readonly dir: string;
  private readonly stateFilePath: string;
  private readonly lockFilePath: string;
  private state: PersistedState;
  private locked = false;

  private constructor(dir: string) {
    this.dir = dir;
    this.stateFilePath = join(dir, STATE_FILE);
    this.lockFilePath = join(dir, LOCK_FILE);
    this.state = emptyState();
  }

  /**
   * Opens (or creates) the state directory, takes the single-instance lock, and loads
   * existing state. Throws LockHeldError if a live dispatcher already holds the lock.
   */
  static open(dir: string): StateStore {
    const store = new StateStore(dir);
    mkdirSync(dir, { recursive: true });
    store.acquireLock();
    store.load();
    return store;
  }

  private acquireLock(): void {
    if (existsSync(this.lockFilePath)) {
      try {
        // Any LIVE pid holding the lock blocks — including our own (a double-open is a
        // bug). Only a lock left by a DEAD process (a crash/restart gives a new pid) is
        // safe to reclaim.
        const raw = JSON.parse(readFileSync(this.lockFilePath, "utf8")) as { pid?: number };
        if (typeof raw.pid === "number" && processAlive(raw.pid)) {
          throw new LockHeldError(raw.pid);
        }
      } catch (err) {
        if (err instanceof LockHeldError) throw err;
        // A corrupt/stale lock from a dead process — safe to reclaim.
      }
    }
    writeFileSync(
      this.lockFilePath,
      JSON.stringify({ pid: process.pid, startedAt: Date.now() }),
      "utf8",
    );
    this.locked = true;
  }

  /** Releases the lock. Safe to call more than once. */
  releaseLock(): void {
    if (!this.locked) return;
    try {
      rmSync(this.lockFilePath, { force: true });
    } catch {
      // best effort
    }
    this.locked = false;
  }

  private load(): void {
    if (!existsSync(this.stateFilePath)) {
      this.persist();
      return;
    }
    try {
      const parsed = JSON.parse(readFileSync(this.stateFilePath, "utf8")) as PersistedState;
      this.state = {
        version: 1,
        settings: {
          claudeSuppressedUntil: parsed.settings?.claudeSuppressedUntil ?? null,
          codexSuppressedUntil: parsed.settings?.codexSuppressedUntil ?? null,
        },
        runs: Array.isArray(parsed.runs) ? parsed.runs : [],
        issueFailures: Array.isArray(parsed.issueFailures) ? parsed.issueFailures : [],
      };
    } catch {
      // A corrupt state file is worse than an empty one only if it silently drops work.
      // Preserve it for inspection and start clean rather than crash-loop.
      renameSync(this.stateFilePath, `${this.stateFilePath}.corrupt-${Date.now()}`);
      this.state = emptyState();
      this.persist();
    }
  }

  /** Atomic write: temp file + rename, so a crash mid-write never truncates state. */
  private persist(): void {
    const tmp = `${this.stateFilePath}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), "utf8");
    renameSync(tmp, this.stateFilePath);
  }

  // ── settings / cooldowns ──────────────────────────────────────────────────

  getSettings(): SettingsRecord {
    return { ...this.state.settings };
  }

  setSuppressedUntil(agent: DispatcherAgent, until: number | null): void {
    if (agent === "claude") this.state.settings.claudeSuppressedUntil = until;
    else this.state.settings.codexSuppressedUntil = until;
    this.persist();
  }

  // ── runs ──────────────────────────────────────────────────────────────────

  allRuns(): RunRecord[] {
    return this.state.runs.map((r) => ({ ...r }));
  }

  activeRun(): RunRecord | null {
    return (
      this.state.runs.find((r) => (ACTIVE_STATUSES as readonly string[]).includes(r.status)) ?? null
    );
  }

  runsByStatus(statuses: readonly string[]): RunRecord[] {
    return this.state.runs
      .filter((r) => statuses.includes(r.status))
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((r) => ({ ...r }));
  }

  resumableRuns(): RunRecord[] {
    return this.runsByStatus(RESUMABLE_STATUSES);
  }

  /** issueNumber → status, for every run that still holds a claim on its issue. */
  claimingRunsByIssue(): Map<number, string> {
    const map = new Map<number, string>();
    for (const run of this.state.runs) {
      if ((CLAIMING_STATUSES as readonly string[]).includes(run.status)) {
        map.set(run.issueNumber, run.status);
      }
    }
    return map;
  }

  getRun(id: string): RunRecord | null {
    const run = this.state.runs.find((r) => r.id === id);
    return run ? { ...run } : null;
  }

  /**
   * Claims an issue by creating a run row. Enforces serial execution and no-double-claim
   * in-process (the lock enforces it across processes). Throws if a run is active or the
   * issue is already claimed.
   */
  createRun(
    data: Omit<
      RunRecord,
      | "id"
      | "status"
      | "createdAt"
      | "startedAt"
      | "finishedAt"
      | "lastCommit"
      | "prUrl"
      | "prNumber"
      | "exitCode"
      | "failureSummary"
      | "resumeCount"
      | "lastProgressSeq"
      | "outputSeq"
      | "remotePid"
    >,
  ): RunRecord {
    if (this.activeRun()) throw new Error("a run is already active — the dispatcher is serial");
    if (this.claimingRunsByIssue().has(data.issueNumber)) {
      throw new Error(`issue #${data.issueNumber} already has a claiming run`);
    }
    const now = Date.now();
    const run: RunRecord = {
      ...data,
      id: randomUUID(),
      status: "claimed",
      lastCommit: null,
      prUrl: null,
      prNumber: null,
      exitCode: null,
      failureSummary: null,
      resumeCount: 0,
      lastProgressSeq: 0,
      outputSeq: 0,
      remotePid: null,
      createdAt: now,
      startedAt: now,
      finishedAt: null,
    };
    this.state.runs.push(run);
    this.persist();
    return { ...run };
  }

  updateRun(id: string, patch: Partial<RunRecord>): RunRecord {
    const run = this.state.runs.find((r) => r.id === id);
    if (!run) throw new Error(`run ${id} not found`);
    Object.assign(run, patch);
    this.persist();
    return { ...run };
  }

  /** Retention: drop every run whose id is not in `keep`, so the file cannot grow forever. */
  pruneRuns(keep: Set<string>): void {
    const before = this.state.runs.length;
    this.state.runs = this.state.runs.filter((r) => keep.has(r.id));
    if (this.state.runs.length !== before) this.persist();
  }

  // ── failure records ─────────────────────────────────────────────────────────

  issueFailures(): IssueFailureRecord[] {
    return this.state.issueFailures.map((r) => ({ ...r }));
  }

  setIssueFailures(records: IssueFailureRecord[]): void {
    this.state.issueFailures = records.map((r) => ({ ...r }));
    this.persist();
  }
}
