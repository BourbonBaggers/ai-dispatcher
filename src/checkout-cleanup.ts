/**
 * Removes run checkouts the dispatcher no longer needs, and holds a launch when the disk is
 * too full to finish it (#102).
 *
 * The decisions live in checkout-retention.ts; this is the IO shell around them. Every
 * step fails closed: an unreadable directory, process table, or git answer keeps the
 * checkout. Deletion is gentle, one directory at a time at the lowest I/O and CPU
 * priority, so cleanup never competes with an agent for the disk. Only directories
 * directly under the worktree directory, named the way the launcher names checkouts, are
 * ever touched. Branch refs are never deleted, locally or on GitHub.
 */

import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statfsSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { run as execRun, type ExecFn } from "./exec.ts";
import { NOTIFY_PRIORITY_DEFAULT, type Notifier } from "./notify.ts";
import type { Logger } from "./logger.ts";
import type { RunRecord } from "./state.ts";
import {
  CHECKOUT_DIR_NAME,
  CHECKOUT_SWEEP_INTERVAL_MS,
  LOW_DISK_SWEEP_INTERVAL_MS,
  decideCheckout,
  formatBytes,
  isDiskLow,
  lowDiskHoldMessage,
  lowPriorityCommand,
  minimumFreeBytes,
  processUseVerdict,
  sweepDue,
  unpushedVerdict,
  type DiskFloor,
  type DiskUsage,
  type KeptCategory,
  type KeptCheckout,
  type LowPriorityTools,
  type ProcessUse,
  type RemovalKind,
  type UnpushedCommits,
} from "./checkout-retention.ts";

const GIT_TIMEOUT_MS = 60_000;
/** A gigabyte of node_modules at the lowest I/O priority can take a while on a busy disk. */
const REMOVE_TIMEOUT_MS = 30 * 60_000;
/**
 * One sweep's share of a scan. A first sweep over a large backlog could otherwise block the
 * loop, and every parked PR behind it, for most of an hour. What is left over continues on
 * the next scan.
 */
export const SWEEP_TIME_BUDGET_MS = 5 * 60_000;
/** Git files every launch, commit, and fetch touches; the top-level listing misses them. */
const GIT_ACTIVITY_FILES = ["HEAD", "index", "FETCH_HEAD", "ORIG_HEAD", join("logs", "HEAD")];

export interface CheckoutDir {
  path: string;
  lastActivityAt: number | null;
}

/**
 * The newest modification time in a checkout: the directory, each top-level entry, and
 * git's activity files. A deep walk would stat every file in `node_modules`; any edit,
 * commit, or fetch shows up here anyway. Null when the directory cannot be read.
 */
