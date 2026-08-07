/**
 * Entrypoint: parse the CLI, validate the target repository, open durable state, and run
 * the dispatcher loop (or a single scan / dry-run).
 *
 * Repository identity is validated and logged before any polling begins, and there is no
 * hard-coded fallback repository anywhere — a missing or malformed `--repo`
 * exits non-zero with usage text.
 */

import {
  parseCliConfig,
  parseShipCliConfig,
  parsePolicyCleanupCliConfig,
  expandHome,
  type DispatcherConfig,
} from "./config.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { StateStore, LockHeldError } from "./state.ts";
import { createLogger, type Logger } from "./logger.ts";
import { createNotifier } from "./notify.ts";
import { GithubClient } from "./github.ts";
import { reconcile, runScanOnce, type DispatcherDeps } from "./dispatcher.ts";
import { run } from "./exec.ts";
import { TelemetryStore } from "./telemetry.ts";
import { buildRoutingReport } from "./report.ts";
import { runHistoryCommand, runStatusCommand } from "./status.ts";
import { runDashboardCommand } from "./dashboard.ts";
import { shipRun, type ShipDeps, type ShipOutcome } from "./ship.ts";
import {
  resolvePolicyCleanupConfig,
  runPolicyCleanup,
  type PolicyCleanupOutcome,
} from "./policy-cleanup.ts";

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
    ship: (command, env, options) => {
      if (options?.cwd) mkdirSync(options.cwd, { recursive: true });
      return run("bash", ["-lc", command], {
        cwd: options?.cwd ?? config.autoshipDeploymentDir,
        env,
        timeoutMs: config.autoshipTimeoutMinutes * 60_000,
        killProcessGroup: true,
        killGraceMs: 30_000,
      });
    },
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

/** Formats a `shipRun` outcome as a single human-readable terminal line. */
function formatShipOutcome(outcome: ShipOutcome): string {
  switch (outcome.action) {
    case "blocked":
      return `Not shipped: ${outcome.reason}`;
    case "ci_not_green":
      return `Not shipped: CI is ${outcome.state}. Rerun once it resolves.`;
    case "deploy_pending":
      return `Merged; deployment is detached and still verifying (merged SHA: ${outcome.mergedSha ?? "unknown"}). Rerun to confirm.`;
    case "deploy_failed":
      return `Not shipped: ${outcome.detail}`;
    case "shipped": {
      const issueNote =
        outcome.issueClosed === null
          ? ""
          : outcome.issueClosed
            ? " Issue closed."
            : " WARNING: issue could not be closed.";
      return `Shipped. Merged ${outcome.mergedSha}, deployed ${outcome.deployedSha}.${issueNote}`;
    }
  }
}

/** The `ai-dispatcher ship` subcommand: one-shot merge/deploy/verify for an ad hoc PR. */
export async function runShipCommand(
  argv: string[],
  env: NodeJS.ProcessEnv,
  out: (s: string) => void,
  err: (s: string) => void,
): Promise<number> {
  const parsed = parseShipCliConfig(argv, env);
  if (!parsed.ok) {
    err(`${parsed.message}\n`);
    return 2;
  }
  if (parsed.help) {
    out(`${parsed.message}\n`);
    return 0;
  }
  const config = parsed.config!;
  const logger = createLogger(config.logLevel);
  const deps: ShipDeps = {
    github: new GithubClient(config.repo),
    autoshipCmd: config.autoshipCmd,
    repoSlug: config.repo.slug,
    autoshipDeploymentCheckout: config.autoshipDeploymentDir,
    logger,
    ship: (command, shipEnv, options) => {
      if (options?.cwd) mkdirSync(options.cwd, { recursive: true });
      return run("bash", ["-lc", command], {
        cwd: options?.cwd ?? config.autoshipDeploymentDir,
        env: shipEnv,
        timeoutMs: config.autoshipTimeoutMinutes * 60_000,
        killProcessGroup: true,
        killGraceMs: 30_000,
      });
    },
  };

  const outcome = await shipRun(deps, { pr: config.pr, issueNumber: config.issue });
  out(`${formatShipOutcome(outcome)}\n`);
  return outcome.action === "shipped" ? 0 : 1;
}

