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
  readdirSync,
  linkSync,
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
import type { ProviderCapacityKind } from "./token-exhaustion.ts";

export type RunTrigger = "poll" | "manual" | "resume";

export const RUN_PHASES = [
  "claimed",
  "preparing",
  "agent_working",
  "publishing",
  "waiting_ci",
  "autoshipping",
  "deploying",
  "verifying",
  "recovering",
  "held",
] as const;

export type RunPhase = (typeof RUN_PHASES)[number];

export interface RoutingCapacityEvidence {
  pool: string;
  state: "available" | "exhausted" | "unknown";
  confidence:
    | "provider-reported"
    | "cli-reported"
    | "persisted-limit"
    | "unconfirmed-limit"
    | "estimated"
    | "unknown";
  observedAt: number | null;
  resetAt: number | null;
  headroomPercent: number | null;
  reason: string;
}

export interface RoutingAssignmentEvidence {
  source: "automatic" | "human-override";
  minimumTier: "fast" | "general" | "complex" | "frontier";
  characteristicLabels: string[];
  rationaleLabels: string[];
  confidence: "high" | "medium" | "low";
  capacitySelection: "live-headroom" | "rotation" | "only-capable" | "human-override";
  selectedPool: string;
  effortReason: string;
  capacity: RoutingCapacityEvidence[];
  assignedAt: number;
}

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
  /** Sanitized evidence for the immutable pickup-time assignment. */
  routing?: RoutingAssignmentEvidence;
  branch: string;
  checkoutPath: string;
  planPath: string | null;
  status: DispatcherStatus;
  phase?: RunPhase;
  trigger: RunTrigger;
  lastCommit: string | null;
  prUrl: string | null;
  prNumber: number | null;
  exitCode: number | null;
  failureSummary: string | null;
  resumeCount: number;
  /** Monotonic launch sequence; telemetry idempotency must not depend on clock timing. */
  attemptNumber: number;
  /** Output sequence at the start of the last resume — diagnostic progress evidence. */
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

/**
 * Durable, redacted evidence behind an active provider-capacity suppression (#32): what
 * kind of signal was seen, whether it carried a provider-reported reset (`authoritative`)
 * or is an unconfirmed guess pending automatic revalidation, when it was detected, and a
 * bounded/redacted excerpt of the provider text — enough to explain the decision after a
 * restart without persisting secrets or unbounded raw output.
 */
export interface ProviderSuppressionRecord {
  kind: ProviderCapacityKind;
  /** Epoch ms the pool is paused / should be revalidated until. */
  until: number;
  /** True only when a concrete provider-reported reset was found. */
  authoritative: boolean;
  detectedAt: number;
  reportedResetLabel: string | null;
  /** Bounded, already-redacted excerpt of the matched provider output. */
  excerpt: string;
}

export interface SettingsRecord {
  claudeSuppression: ProviderSuppressionRecord | null;
  codexSuppression: ProviderSuppressionRecord | null;
  /** Durable cursor used when live provider headroom is unavailable or effectively tied. */
  lastInitialCapacityPool: string | null;
}

export interface PersistedState {
  version: 1;
  settings: SettingsRecord;
  runs: RunRecord[];
}

const STATE_FILE = "state.json";
const STATE_BACKUP_FILE = "state.json.backup";
const LOCK_FILE = "dispatcher.lock";
export const RUN_OUTPUT_DIR = "run-output";

function emptyState(): PersistedState {
  return {
    version: 1,
    settings: {
      claudeSuppression: null,
      codexSuppression: null,
      lastInitialCapacityPool: null,
    },
    runs: [],
  };
}

/**
 * State files written before #32 stored a bare `claudeSuppressedUntil`/
 * `codexSuppressedUntil` epoch with no evidence. Migrate that legacy shape into a record
 * on read so a restart with an old state file does not lose an active cooldown; the
 * legacy epoch carried no kind/reset information, so it is preserved as an authoritative
 * (fail-safe: honor the deadline the old code already committed to) unknown-kind record
 * rather than guessed apart after the fact.
 */
