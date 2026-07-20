/**
 * Entrypoint: parse the CLI, validate the target repository, open durable state, and run
 * the dispatcher loop (or a single scan / dry-run).
 *
 * Repository identity is validated and logged before any polling begins, and there is no
 * hard-coded fallback repository anywhere (issue #320) — a missing or malformed `--repo`
 * exits non-zero with usage text.
 */

import { parseCliConfig, expandHome, type DispatcherConfig } from "./config.ts";
import { StateStore, LockHeldError } from "./state.ts";
import { createLogger, type Logger } from "./logger.ts";
import { createNotifier } from "./notify.ts";
import { GithubClient } from "./github.ts";
import { reconcile, runScanOnce, type DispatcherDeps } from "./dispatcher.ts";
import { run } from "./exec.ts";
import { TelemetryStore } from "./telemetry.ts";
import { buildRoutingReport } from "./report.ts";

/** Sleeps for `ms`, resolving early if the abort signal fires. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Drives the loop until aborted (or once, for `--once`/`--dry-run`). A scan failure is
 * logged and the loop continues — a transient GitHub or dev-server hiccup must not kill a
 * long-running service.
 */
export async function runLoop(deps: DispatcherDeps, signal: AbortSignal): Promise<void> {
  const { config, logger } = deps;
  const single = config.once || config.dryRun;

  for (;;) {
    try {
      const result = await runScanOnce(deps);
      logger.info("scan complete", { started: result.started?.id ?? null, message: result.message });
    } catch (err) {
      logger.error("scan failed", { error: err instanceof Error ? err.message : String(err) });
    }

    if (single || signal.aborted) return;
    await sleep(config.pollIntervalSeconds * 1000, signal);
    if (signal.aborted) return;
  }
}

/** Builds the dependency bundle from a resolved config + open store. */
export function buildDeps(config: DispatcherConfig, store: StateStore, logger: Logger): DispatcherDeps {
  return {
    config,
    store,
    logger,
    github: new GithubClient(config.repo),
    notifier: createNotifier({ ntfyUrl: config.ntfyUrl, ntfyTopic: config.ntfyTopic }),
    // Evidence store lives alongside dispatcher state; every terminal run records an attempt.
    telemetry: TelemetryStore.open(config.stateDir),
    // Autoship runner: invokes the configured ship command with a bash login shell so it
    // can source .env and reach nvm/gh, with a generous budget for deploy + health-check.
    // Inert unless config.autoshipCmd is set (autoshipRun self-guards on that).
    ship: (command, env) =>
      run("bash", ["-lc", command], {
        env,
        timeoutMs: 20 * 60_000,
      }),
  };
}

/**
 * Resolves the state directory for a `report` invocation the same way the loop does:
 * `--state-dir`, then `DISPATCHER_STATE_DIR`, then `./state`. Kept deliberately small —
 * `report` is read-only and never needs the full loop config (no --repo, no lock).
 */
function stateDirFor(argv: string[], env: NodeJS.ProcessEnv): string {
  const flagIndex = argv.indexOf("--state-dir");
  const fromFlag = flagIndex >= 0 ? argv[flagIndex + 1] : undefined;
  return expandHome(fromFlag ?? env.DISPATCHER_STATE_DIR ?? "./state");
}

/** The `ai-dispatcher report` subcommand: read telemetry and print the routing report. */
export function runReport(argv: string[], env: NodeJS.ProcessEnv, out: (s: string) => void): number {
  const dir = stateDirFor(argv, env);
  const store = TelemetryStore.open(dir);
  const attempts = store.allAttempts();
  const issues = store.aggregateAll();
  out(buildRoutingReport(attempts, issues));
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  // `report` is a read-only subcommand that bypasses the loop config entirely.
  if (argv[0] === "report") {
    return runReport(argv.slice(1), process.env, (s) => process.stdout.write(`${s}\n`));
  }

  const parsed = parseCliConfig(argv, process.env);
  if (!parsed.ok) {
    process.stderr.write(`${parsed.message}\n`);
    return 2;
  }
  if (parsed.help) {
    process.stdout.write(`${parsed.message}\n`);
    return 0;
  }

  const config = parsed.config!;
  const logger = createLogger(config.logLevel);

  logger.info("ai-dispatcher starting", {
    repo: config.repo.slug,
    repoDir: config.repoDir,
    worktreeDir: config.worktreeDir,
    stateDir: config.stateDir,
    pollIntervalSeconds: config.pollIntervalSeconds,
    maxRuntimeMinutes: config.maxRuntimeMinutes,
    mode: config.dryRun ? "dry-run" : config.once ? "once" : "loop",
  });

  let store: StateStore;
  try {
    store = StateStore.open(config.stateDir);
  } catch (err) {
    if (err instanceof LockHeldError) {
      logger.error("another dispatcher instance is already running", { pid: err.pid });
      return 3;
    }
    throw err;
  }

  const deps = buildDeps(config, store, logger);

  // A dry-run must not mutate anything, including reconciling orphaned runs.
  if (!config.dryRun) reconcile(deps);

  const controller = new AbortController();
  const stop = (sig: string) => {
    logger.info("shutting down", { signal: sig });
    controller.abort();
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));

  try {
    await runLoop(deps, controller.signal);
  } finally {
    store.releaseLock();
  }
  return 0;
}