/** Formats a `runPolicyCleanup` outcome as a single human-readable terminal line. */
function formatPolicyCleanupOutcome(outcome: PolicyCleanupOutcome): string {
  switch (outcome.action) {
    case "clean":
      return `No conflicts found. ${outcome.summary}`;
    case "dry_run":
      return `[dry-run] Would rewrite ${outcome.paths.join(", ")}. ${outcome.summary}`;
    case "opened":
      return `Opened PR #${outcome.pr} rewriting ${outcome.paths.join(", ")}. ${outcome.summary}`;
    case "failed":
      return `Not cleaned up: ${outcome.reason}`;
  }
}

/** The `ai-dispatcher target policy-cleanup` subcommand (issue #28). */
export async function runPolicyCleanupCommand(
  argv: string[],
  env: NodeJS.ProcessEnv,
  out: (s: string) => void,
  err: (s: string) => void,
): Promise<number> {
  const parsed = parsePolicyCleanupCliConfig(argv, env);
  if (!parsed.ok) {
    err(`${parsed.message}\n`);
    return 2;
  }
  if (parsed.help) {
    out(`${parsed.message}\n`);
    return 0;
  }
  const config = parsed.config!;
  const modelResult = resolvePolicyCleanupConfig(config.ciEscalationModel);
  if (!modelResult.ok) {
    err(`${modelResult.reason}\n`);
    return 2;
  }
  const logger = createLogger(config.logLevel);

  const outcome = await runPolicyCleanup(
    {
      github: new GithubClient(config.repo),
      logger,
      repoSlug: config.repo.slug,
      config: modelResult.value,
    },
    { dryRun: config.dryRun },
  );
  out(`${formatPolicyCleanupOutcome(outcome)}\n`);
  return outcome.action === "failed" ? 1 : 0;
}

export async function main(argv: string[]): Promise<number> {
  if (argv[0] === "ship") {
    return await runShipCommand(
      argv.slice(1),
      process.env,
      (s) => process.stdout.write(s),
      (s) => process.stderr.write(s),
    );
  }
  if (argv[0] === "target" && argv[1] === "policy-cleanup") {
    return await runPolicyCleanupCommand(
      argv.slice(2),
      process.env,
      (s) => process.stdout.write(s),
      (s) => process.stderr.write(s),
    );
  }
  // `report` is a read-only subcommand that bypasses the loop config entirely.
  if (argv[0] === "report") {
    return runReport(argv.slice(1), process.env, (s) => process.stdout.write(`${s}\n`));
  }
  if (argv[0] === "status") {
    return await runStatusCommand(
      argv.slice(1),
      process.env,
      (s) => process.stdout.write(s),
      (s) => process.stderr.write(s),
    );
  }
  if (argv[0] === "history") {
    return runHistoryCommand(
      argv.slice(1),
      process.env,
      (s) => process.stdout.write(s),
      (s) => process.stderr.write(s),
    );
  }
  if (argv[0] === "dashboard") {
    return await runDashboardCommand(
      argv.slice(1),
      (s) => process.stdout.write(s),
      (s) => process.stderr.write(s),
    );
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

  // Self-ship must distinguish "the checkout contains SHA X" from "the running Node
  // process actually loaded SHA X". Do this only after owning the instance lock: a
  // rejected second invocation must never impersonate the live service.
  const [runtimeSha, gitDir] = await Promise.all([
    run("git", ["rev-parse", "HEAD"], { timeoutMs: 10_000 }),
    run("git", ["rev-parse", "--git-dir"], { timeoutMs: 10_000 }),
  ]);
  if (runtimeSha.ok && gitDir.ok) {
    try {
      writeFileSync(
        resolve(process.cwd(), gitDir.stdout.trim(), "dispatcher-running-sha"),
        `${runtimeSha.stdout.trim()}\n`,
        "utf8",
      );
    } catch (err) {
      logger.warn("could not record running dispatcher SHA", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
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
