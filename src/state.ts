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
 * status, resume/progress counters, provider cooldowns, and recovery budgets.
 */

import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  openSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import {
  ACTIVE_STATUSES,
  CLAIMING_STATUSES,
  HELD_STATUSES,
  PARKED_STATUSES,
  RESUMABLE_STATUSES,
} from "./labels.ts";
import type { DispatcherAgent, DispatcherStatus } from "./labels.ts";
import type { RecoveryKind, RecoveryLedger } from "./recovery-policy.ts";

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
  /** Immutable issue assignment. Recovery must return here before a later phase retries. */
  assignedAgent: DispatcherAgent;
  assignedModelLabel: string;
  assignedCliModel: string;
  assignedEffortLabel: string;
  assignedCliEffort: string;
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
  /**
   * Set by the runner before it returns a terminal result and cleared only after the
   * dispatcher has applied recovery/autoship. This closes the kill window between those
   * two operations without resurrecting historical terminal rows.
   */
  finalizationPending?: boolean;
  /** In-memory migration marker used to collapse duplicate pre-contract terminal rows. */
  legacyFinalization?: boolean;
  /** Independent retry + frontier-escalation budgets for every owned delivery phase. */
  recovery?: RecoveryLedger;
  /** Present only when the current hold was created after the full frontier ladder. */
  exhaustion?: {
    kind: RecoveryKind;
    reason: string;
    at: number;
    /** False only while GitHub has not yet confirmed the external hold label write. */
    labelApplied?: boolean;
  };
  /** @deprecated Read-only compatibility with pre-ledger state/test fixtures. */
  ciSelfHealAttempts?: number;
  /** @deprecated Read-only compatibility with pre-ledger state/test fixtures. */
  ciEscalated?: boolean;
  /** @deprecated Read-only compatibility with pre-ledger state/test fixtures. */
  deployEscalated?: boolean;
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
}

const STATE_FILE = "state.json";
const LOCK_FILE = "dispatcher.lock";

function emptyState(): PersistedState {
  return {
    version: 1,
    settings: { claudeSuppressedUntil: null, codexSuppressedUntil: null },
    runs: [],
  };
}

/**
 * State files created before the unified recovery ledger stored only CI/deploy flags.
 * Preserve those spent budgets during the on-read migration so a restart never grants
 * an already-exhausted issue another frontier attempt by accident.
 */
function normalizeRunRecovery(run: RunRecord): RunRecord {
  const legacy = run as RunRecord & {
    ciSelfHealAttempts?: number;
    ciEscalated?: boolean;
    deployEscalated?: boolean;
  };
  const hadRecoveryLedger = legacy.recovery !== undefined && legacy.recovery !== null;
  const normalized = {
    ...run,
    assignedAgent: run.assignedAgent ?? run.agent,
    assignedModelLabel: run.assignedModelLabel ?? run.modelLabel,
    assignedCliModel: run.assignedCliModel ?? run.cliModel,
    assignedEffortLabel: run.assignedEffortLabel ?? run.effortLabel,
    assignedCliEffort: run.assignedCliEffort ?? run.cliEffort,
  };
  if (run.status === ("succeeded" as DispatcherStatus)) {
    // Old releases used `succeeded` for a PR handoff. It is not proof of deployment.
    // Re-enter finalization so autoship verifies it, while non-autoship installs settle
    // on the honest `pr_ready` handoff.
    normalized.status = "pr_ready";
    normalized.finalizationPending = true;
    normalized.legacyFinalization = true;
  }
  if (run.status === "shipped" && !hadRecoveryLedger) {
    // Early self-ship releases wrote `shipped` before issue closure survived the
    // parent restart. Re-verify the already-merged SHA and closure; exact-SHA deploy
    // commands are inclusion-aware and cannot roll production backward.
    normalized.status = "pr_ready";
    normalized.finalizationPending = true;
    normalized.legacyFinalization = true;
  }
  if (hadRecoveryLedger) return normalized;
  return {
    ...normalized,
    recovery: {
      ci: {
        attempts: Math.max(0, legacy.ciSelfHealAttempts ?? 0),
        escalated: legacy.ciEscalated ?? false,
      },
      deploy: {
        attempts: 0,
        escalated: legacy.deployEscalated ?? false,
      },
    },
  };
}

function collapseLegacyFinalizations(runs: RunRecord[]): RunRecord[] {
  const newestByIssue = new Map<number, RunRecord>();
  for (const run of runs) {
    if (!run.legacyFinalization) continue;
    const current = newestByIssue.get(run.issueNumber);
    if (!current || run.createdAt > current.createdAt) newestByIssue.set(run.issueNumber, run);
  }
  return runs.map((run) => {
    if (!run.legacyFinalization || newestByIssue.get(run.issueNumber)?.id === run.id) return run;
    // Old releases could redispatch one issue dozens of times with the same PR. Exact
    // delivery is verified from the newest row; replaying every duplicate would starve
    // the queue for many poll intervals without adding evidence.
    return {
      ...run,
      status: "abandoned",
      finalizationPending: false,
      legacyFinalization: false,
    };
  });
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

function processIdentity(pid: number): string | null {
  try {
    return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 5_000,
    }).trim() || null;
  } catch {
    return null;
  }
}