function normalizeSuppression(
  settings: Partial<SettingsRecord> | undefined,
  agent: DispatcherAgent,
): ProviderSuppressionRecord | null {
  const key = agent === "claude" ? "claudeSuppression" : "codexSuppression";
  const current = (settings as Record<string, unknown> | undefined)?.[key];
  if (current && typeof current === "object" && typeof (current as ProviderSuppressionRecord).until === "number") {
    return current as ProviderSuppressionRecord;
  }
  const legacyKey = agent === "claude" ? "claudeSuppressedUntil" : "codexSuppressedUntil";
  const legacyUntil = (settings as Record<string, unknown> | undefined)?.[legacyKey];
  if (typeof legacyUntil === "number") {
    return {
      kind: "unknown",
      until: legacyUntil,
      authoritative: true,
      detectedAt: legacyUntil,
      reportedResetLabel: null,
      excerpt: "(migrated from a pre-evidence suppression record)",
    };
  }
  return null;
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
    attemptNumber: Math.max(1, run.attemptNumber ?? 1),
    phase: normalizeRunPhase(run),
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

export function phaseForStatus(status: DispatcherStatus): RunPhase {
  if (status === "claimed") return "claimed";
  if (status === "running") return "agent_working";
  if (status === "ci_pending") return "waiting_ci";
  if (status === "held") return "held";
  if (
    status === "failed" ||
    status === "timed_out" ||
    status === "interrupted" ||
    status === "token_exhausted" ||
    status === "ci_failed"
  ) {
    return "recovering";
  }
  return "publishing";
}

function isRunPhase(value: unknown): value is RunPhase {
  return typeof value === "string" && (RUN_PHASES as readonly string[]).includes(value);
}

function normalizeRunPhase(run: RunRecord): RunPhase {
  if (isRunPhase(run.phase)) return run.phase;
  return phaseForStatus(run.status);
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

function readPersistedState(path: string): PersistedState {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<PersistedState> | null;
  // Syntactically valid JSON such as `{}` is still corrupt state. Treating missing
  // runs as an empty array would silently discard every claim just as surely as a
  // parse error.
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.runs)) {
    throw new StateCorruptionError();
  }
  return {
    version: 1,
    settings: {
      claudeSuppression: normalizeSuppression(parsed.settings, "claude"),
      codexSuppression: normalizeSuppression(parsed.settings, "codex"),
      lastInitialCapacityPool:
        typeof parsed.settings?.lastInitialCapacityPool === "string"
          ? parsed.settings.lastInitialCapacityPool
          : null,
    },
    runs: collapseLegacyFinalizations(parsed.runs.map((run) => normalizeRunRecovery(run))),
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

export class StateCorruptionError extends Error {
  constructor() {
    super("dispatcher state and its recovery backup are both unreadable");
    this.name = "StateCorruptionError";
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

export type DispatcherLiveness =
  | { state: "online"; pid: number }
  | { state: "offline"; pid: number | null; reason: "missing" | "stale" | "corrupt" };

export interface ReadOnlyStateSnapshot {
  state: PersistedState;
  source: "primary" | "backup" | "empty";
  liveness: DispatcherLiveness;
}

export function runOutputPath(stateDir: string, runId: string): string {
  return join(stateDir, RUN_OUTPUT_DIR, `${runId}.jsonl`);
}

export function readOnlyStateSnapshot(dir: string): ReadOnlyStateSnapshot {
  const stateFilePath = join(dir, STATE_FILE);
  const stateBackupFilePath = join(dir, STATE_BACKUP_FILE);
  const lockFilePath = join(dir, LOCK_FILE);
  const primaryExists = existsSync(stateFilePath);
  const backupExists = existsSync(stateBackupFilePath);
  let state = emptyState();
  let source: ReadOnlyStateSnapshot["source"] = "empty";

  if (primaryExists) {
    try {
      state = readPersistedState(stateFilePath);
      source = "primary";
    } catch {
      if (!backupExists) throw new StateCorruptionError();
      try {
        state = readPersistedState(stateBackupFilePath);
        source = "backup";
      } catch {
        throw new StateCorruptionError();
      }
    }
  } else if (backupExists) {
    try {
      state = readPersistedState(stateBackupFilePath);
      source = "backup";
    } catch {
      throw new StateCorruptionError();
    }
  }

  return {
    state: {
      version: 1,
      settings: { ...state.settings },
      runs: state.runs.map((run) => ({ ...run })),
    },
    source,
    liveness: readDispatcherLiveness(lockFilePath),
  };
}

export function readDispatcherLiveness(lockFilePath: string): DispatcherLiveness {
  if (!existsSync(lockFilePath)) return { state: "offline", pid: null, reason: "missing" };
  try {
    const raw = JSON.parse(readFileSync(lockFilePath, "utf8")) as {
      pid?: number;
      processIdentity?: string | null;
    };
    const pid = typeof raw.pid === "number" ? raw.pid : null;
    if (pid === null) return { state: "offline", pid: null, reason: "corrupt" };
    if (!processAlive(pid)) return { state: "offline", pid, reason: "stale" };
    const expected = typeof raw.processIdentity === "string" ? raw.processIdentity : null;
    const actual = processIdentity(pid);
    if (expected && actual !== null && actual !== expected) {
      return { state: "offline", pid, reason: "stale" };
    }
    return { state: "online", pid };
  } catch {
    return { state: "offline", pid: null, reason: "corrupt" };
  }
}

export class StateStore {
  private readonly dir: string;
  private readonly stateFilePath: string;
  private readonly stateBackupFilePath: string;
  private readonly lockFilePath: string;
  private readonly reclaimLockFilePath: string;
  private state: PersistedState;
  private locked = false;
  private lockToken: string | null = null;

  private constructor(dir: string) {
    this.dir = dir;
    this.stateFilePath = join(dir, STATE_FILE);
    this.stateBackupFilePath = join(dir, STATE_BACKUP_FILE);
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
    try {
      store.load();
      return store;
    } catch (err) {
      store.releaseLock();
      throw err;
    }
  }

  private acquireLock(): void {
    for (;;) {
      const token = randomUUID();
      if (
        this.publishExclusiveLock(this.lockFilePath, {
          token,
          pid: process.pid,
          startedAt: Date.now(),
          processIdentity: processIdentity(process.pid),
        })
      ) {
        this.locked = true;
        this.lockToken = token;
        return;
      }

      // Stale reclamation is itself serialized. Without this second exclusive file,
      // two starters could both diagnose the old lock as stale; the slower one could
      // then unlink the faster one's newly acquired live lock (an ABA race).
      const reclaimToken = randomUUID();
      if (
        !this.publishExclusiveLock(this.reclaimLockFilePath, {
            token: reclaimToken,
            pid: process.pid,
            processIdentity: processIdentity(process.pid),
        })
      ) {
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

  /**
   * Publishes a complete lock record atomically.
   *
   * Creating the final path with O_EXCL and then writing left a brief empty/partial JSON
   * window. A concurrent stale reclaimer could classify that brand-new live lock as
   * corrupt, unlink it, and let multiple processes believe they owned the dispatcher.
   * A fully-written candidate plus an atomic hard link has no partial-record window:
   * exactly one link succeeds and every observer sees the complete inode.
   */
  private publishExclusiveLock(path: string, record: object): boolean {
    const candidate = `${path}.candidate-${process.pid}-${randomUUID()}`;
    const fd = openSync(candidate, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(record), "utf8");
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(candidate, path);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw err;
    } finally {
      try {
        unlinkSync(candidate);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
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
      if (existsSync(this.stateBackupFilePath)) {
        try {
          this.state = this.readState(this.stateBackupFilePath);
          this.persist();
          return;
        } catch {
          throw new StateCorruptionError();
        }
      }
      this.persist();
      return;
    }
    try {
      this.state = this.readState(this.stateFilePath);
      if (!existsSync(this.stateBackupFilePath)) this.persistBackup();
    } catch {
      // Never turn unreadable durable claims into an empty queue: that redispatches open
      // issues from scratch. Preserve the bad primary and recover the last atomic backup.
      renameSync(this.stateFilePath, `${this.stateFilePath}.corrupt-${Date.now()}`);
      try {
        this.state = this.readState(this.stateBackupFilePath);
      } catch {
        throw new StateCorruptionError();
      }
      this.persist();
    }
  }

  private readState(path: string): PersistedState {
    return readPersistedState(path);
  }

  private persistBackup(): void {
    const tmp = `${this.stateBackupFilePath}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), "utf8");
    renameSync(tmp, this.stateBackupFilePath);
  }

  /** Atomic primary + recovery copy: corruption never silently drops active claims. */
  private persist(): void {
    const tmp = `${this.stateFilePath}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), "utf8");
    renameSync(tmp, this.stateFilePath);
    this.persistBackup();
  }

  // ── settings / provider-capacity suppression ────────────────────────────────

  getSettings(): SettingsRecord {
    return { ...this.state.settings };
  }

  getProviderSuppression(agent: DispatcherAgent): ProviderSuppressionRecord | null {
    return agent === "claude" ? this.state.settings.claudeSuppression : this.state.settings.codexSuppression;
  }

  setProviderSuppression(agent: DispatcherAgent, record: ProviderSuppressionRecord | null): void {
    if (agent === "claude") this.state.settings.claudeSuppression = record;
    else this.state.settings.codexSuppression = record;
    this.persist();
  }

  setLastInitialCapacityPool(pool: string): void {
    this.state.settings.lastInitialCapacityPool = pool;
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
      | "attemptNumber"
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
      | "phase"
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
      attemptNumber: 1,
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
      phase: "claimed",
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
    if (this.state.runs.length !== before) {
      this.persist();
      this.pruneRunOutput(keep);
    }
  }

  private pruneRunOutput(keep: Set<string>): void {
    const dir = join(this.dir, RUN_OUTPUT_DIR);
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const runId = entry.name.slice(0, -".jsonl".length);
      if (keep.has(runId)) continue;
      try {
        unlinkSync(join(dir, entry.name));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }
  }
}
