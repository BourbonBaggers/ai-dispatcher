/**
 * Which run checkouts may be deleted, and when a launch must wait for disk space (#102).
 *
 * The dispatcher never removed a run's checkout, and every checkout carries its own
 * `node_modules`, so the worktree directory grew by about a gigabyte per issue until the
 * disk was nearly full and runs stalled on I/O. These decisions are pure: the IO shell
 * (checkout-cleanup.ts) gathers the evidence, and every rule is tested on its own.
 *
 * Deleting a checkout is the one irreversible thing housekeeping does, so every rule fails
 * closed: a status this module does not know, an unreadable timestamp, a pending
 * finalization, a process that may be using the directory, and commits that may never
 * have been pushed all keep it.
 */

import type { RunRecord } from "./state.ts";

const DAY_MS = 24 * 60 * 60_000;
/** Disk sizes are binary gigabytes, the unit `df -h` reports as "G". */
export const GIB = 1024 ** 3;

export const DEFAULT_CHECKOUT_RETENTION_DAYS = 3;
export const DEFAULT_MIN_FREE_DISK_GB = 10;
export const DEFAULT_MIN_FREE_DISK_PERCENT = 10;
/** The full sweep runs on startup and then once a day. */
export const CHECKOUT_SWEEP_INTERVAL_MS = DAY_MS;
/** While launches are held for disk space, cleanup reruns at most this often. */
export const LOW_DISK_SWEEP_INTERVAL_MS = 15 * 60_000;

/**
 * The only directory names housekeeping may touch: the shape `dispatch-agent.sh` accepts
 * for `--branch`, which names every checkout it creates. Anything else under the worktree
 * directory was not made by the dispatcher and is never deleted, so a misconfigured
 * worktree directory cannot become a recursive delete of someone's files.
 */
export const CHECKOUT_DIR_NAME = /^issue-[0-9]+(-[a-z0-9-]+)?$/;

/**
 * Statuses whose run no longer needs its checkout. Every other status — the claiming
 * ones, and any status a future release adds — keeps it: an interrupted, parked, ready,
 * mid-ladder, or held run is resumed or repaired in this exact directory.
 */
const SETTLED_STATUSES: ReadonlySet<string> = new Set(["shipped", "failed", "abandoned"]);

export type CheckoutRun = Pick<
  RunRecord,
  "issueNumber" | "status" | "finalizationPending" | "createdAt" | "startedAt" | "finishedAt"
>;

export interface CheckoutEntry {
  /** Every run record whose checkout is this directory; reruns of an issue share one. */
  runs: readonly CheckoutRun[];
  /** Newest modification time seen in the directory; null when it could not be read. */
  lastActivityAt: number | null;
}

export type RemovalKind = "shipped" | "expired" | "orphan";

/** Why a directory survived a sweep, grouped the way an operator would act on it. */
export type KeptCategory = "live" | "retained" | "in-use" | "unpushed" | "unverified";

export type CheckoutDecision =
  | { action: "keep"; category: KeptCategory; reason: string }
  | { action: "remove"; kind: RemovalKind; reason: string; checkUnpushed: boolean };

/**
 * Decides one directory from every run record that points at it.
 *
 *   - Any live record (claiming or unknown status), or one whose finalization is still
 *     pending, keeps it. A pending finalization can still be replayed into a resume-mode
 *     relaunch, and the launcher refuses to resume without its checkout.
 *   - A directory whose records are all `shipped` goes now: its work is merged and
 *     verified in production.
 *   - A `failed` or `abandoned` record keeps it until the retention window has passed
 *     since the later of the run's end and the directory's last modification. It is then
 *     removed only if no unpushed commits are found.
 *   - A directory with no record at all (its run was pruned from state, or it was never
 *     recorded) goes once it has been unmodified for the retention window, again only
 *     without unpushed commits.
 */