export class StateStore {
  private readonly dir: string;
  private readonly stateFilePath: string;
  private readonly lockFilePath: string;
  private readonly reclaimLockFilePath: string;
  private state: PersistedState;
  private locked = false;
  private lockToken: string | null = null;

  private constructor(dir: string) {
    this.dir = dir;
    this.stateFilePath = join(dir, STATE_FILE);
    this.lockFilePath = join(dir, LOCK_FILE);
    this.reclaimLockFilePath = `${this.lockFilePath}.reclaim`;
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
    for (;;) {
      const token = randomUUID();
      try {
        // O_EXCL is the actual cross-process mutex. The former exists/read/write sequence
        // let two simultaneous starters both observe "missing" and both become active.
        const fd = openSync(this.lockFilePath, "wx", 0o600);
        try {
          writeFileSync(
            fd,
            JSON.stringify({
              token,
              pid: process.pid,
              startedAt: Date.now(),
              processIdentity: processIdentity(process.pid),
            }),
            "utf8",
          );
        } finally {
          closeSync(fd);
        }
        this.locked = true;
        this.lockToken = token;
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }

      // Stale reclamation is itself serialized. Without this second exclusive file,
      // two starters could both diagnose the old lock as stale; the slower one could
      // then unlink the faster one's newly acquired live lock (an ABA race).
      const reclaimToken = randomUUID();
      let reclaimFd: number;
      try {
        reclaimFd = openSync(this.reclaimLockFilePath, "wx", 0o600);
        writeFileSync(
          reclaimFd,
          JSON.stringify({
            token: reclaimToken,
            pid: process.pid,
            processIdentity: processIdentity(process.pid),
          }),
          "utf8",
        );
        closeSync(reclaimFd);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") {
          try {
            const raw = JSON.parse(readFileSync(this.reclaimLockFilePath, "utf8")) as {
              token?: string;
              pid?: number;
              processIdentity?: string | null;
            };
            const alive =
              typeof raw.pid === "number" &&
              processAlive(raw.pid) &&
              (typeof raw.processIdentity !== "string" ||
                processIdentity(raw.pid) === raw.processIdentity);
            if (!alive && typeof raw.token === "string") {
              this.unlinkOwnedLock(this.reclaimLockFilePath, raw.token);
            }
          } catch {
            // Its owner may be between exclusive create and writing. Retry shortly.
          }
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
          continue;
        }
        throw err;
      }

      try {
        let stale = true;
        let pid: number | null = null;
        try {
          const raw = JSON.parse(readFileSync(this.lockFilePath, "utf8")) as {
            pid?: number;
            processIdentity?: string | null;
          };
          pid = typeof raw.pid === "number" ? raw.pid : null;
          if (pid !== null && processAlive(pid)) {
            const actualIdentity = processIdentity(pid);
            // Legacy locks lack an identity; preserve their conservative live-pid behavior.
            stale =
              typeof raw.processIdentity === "string" &&
              actualIdentity !== null &&
              raw.processIdentity !== actualIdentity;
            if (!stale) throw new LockHeldError(pid);
          }
        } catch (err) {
          if (err instanceof LockHeldError) throw err;
          // Corrupt/unreadable lock: unlink below and race again through O_EXCL.
        }
        if (stale) {
          try {
            unlinkSync(this.lockFilePath);
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
          }
        }
      } finally {
        this.unlinkOwnedLock(this.reclaimLockFilePath, reclaimToken);
      }
    }
  }

  private unlinkOwnedLock(path: string, token: string): void {
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as { token?: string };
      if (raw.token === token) unlinkSync(path);
    } catch {
      // Missing/replaced locks are not ours to remove.
    }
  }

  /** Releases the lock. Safe to call more than once. */
  releaseLock(): void {
    if (!this.locked) return;
    if (this.lockToken !== null) this.unlinkOwnedLock(this.lockFilePath, this.lockToken);
    this.locked = false;
    this.lockToken = null;
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
        runs: Array.isArray(parsed.runs)
          ? collapseLegacyFinalizations(parsed.runs.map((run) => normalizeRunRecovery(run)))
          : [],
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

  /** Terminal observations whose recovery/autoship side effects were not checkpointed. */
  pendingFinalizations(): RunRecord[] {
    return this.state.runs
      .filter((run) => run.finalizationPending === true)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((run) => ({ ...run }));
  }

  resumableRuns(): RunRecord[] {
    return this.runsByStatus(RESUMABLE_STATUSES);
  }

  /** Runs parked on a PR whose CI has not resolved yet — recheck-only, never relaunched. */
  parkedRuns(): RunRecord[] {
    return this.runsByStatus(PARKED_STATUSES);
  }

  /**
   * Held runs (a green PR autoship refused to ship). They keep their claim; the scan loop
   * rechecks each one and resumes autoship the moment its `autoship-held` label is cleared.
   */
  heldRuns(): RunRecord[] {
    return this.runsByStatus(HELD_STATUSES);
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
      | "recovery"
      | "exhaustion"
      | "assignedAgent"
      | "assignedModelLabel"
      | "assignedCliModel"
      | "assignedEffortLabel"
      | "assignedCliEffort"
      | "finalizationPending"
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
      assignedAgent: data.agent,
      assignedModelLabel: data.modelLabel,
      assignedCliModel: data.cliModel,
      assignedEffortLabel: data.effortLabel,
      assignedCliEffort: data.cliEffort,
      finalizationPending: false,
      recovery: {},
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
}