export function lastActivityAt(dir: string): number | null {
  let newest: number;
  let entries: string[];
  try {
    newest = lstatSync(dir).mtimeMs;
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  const consider = (path: string): void => {
    try {
      newest = Math.max(newest, lstatSync(path).mtimeMs);
    } catch {
      // Absent or vanished: not evidence of activity.
    }
  };
  for (const name of entries) consider(join(dir, name));
  for (const file of GIT_ACTIVITY_FILES) consider(join(dir, ".git", file));
  return newest;
}

/** A real directory (never a symlink) directly under the worktree dir, named like a checkout. */
function isCheckoutDir(path: string, worktreeDir: string): boolean {
  if (dirname(path) !== worktreeDir || !CHECKOUT_DIR_NAME.test(basename(path))) return false;
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Every checkout-shaped directory under the worktree dir. Empty when the directory does
 * not exist yet (the launcher creates it on first use); null when it cannot be read.
 */
export function listCheckoutDirs(worktreeDir: string): CheckoutDir[] | null {
  let names: string[];
  try {
    names = readdirSync(worktreeDir);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? [] : null;
  }
  return names
    .sort()
    .map((name) => join(worktreeDir, name))
    .filter((path) => isCheckoutDir(path, worktreeDir))
    .map((path) => ({ path, lastActivityAt: lastActivityAt(path) }));
}

/**
 * Which candidate directories a process is using as its working directory, root,
 * executable, an open file, or a mapped file — what `lsof` would report, read in one pass
 * over /proc. Returns null when there is no /proc (macOS, for example): use cannot be ruled
 * out, so the caller keeps everything. Another user's processes cannot be inspected and are
 * skipped; checkouts belong to the dispatcher's own user.
 */
export function processesUsing(
  paths: readonly string[],
  procRoot = "/proc",
): Map<string, ProcessUse[]> | null {
  let pids: string[];
  try {
    if (!existsSync(join(procRoot, "self"))) return null;
    pids = readdirSync(procRoot).filter((name) => /^[0-9]+$/.test(name));
  } catch {
    return null;
  }
  // The kernel reports canonical paths, so candidates are matched by their real path: a
  // worktree directory reached through a symlink must not make a busy checkout look idle.
  // Results are keyed by the path the caller asked about.
  const requested = new Map<string, string>();
  for (const path of paths) {
    let real = resolve(path);
    try {
      real = realpathSync(path);
    } catch {
      // Gone already; the resolved path is the best remaining name.
    }
    requested.set(real, resolve(path));
  }
  const roots = new Set(requested.keys());
  const parents = [...new Set([...roots].map((root) => dirname(root)))].map((parent) =>
    parent.endsWith(sep) ? parent : `${parent}${sep}`,
  );
  const uses = new Map<string, ProcessUse[]>([...requested.values()].map((path) => [path, []]));
  // Candidates are direct children of their parents, so the first path segment past a
  // parent names the only candidate a target can be inside. Kernel link targets may carry
  // a " (deleted)" suffix.
  const rootOf = (target: string): string | null => {
    for (const parent of parents) {
      if (!target.startsWith(parent)) continue;
      const rest = target.slice(parent.length);
      const end = rest.indexOf(sep);
      const name = (end === -1 ? rest : rest.slice(0, end)).replace(/ \(deleted\)$/, "");
      const root = `${parent}${name}`;
      if (roots.has(root)) return root;
    }
    return null;
  };

  for (const pidName of pids) {
    const base = join(procRoot, pidName);
    const hits = new Set<string>();
    const check = (target: string): void => {
      const root = rootOf(target);
      if (root !== null) hits.add(root);
    };
    for (const link of ["cwd", "root", "exe"]) {
      try {
        check(readlinkSync(join(base, link)));
      } catch {
        // Exited, or owned by another user.
      }
    }
    try {
      for (const fd of readdirSync(join(base, "fd"))) {
        try {
          check(readlinkSync(join(base, "fd", fd)));
        } catch {
          // Closed between the listing and the read.
        }
      }
    } catch {
      // Exited, or owned by another user.
    }
    try {
      const maps = readFileSync(join(base, "maps"), "utf8");
      if (parents.some((parent) => maps.includes(parent))) {
        for (const line of maps.split("\n")) {
          // The path is the last column, and the only one that can contain a slash.
          const at = line.indexOf("/");
          if (at !== -1) check(line.slice(at));
        }
      }
    } catch {
      // Exited, or owned by another user.
    }
    if (hits.size === 0) continue;
    const command = processName(base);
    for (const root of hits) uses.get(requested.get(root)!)!.push({ pid: Number(pidName), command });
  }
  return uses;
}

/** argv[0]'s basename (`comm` holds a thread name for Node, e.g. "MainThread"). */
function processName(procDir: string): string {
  try {
    const argv0 = readFileSync(join(procDir, "cmdline"), "utf8").split("\0")[0] ?? "";
    if (argv0) return basename(argv0);
  } catch {
    // Fall through to comm.
  }
  try {
    return readFileSync(join(procDir, "comm"), "utf8").trim() || "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Commits reachable from the checkout's HEAD or any local branch that no remote-tracking
 * ref contains: work that exists only on this disk. Nothing is fetched; refs record what
 * was last pushed or fetched, so a commit the remote has never seen always counts. The
 * launcher's own `plan: checkpoint` commits are excluded, exactly as the launcher excludes
 * them when it counts agent work.
 */
export async function unpushedCommits(dir: string, exec: ExecFn = execRun): Promise<UnpushedCommits> {
  // Without its own .git, git would walk up and answer for whatever repository encloses
  // the worktree directory. A directory with no repository holds no commits to lose, and
  // the ceiling below keeps a corrupt .git from being skipped over the same way.
  if (!existsSync(join(dir, ".git"))) return { state: "none" };
  const result = await exec(
    "git",
    [
      "--no-optional-locks",
      "-C",
      dir,
      "rev-list",
      "--count",
      "--invert-grep",
      "--grep=^plan: checkpoint",
      "HEAD",
      "--branches",
      "--not",
      "--remotes",
    ],
    { timeoutMs: GIT_TIMEOUT_MS, env: { GIT_CEILING_DIRECTORIES: dirname(resolve(dir)) } },
  );
  const count = Number.parseInt(result.stdout.trim(), 10);
  if (!result.ok || !Number.isInteger(count) || count < 0) {
    return { state: "unknown", reason: `git rev-list exited ${result.code ?? "without a code"}` };
  }
  return count === 0 ? { state: "none" } : { state: "present", count };
}

/**
 * Free and total space on the filesystem that holds `path`. The worktree directory may not
 * exist before the first launch creates it, so its nearest existing ancestor is measured.
 * Null when nothing can be measured: unknown is never reported as low or as plentiful.
 */
export function readDiskUsage(path: string): DiskUsage | null {
  const requested = resolve(path);
  let current = requested;
  for (;;) {
    try {
      const stats = statfsSync(current);
      return {
        availableBytes: stats.bavail * stats.bsize,
        totalBytes: stats.blocks * stats.bsize,
        path: requested,
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") return null;
      const parent = dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
}

/** Which low-priority wrappers actually work here: run each once, harmlessly. */
export async function probeLowPriorityTools(exec: ExecFn = execRun): Promise<LowPriorityTools> {
  const [ionice, nice] = await Promise.all([
    exec("ionice", ["-c2", "-n7", "true"], { timeoutMs: 10_000 }),
    exec("nice", ["-n", "19", "true"], { timeoutMs: 10_000 }),
  ]);
  return { ionice: ionice.ok, nice: nice.ok };
}

export type RemovalResult = { ok: true } | { ok: false; error: string };

/**
 * Deletes one checkout at low priority. A linked worktree (its `.git` is a file) is first
 * detached through the mirror with `git worktree remove --force`; anything still present is
 * then removed with `rm -rf`. The caller prunes the mirror's worktree records afterwards.
 * Success is judged by the directory being gone, not by an exit code.
 */
export async function removeCheckoutDir(
  dir: string,
  repoDir: string,
  tools: LowPriorityTools,
  exec: ExecFn = execRun,
): Promise<RemovalResult> {
  const gentle = (argv: string[]) => {
    const [file, ...args] = lowPriorityCommand(argv, tools);
    return exec(file!, args, { timeoutMs: REMOVE_TIMEOUT_MS, killProcessGroup: true, killGraceMs: 10_000 });
  };
  let linkedWorktree = false;
  try {
    linkedWorktree = lstatSync(join(dir, ".git")).isFile();
  } catch {
    // An ordinary clone, or no repository at all.
  }
  if (linkedWorktree && existsSync(repoDir)) {
    await gentle(["git", "-C", repoDir, "worktree", "remove", "--force", dir]);
  }
  let detail = "";
  if (existsSync(dir)) {
    const removed = await gentle(["rm", "-rf", "--", dir]);
    detail = removed.stderr.trim().split("\n").slice(-3).join(" ").slice(0, 300) ||
      `rm exited ${removed.code ?? "without a code"}`;
  }
  return existsSync(dir) ? { ok: false, error: detail || "the directory is still present" } : { ok: true };
}

export type SweepTrigger = "startup" | "daily" | "continued" | "low-disk" | "shipped";

export interface SweepSummary {
  removed: { path: string; kind: RemovalKind; reason: string }[];
  kept: KeptCheckout[];
  failed: { path: string; error: string }[];
  /** Growth in free space across the sweep; null when it could not be measured. */
  freedBytes: number | null;
  /** True when the time budget ran out with candidates left; the next scan continues. */
  incomplete: boolean;
}

export interface CheckoutHousekeepingOptions {
  worktreeDir: string;
  /** The mirror the launcher clones from; its `git worktree` records are pruned. */
  repoDir: string;
  retentionMs: number;
  floor: DiskFloor;
  logger: Logger;
  notifier: Notifier;
  /** The dispatcher's own directories: never removed, whatever they are named. */
  protectedPaths?: readonly string[];
  now?: () => number;
  exec?: ExecFn;
  /** Skips probing for ionice/nice, for deterministic tests. */
  tools?: LowPriorityTools | undefined;
  diskUsage?: (path: string) => DiskUsage | null;
  processesUsing?: (paths: readonly string[]) => Map<string, ProcessUse[]> | null;
}

export interface CheckoutHousekeeping {
  /**
   * Called once per scan while no run is active and no finalization is pending. Removes
   * settled shipped checkouts every time; runs the full sweep on startup, once a day after
   * that, and on every scan while a time-budgeted sweep still has work left.
   */
  tidy(runs: readonly RunRecord[]): Promise<void>;
  /**
   * Called just before a launch. Returns null when there is room for it. When there is
   * not, runs the full sweep first (at most every 15 minutes) and, if that is still not
   * enough, returns the message explaining the hold. Announced once per low-disk episode.
   */
  launchHold(runs: readonly RunRecord[], subject: string): Promise<string | null>;
}

/** Categories worth an operator's attention; the rest are routine and log at debug. */
const NOTEWORTHY: ReadonlySet<KeptCategory> = new Set(["unpushed", "in-use", "unverified"]);

export function createCheckoutHousekeeping(options: CheckoutHousekeepingOptions): CheckoutHousekeeping {
  const { logger, notifier, floor } = options;
  const now = options.now ?? Date.now;
  const exec = options.exec ?? execRun;
  const readUsage = options.diskUsage ?? readDiskUsage;
  const findUsers = options.processesUsing ?? ((paths: readonly string[]) => processesUsing(paths));
  const worktreeDir = resolve(options.worktreeDir);
  const repoDir = resolve(options.repoDir);
  const protectedPaths = (options.protectedPaths ?? []).map((path) => resolve(path));
  let tools: LowPriorityTools | null = options.tools ?? null;
  let lastSweep: { at: number; summary: SweepSummary } | null = null;
  let holdAnnounced = false;
  let unknownUsageReported = false;
  /** The reason last logged for each kept directory, so repeated sweeps stay quiet. */
  const reported = new Map<string, string>();

  const isProtected = (dir: string): boolean =>
    protectedPaths.some((path) => path === dir || path.startsWith(`${dir}${sep}`));

  function runsByCheckout(runs: readonly RunRecord[]): Map<string, RunRecord[]> {
    const byPath = new Map<string, RunRecord[]>();
    for (const run of runs) {
      const path = resolve(run.checkoutPath);
      byPath.set(path, [...(byPath.get(path) ?? []), run]);
    }
    return byPath;
  }

  function keep(summary: SweepSummary, path: string, category: KeptCategory, reason: string): void {
    summary.kept.push({ path, category, reason });
    if (!NOTEWORTHY.has(category) || reported.get(path) === reason) {
      logger.debug("kept run checkout", { path, reason });
      return;
    }
    reported.set(path, reason);
    const level = category === "in-use" ? "info" : "warn";
    logger[level]("kept run checkout", { path, reason });
  }

  async function lowPriorityTools(): Promise<LowPriorityTools> {
    tools ??= await probeLowPriorityTools(exec);
    return tools;
  }

  /**
   * Decides and cleans the given directories, one at a time. `onlyShipped` limits a pass
   * to checkouts whose runs shipped, so the per-scan pass never runs the retention rules.
   */
  async function clean(
    dirs: readonly CheckoutDir[],
    runs: readonly RunRecord[],
    onlyShipped: boolean,
  ): Promise<SweepSummary> {
    const summary: SweepSummary = { removed: [], kept: [], failed: [], freedBytes: null, incomplete: false };
    const startedAt = now();
    const byPath = runsByCheckout(runs);
    const candidates: { path: string; kind: RemovalKind; reason: string; checkUnpushed: boolean }[] = [];
    for (const dir of dirs) {
      if (isProtected(dir.path)) {
        keep(summary, dir.path, "live", "it holds one of the dispatcher's own directories");
        continue;
      }
      const decision = decideCheckout(
        { runs: byPath.get(dir.path) ?? [], lastActivityAt: dir.lastActivityAt },
        startedAt,
        options.retentionMs,
      );
      if (decision.action === "keep") {
        keep(summary, dir.path, decision.category, decision.reason);
      } else if (!onlyShipped || decision.kind === "shipped") {
        candidates.push({ path: dir.path, ...decision });
      }
    }
    if (candidates.length === 0) return summary;

    const before = readUsage(worktreeDir);
    const gentle = await lowPriorityTools();
    for (const candidate of candidates) {
      if (now() - startedAt >= SWEEP_TIME_BUDGET_MS) {
        summary.incomplete = true;
        break;
      }
      if (candidate.checkUnpushed) {
        const unpushed = unpushedVerdict(await unpushedCommits(candidate.path, exec));
        if (unpushed) {
          keep(summary, candidate.path, unpushed.category, unpushed.reason);
          continue;
        }
      }
      // Checked immediately before each deletion rather than once per sweep: earlier
      // deletions can take minutes, and a process may have opened this one meanwhile.
      const users = findUsers([candidate.path]);
      const inUse = processUseVerdict(users === null ? null : (users.get(candidate.path) ?? []));
      if (inUse) {
        keep(summary, candidate.path, inUse.category, inUse.reason);
        continue;
      }
      const removal = await removeCheckoutDir(candidate.path, repoDir, gentle, exec);
      if (removal.ok) {
        reported.delete(candidate.path);
        summary.removed.push({ path: candidate.path, kind: candidate.kind, reason: candidate.reason });
        logger.info("removed run checkout", { path: candidate.path, reason: candidate.reason });
      } else {
        summary.failed.push({ path: candidate.path, error: removal.error });
        logger.warn("could not remove run checkout; retrying on a later sweep", {
          path: candidate.path,
          error: removal.error,
        });
      }
    }

    if (summary.removed.length > 0 && existsSync(repoDir)) {
      // Clones need nothing from the mirror, but a legacy linked worktree leaves a record
      // there that only `git worktree prune` clears.
      const [file, ...args] = lowPriorityCommand(["git", "-C", repoDir, "worktree", "prune"], gentle);
      const pruned = await exec(file!, args, { timeoutMs: GIT_TIMEOUT_MS });
      if (!pruned.ok) logger.debug("git worktree prune failed on the mirror", { repoDir, code: pruned.code });
    }
    const after = readUsage(worktreeDir);
    if (before && after) summary.freedBytes = Math.max(0, after.availableBytes - before.availableBytes);
    return summary;
  }

  async function fullSweep(runs: readonly RunRecord[], trigger: SweepTrigger): Promise<SweepSummary> {
    // Stamped before it runs, so a sweep that throws waits for its next turn instead of
    // being retried on every scan.
    const at = now();
    lastSweep = {
      at,
      summary: { removed: [], kept: [], failed: [], freedBytes: null, incomplete: false },
    };
    const dirs = listCheckoutDirs(worktreeDir);
    if (dirs === null) {
      logger.warn("checkout cleanup could not read the worktree directory", { worktreeDir });
      return lastSweep.summary;
    }
    const summary = await clean(dirs, runs, false);
    lastSweep = { at, summary };
    logger.info("checkout cleanup finished", {
      trigger,
      checkouts: dirs.length,
      removed: summary.removed.length,
      kept: summary.kept.length,
      failed: summary.failed.length,
      freed: summary.freedBytes === null ? "unknown" : formatBytes(summary.freedBytes),
      ...(summary.incomplete ? { continuesNextScan: true } : {}),
    });
    return summary;
  }

  /** The cheap per-scan pass: only checkouts whose runs shipped and that still exist. */
  async function shippedPass(runs: readonly RunRecord[]): Promise<void> {
    const paths = new Set(
      runs
        .filter((run) => run.status === "shipped")
        .map((run) => resolve(run.checkoutPath))
        .filter((path) => isCheckoutDir(path, worktreeDir)),
    );
    if (paths.size === 0) return;
    const dirs = [...paths].sort().map((path) => ({ path, lastActivityAt: lastActivityAt(path) }));
    const summary = await clean(dirs, runs, true);
    if (summary.removed.length > 0 || summary.failed.length > 0) {
      logger.info("checkout cleanup finished", {
        trigger: "shipped",
        removed: summary.removed.length,
        failed: summary.failed.length,
        freed: summary.freedBytes === null ? "unknown" : formatBytes(summary.freedBytes),
      });
    }
  }

  function releaseHold(usage: DiskUsage): void {
    if (!holdAnnounced) return;
    holdAnnounced = false;
    logger.info("enough disk space again; launches resume", {
      available: formatBytes(usage.availableBytes),
      required: formatBytes(minimumFreeBytes(usage.totalBytes, floor)),
    });
  }

  return {
    async tidy(runs) {
      try {
        if (lastSweep?.summary.incomplete) {
          await fullSweep(runs, "continued");
        } else if (sweepDue(lastSweep?.at ?? null, now(), CHECKOUT_SWEEP_INTERVAL_MS)) {
          await fullSweep(runs, lastSweep === null ? "startup" : "daily");
        } else {
          await shippedPass(runs);
        }
      } catch (err) {
        logger.warn("checkout cleanup failed; it runs again on a later scan", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },

    async launchHold(runs, subject) {
      try {
        let usage = readUsage(worktreeDir);
        if (usage === null) {
          // Unknown is not low: holding on a measurement failure could stall every launch
          // indefinitely for a reason that has nothing to do with space.
          if (!unknownUsageReported) {
            unknownUsageReported = true;
            logger.warn("free disk space is unreadable; launching without the disk guard", { worktreeDir });
          }
          return null;
        }
        if (!isDiskLow(usage, floor)) {
          releaseHold(usage);
          return null;
        }
        if (sweepDue(lastSweep?.at ?? null, now(), LOW_DISK_SWEEP_INTERVAL_MS)) {
          logger.info("low disk space before a launch; cleaning up checkouts first", {
            subject,
            available: formatBytes(usage.availableBytes),
            required: formatBytes(minimumFreeBytes(usage.totalBytes, floor)),
          });
          await fullSweep(runs, "low-disk");
          usage = readUsage(worktreeDir) ?? usage;
          if (!isDiskLow(usage, floor)) {
            releaseHold(usage);
            return null;
          }
        }
        const message = lowDiskHoldMessage(
          subject,
          usage,
          floor,
          lastSweep?.summary ?? { freedBytes: null, kept: [] },
        );
        if (!holdAnnounced) {
          holdAnnounced = true;
          logger.warn("launch held for disk space", { subject, message });
          // Default priority: low disk is a scheduling condition the dispatcher retries on
          // its own, not an exhausted-recovery page.
          await notifier
            .send("Dispatcher holding launches: low disk", message, NOTIFY_PRIORITY_DEFAULT)
            .catch(() => undefined);
        }
        return message;
      } catch (err) {
        logger.warn("disk guard failed; launching without it", {
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      }
    },
  };
}