export function decideCheckout(
  entry: CheckoutEntry,
  nowMs: number,
  retentionMs: number,
): CheckoutDecision {
  const live = entry.runs.find(
    (run) => run.finalizationPending === true || !SETTLED_STATUSES.has(run.status),
  );
  if (live) {
    return {
      action: "keep",
      category: "live",
      reason: SETTLED_STATUSES.has(live.status)
        ? `issue #${live.issueNumber} is ${live.status} but its finalization is still pending`
        : `issue #${live.issueNumber} is ${live.status}`,
    };
  }

  if (entry.runs.length === 0) {
    if (entry.lastActivityAt === null) {
      return {
        action: "keep",
        category: "unverified",
        reason: "no run record, and its modification time could not be read",
      };
    }
    const idleMs = nowMs - entry.lastActivityAt;
    if (idleMs < retentionMs) {
      return {
        action: "keep",
        category: "retained",
        reason:
          `no run record; modified ${formatDuration(idleMs)} ago, so it is kept until ` +
          `${formatDuration(retentionMs)} pass without a change`,
      };
    }
    return {
      action: "remove",
      kind: "orphan",
      reason: `no run record and unmodified for ${formatDuration(idleMs)}`,
      checkUnpushed: true,
    };
  }

  const newest = [...entry.runs].sort((a, b) => runSettledAt(b) - runSettledAt(a))[0]!;
  if (entry.runs.every((run) => run.status === "shipped")) {
    return {
      action: "remove",
      kind: "shipped",
      reason: `issue #${newest.issueNumber} shipped`,
      checkUnpushed: false,
    };
  }

  // A shipped record mixed with a failed or abandoned one is not proof the latest work
  // shipped, so the conservative failed/abandoned rule applies to the whole directory.
  const ended = entry.runs.filter((run) => run.status !== "shipped");
  const subject = [...ended].sort((a, b) => runSettledAt(b) - runSettledAt(a))[0]!;
  if (entry.lastActivityAt === null) {
    return {
      action: "keep",
      category: "unverified",
      reason: `issue #${subject.issueNumber} is ${subject.status}, and the directory's modification time could not be read`,
    };
  }
  const settledAt = Math.max(entry.lastActivityAt, ...entry.runs.map(runSettledAt));
  const ageMs = nowMs - settledAt;
  if (ageMs < retentionMs) {
    return {
      action: "keep",
      category: "retained",
      reason:
        `issue #${subject.issueNumber} is ${subject.status}; kept until ` +
        new Date(settledAt + retentionMs).toISOString(),
    };
  }
  return {
    action: "remove",
    kind: "expired",
    reason:
      `issue #${subject.issueNumber} is ${subject.status} and the checkout has been ` +
      `untouched for ${formatDuration(ageMs)}`,
    checkUnpushed: true,
  };
}

/** The latest moment a run record says anything happened to its checkout. */
function runSettledAt(run: CheckoutRun): number {
  return Math.max(run.finishedAt ?? 0, run.startedAt, run.createdAt);
}

export interface ProcessUse {
  pid: number;
  command: string;
}

/**
 * The last gates before deletion. Null means nothing stands in the way. A directory a
 * process uses is skipped, and so is one whose use could not be checked at all: with no
 * process table there is no proof it is idle.
 */
export function processUseVerdict(
  users: readonly ProcessUse[] | null,
): { category: KeptCategory; reason: string } | null {
  if (users === null) {
    return { category: "unverified", reason: "could not verify that no process is using it" };
  }
  if (users.length === 0) return null;
  const named = users
    .slice(0, 3)
    .map((use) => `${use.command} (pid ${use.pid})`)
    .join(", ");
  const more = users.length > 3 ? ` and ${users.length - 3} more` : "";
  return { category: "in-use", reason: `in use by ${named}${more}` };
}

export type UnpushedCommits =
  | { state: "none" }
  | { state: "present"; count: number }
  | { state: "unknown"; reason: string };

/**
 * #102 allows either pushing unpushed commits or keeping the checkout and logging why.
 * Keeping is the safe choice: pushing would recreate a branch that was deleted on purpose,
 * and the launcher's next fresh start on that branch would then read the stale work as
 * diverged history. Every kept checkout is logged, so nothing is deleted silently.
 */
export function unpushedVerdict(
  unpushed: UnpushedCommits,
): { category: KeptCategory; reason: string } | null {
  if (unpushed.state === "none") return null;
  if (unpushed.state === "unknown") {
    return {
      category: "unverified",
      reason: `could not check it for unpushed commits (${unpushed.reason})`,
    };
  }
  const commits =
    unpushed.count === 1 ? "1 commit that was" : `${unpushed.count} commits that were`;
  return {
    category: "unpushed",
    reason: `holds ${commits} never pushed; it is kept until they are pushed or the directory is removed by hand`,
  };
}

export interface DiskUsage {
  /** Bytes an unprivileged process can still write. */
  availableBytes: number;
  totalBytes: number;
  /** The directory whose filesystem was measured. */
  path: string;
}

export interface DiskFloor {
  minFreeBytes: number;
  minFreePercent: number;
}

/**
 * The space a launch needs: 10 GB, or 10% of the filesystem when that is smaller. The
 * absolute floor is what one run can actually consume (a clone plus its dependencies);
 * the percentage keeps a small disk from holding forever behind a floor it can never meet.
 * Either floor at 0 disables the guard.
 */
export function minimumFreeBytes(totalBytes: number, floor: DiskFloor): number {
  return Math.max(0, Math.min(floor.minFreeBytes, (totalBytes * floor.minFreePercent) / 100));
}

export function isDiskLow(usage: DiskUsage, floor: DiskFloor): boolean {
  const required = minimumFreeBytes(usage.totalBytes, floor);
  return required > 0 && usage.availableBytes < required;
}

export interface KeptCheckout {
  path: string;
  category: KeptCategory;
  reason: string;
}

/** The categories an operator can act on to free space, in the order they matter. */
const ACTIONABLE: readonly KeptCategory[] = ["unpushed", "in-use", "unverified", "retained"];

/**
 * The one message a held launch posts. It says what was held and why, that cleanup already
 * ran, which surviving checkouts an operator could free by hand, and that nothing was
 * claimed or spent: the hold lifts on its own as soon as space is available.
 */
export function lowDiskHoldMessage(
  subject: string,
  usage: DiskUsage,
  floor: DiskFloor,
  cleanup: { freedBytes: number | null; kept: readonly KeptCheckout[] },
): string {
  const parts = [
    `Holding the launch of ${subject}: ${formatBytes(usage.availableBytes)} is free on the ` +
      `filesystem holding ${usage.path}, below the ${formatBytes(minimumFreeBytes(usage.totalBytes, floor))} minimum.`,
    cleanup.freedBytes !== null && cleanup.freedBytes > 0
      ? `Checkout cleanup ran first and freed ${formatBytes(cleanup.freedBytes)}, which was not enough.`
      : "Checkout cleanup ran first and could not free enough.",
  ];
  const counts = ACTIONABLE.map((category) => ({
    category,
    entries: cleanup.kept.filter((kept) => kept.category === category),
  })).filter((group) => group.entries.length > 0);
  if (counts.length > 0) {
    parts.push(
      "Checkouts it kept: " +
        counts
          .map(({ category, entries }) => {
            const names = entries.slice(0, 3).map((kept) => kept.path).join(", ");
            const more = entries.length > 3 ? `, and ${entries.length - 3} more` : "";
            return `${entries.length} ${KEPT_LABELS[category]} (${names}${more})`;
          })
          .join("; ") +
        ".",
    );
  }
  parts.push(
    "Nothing was claimed and no retry budget was spent; the dispatcher checks again every " +
      "scan and launches as soon as space is free. Free disk space, or lower " +
      "DISPATCHER_MIN_FREE_DISK_GB / DISPATCHER_MIN_FREE_DISK_PERCENT.",
  );
  return parts.join(" ");
}

const KEPT_LABELS: Record<KeptCategory, string> = {
  live: "belonging to unfinished runs",
  retained: "within their retention window",
  "in-use": "in use by a process",
  unpushed: "holding unpushed commits",
  unverified: "that could not be verified safe to delete",
};

export interface LowPriorityTools {
  ionice: boolean;
  nice: boolean;
}

/**
 * Runs a deletion in the lowest best-effort I/O class at the lowest CPU priority, so
 * cleanup yields the disk to a running agent instead of competing with its `npm ci`. A
 * missing tool is skipped rather than failing the deletion.
 */
export function lowPriorityCommand(argv: readonly string[], tools: LowPriorityTools): string[] {
  return [
    ...(tools.ionice ? ["ionice", "-c2", "-n7"] : []),
    ...(tools.nice ? ["nice", "-n", "19"] : []),
    ...argv,
  ];
}

export function sweepDue(lastSweepAt: number | null, nowMs: number, intervalMs: number): boolean {
  return lastSweepAt === null || nowMs - lastSweepAt >= intervalMs;
}

export function formatBytes(bytes: number): string {
  const sign = bytes < 0 ? "-" : "";
  const value = Math.abs(bytes);
  if (value >= GIB) return `${sign}${(value / GIB).toFixed(1)} GB`;
  if (value >= 1024 ** 2) return `${sign}${(value / 1024 ** 2).toFixed(0)} MB`;
  return `${sign}${Math.round(value / 1024)} KB`;
}

export function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.floor(hours / 24)} days`;
}
