/**
 * Agent process supervision (ported from the embedded dispatcher's runner.ts, #188).
 *
 * The standalone service runs DIRECTLY on the dev server, so there is no SSH hop: the
 * runner spawns the bundled `dispatch-agent.sh` with an argv ARRAY — no shell string is
 * ever assembled. Every argument is a validated scalar (issue number, allowlisted model,
 * branch); issue text never appears on the command line, because the agent fetches the
 * issue itself once it is running.
 *
 * The runner reads the script's line-oriented control protocol on dedicated fd 3
 * (`::pid::` / `::event::` / `::result::`), scans ordinary output for provider
 * token-exhaustion, and on exit classifies the run into one terminal state. The pure
 * pieces — argv construction and terminal classification — are exported so they are
 * unit-testable without launching a real agent.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseControlLine, redact, toTerminalLines } from "./sanitize.ts";
import type { CiState } from "./sanitize.ts";
import {
  detectProviderTokenExhaustion,
  computeSuppressUntil,
  formatResetTime,
  type TokenExhaustionSignal,
} from "./token-exhaustion.ts";
import type { DispatcherAgent } from "./labels.ts";
import type { DispatcherConfig } from "./config.ts";
import type { StateStore, RunRecord } from "./state.ts";
import type { Logger } from "./logger.ts";
import type { Notifier } from "./notify.ts";
import { terminateProcessTree } from "./exec.ts";

/** The bundled script the runner launches — resolved relative to this module. */
export const DISPATCH_AGENT_SCRIPT = fileURLToPath(
  new URL("../scripts/dispatch-agent.sh", import.meta.url),
);

/** Checkout/bootstrap/CI wrap-up get bounded overhead beyond the provider's own budget. */
export const LAUNCHER_OVERHEAD_MINUTES = 30;

export function launcherTimeoutMs(maxRuntimeMinutes: number): number {
  return (maxRuntimeMinutes + LAUNCHER_OVERHEAD_MINUTES) * 60_000;
}

export function parseTrustedControlLine(
  line: string,
  trustedControl: boolean,
): ReturnType<typeof parseControlLine> {
  return trustedControl ? parseControlLine(line) : null;
}

export interface AgentLaunchSpec {
  issueNumber: number;
  agent: DispatcherAgent;
  cliModel: string;
  cliEffort: string;
  branch: string;
  mode: "start" | "resume";
  maxRuntimeMinutes: number;
}

/**
 * The argv passed to `bash` to launch one run. Every value is a validated scalar;
 * `dispatch-agent.sh` re-validates each against its own allowlist as belt-and-suspenders.
 */
export function dispatchAgentArgs(scriptPath: string, spec: AgentLaunchSpec): string[] {
  return [
    scriptPath,
    "--issue",
    String(spec.issueNumber),
    "--agent",
    spec.agent,
    "--model",
    spec.cliModel,
    "--effort",
    spec.cliEffort,
    "--branch",
    spec.branch,
    "--mode",
    spec.mode,
    "--max-minutes",
    String(spec.maxRuntimeMinutes),
  ];
}

/**
 * The environment the bundled script requires. Repository identity is passed here
 * (never argv) and is mandatory — the script fails fast if `DISPATCHER_REPO` is empty,
 * so there is no hard-coded repository anywhere in the pipeline (issue #320).
 */
export function dispatchAgentEnv(
  config: DispatcherConfig,
  recoveryReason?: string | null,
): Record<string, string> {
  const env: Record<string, string> = {
    DISPATCHER_REPO: config.repo.slug,
    // Legacy alias the ported script also accepts, kept so a hand-run stays compatible.
    DISPATCHER_REPO_SLUG: config.repo.slug,
    DISPATCHER_REPO_DIR: config.repoDir,
    DISPATCHER_WORKTREE_DIR: config.worktreeDir,
  };
  if (config.envSourceDir) env.DISPATCHER_ENV_SOURCE_DIR = config.envSourceDir;
  if (recoveryReason) env.DISPATCHER_RECOVERY_REASON = recoveryReason.slice(0, 4_000);
  return env;
}

/** Everything the terminal-state decision reads. All of it is observed, never trusted. */
export interface RunSignals {
  /** The child process's own exit code (null if it was killed by a signal). */
  closeCode: number | null;
  /** Whether a `::result::` line was ever seen — false means the run was killed blind. */
  sawResult: boolean;
  /** exit= from the result line. */
  resultExit: number;
  /** commits= from the result line: real agent commits ahead of main. */
  resultCommits: number;
  /** ci= from the result line: the REAL CI verdict, not the agent's self-report. */
  resultCi: CiState;
  /** A pre-launch closed issue is retired without spending model recovery. */
  resultDisposition?: "normal" | "abandoned";
  /** First provider token-exhaustion signal seen this run, if any. */
  tokenExhaustion: TokenExhaustionSignal | null;
  /** For the timed-out summary message. */
  maxRuntimeMinutes: number;
}

export type TerminalStatus =
  | "pr_ready"
  | "shipped"
  | "ci_pending"
  | "ci_failed"
  | "failed"
  | "timed_out"
  | "interrupted"
  | "abandoned"
  | "token_exhausted";

export type RunOutcome =
  | { status: "token_exhausted"; exitCode: number; signal: TokenExhaustionSignal }
  | { status: Exclude<TerminalStatus, "token_exhausted">; exitCode: number; summary: string | null };

/**
 * Classifies a finished run into exactly one terminal state.
 *
 * Precedence is load-bearing and ported verbatim from the embedded runner:
 *   1. token exhaustion (recoverable provider state, must not read as a generic failure)
 *   2. timeout (124/137 — branch preserved, resumable)
 *   3. no result line (killed blind — resumable, MUST precede the commit/CI branches
 *      whose defaults would otherwise misjudge it as a hard failure)
 *   4. clean exit, zero commits (agent gave up — not "complete")
 *   5. clean exit, CI red -> `ci_failed` (drives the self-heal/escalate/held ladder)
 *   6. clean exit, CI pending -> `ci_pending` (parked; the NEXT scan re-checks CI only,
 *      it does not relaunch the agent)
 *   7. clean exit, CI pass -> `pr_ready`: an honest hand-off, not production success.
 *      `evaluateAutoship` re-checks CI and may park, repair, exhaust, or persist
 *      `shipped` only after merge + deploy + health + issue closure.
 *   8. non-zero exit (failed)
 *
 * None of statuses 5-7 are ever "succeeded" outright: that word used to cover all three
 * (see #366) and, because a "succeeded" run released its issue claim, a PR that was
 * merely open with CI still pending (or even red) got silently re-claimed and rerun by
 * the dispatcher from scratch every ~15 minutes. `ci_pending`/`ci_failed` now keep the
 * claim; only a confirmed ship (or an intentional `held`) ever lets the issue go.
 */
export function classifyRunOutcome(signals: RunSignals): RunOutcome {
  const {
    closeCode,
    sawResult,
    resultExit,
    resultCommits,
    resultCi,
    resultDisposition = "normal",
    tokenExhaustion,
    maxRuntimeMinutes,
  } = signals;

  const exitCode = sawResult ? resultExit : (closeCode ?? 1);

  if (sawResult && resultDisposition === "abandoned") {
    return { status: "abandoned", exitCode: 0, summary: "Issue closed before agent launch." };
  }

  // `timeout` reports 124; 137 is a SIGKILL that outran the grace period. Both leave the
  // branch and checkout intact, so both are resumable.
  const timedOut = exitCode === 124 || exitCode === 137;

  // The provider ran out of subscription tokens: recoverable state, not a defect in the
  // work, so it must not be classified as a generic exit-1 failure (which would
  // re-notify every scan). A non-zero exit is still required so a stray match on a clean
  // run can never trip it.
  if (tokenExhaustion && exitCode !== 0 && !timedOut) {
    return { status: "token_exhausted", exitCode, signal: tokenExhaustion };
  }

  if (timedOut) {
    return {
      status: "timed_out",
      exitCode,
      summary: `Exceeded the ${maxRuntimeMinutes}-minute budget. The branch and checkout are preserved — resume to continue.`,
    };
  }

  // Conventional shell signal exits (128 + signal) are interruptions, not evidence
  // that the agent failed the issue. Service shutdown commonly produces 143 (SIGTERM);
  // treating it as a hard failure generated operator-facing "exited with code 143"
  // noise and bypassed the resumable path.
  if (exitCode === 130 || exitCode === 143) {
    return {
      status: "interrupted",
      exitCode,
      summary: `The agent process was interrupted by signal (exit ${exitCode}). Its work will resume automatically.`,
    };
  }

  if (!sawResult) {
    // We know NOTHING about what the agent achieved — it was killed (a CLI crash, a
    // dropped connection, a restart). Work on disk survives, so this is resumable. This
    // MUST precede the commit/CI branches, whose defaults (0 commits, no CI) would
    // otherwise mark a killed run `failed` — wrong, and NOT resumable.
    return {
      status: "interrupted",
      exitCode,
      summary:
        "The agent process ended before reporting a result. Its branch and checkout are preserved — resume to continue from the plan.",
    };
  }

  if (exitCode === 0 && resultCommits === 0) {
    // A clean exit having committed nothing: the agent gave up. Codex does exactly this
    // when its sandbox cannot start — it reports the blocker in prose and exits 0.
    return {
      status: "failed",
      exitCode: 0,
      summary:
        "The agent exited cleanly but made no commits — it did not complete the work. Check the run output for what stopped it.",
    };
  }

  if (exitCode === 0 && resultCi === "fail") {
    // CI says the PR is broken. The agent's own opinion of its tests is not the deciding
    // vote — it has claimed a green suite while CI was red. Distinct from `failed`: the
    // agent DID its job (produced a PR); the PR's content is what's broken, and that
    // drives the self-heal -> escalate -> exhausted ladder.
    return {
      status: "ci_failed",
      exitCode: 0,
      summary:
        "The agent opened a PR, but its CI is red. The work is not mergeable — see the failing checks in the run output.",
    };
  }

  if (exitCode === 0 && resultCi === "pending") {
    // Parked, not succeeded: the claim stays and the next scan just re-checks CI --
    // relaunching the whole agent to wait on a check that is already running would be
    // pure waste (and, historically, exactly this case looping was silent for hours).
    return {
      status: "ci_pending",
      exitCode: 0,
      summary:
        "The agent opened a PR; CI had not finished when the run ended. The dispatcher will re-check CI on its own, without relaunching the agent, until it resolves.",
    };
  }

  if (exitCode === 0) {
    return { status: "pr_ready", exitCode: 0, summary: null };
  }

  return { status: "failed", exitCode, summary: `The agent exited with code ${exitCode}.` };
}

export function requirePrForDelivery(
  outcome: RunOutcome,
  prNumber: number | null,
): RunOutcome {
  if (outcome.status !== "pr_ready" || prNumber !== null) return outcome;
  return {
    status: "failed",
    exitCode: outcome.exitCode,
    summary:
      "The agent committed work but did not open a pull request. Resume and complete the delivery handoff.",
  };
}

/**
 * Builds the token-exhaustion summary and the concrete suppression window. Pure; the
 * caller persists the cooldown and fires the (single) notification.
 */
export function tokenExhaustionSummary(
  agent: DispatcherAgent,
  signal: TokenExhaustionSignal,
  nowMs: number,
): { summary: string; until: Date } {
  const window = computeSuppressUntil(signal, nowMs);
  const provider = agent === "claude" ? "Claude" : "Codex";
  const reported = window.resetLabel ? ` (${provider} reported: ${window.resetLabel})` : "";
  const summary = window.parseFailed
    ? `${provider} is out of tokens${reported}. The run is preserved and ${provider} dispatching is paused until ${formatResetTime(
        window.until,
      )} (safety fallback).`
    : `${provider} is out of tokens${reported}. The run is preserved and ${provider} dispatching is paused until the reported reset at ${formatResetTime(
        window.until,
      )}.`;
  return { summary, until: window.until };
}

export interface RunnerDeps {
  config: DispatcherConfig;
  store: StateStore;
  logger: Logger;
  notifier: Notifier;
  /** Injectable clock, for deterministic cooldown math in tests. */
  now?: () => number;
}

/**
 * Launches an agent run and supervises it to a terminal state, returning the finalized
 * RunRecord. The state row is the source of truth: the pid, PR, and commit are persisted
 * as their control lines arrive, so a crash mid-run leaves a resumable record.
 *
 * Applying the failure-deferral policy is the dispatcher loop's job (it owns the whole
 * scan), so this returns the terminal record rather than accounting for it here.
 */
export function launchRun(run: RunRecord, deps: RunnerDeps): Promise<RunRecord> {
  const { config, store, logger } = deps;
  const now = deps.now ?? (() => Date.now());

  const spec: AgentLaunchSpec = {
    issueNumber: run.issueNumber,
    agent: run.agent,
    cliModel: run.cliModel,
    cliEffort: run.cliEffort,
    branch: run.branch,
    mode: run.trigger === "resume" ? "resume" : "start",
    maxRuntimeMinutes: config.maxRuntimeMinutes,
  };

  const args = dispatchAgentArgs(DISPATCH_AGENT_SCRIPT, spec);
  const env = { ...process.env, ...dispatchAgentEnv(config, run.failureSummary) };

  logger.info("launching agent", {
    runId: run.id,
    issue: run.issueNumber,
    agent: run.agent,
    model: run.cliModel,
    effort: run.cliEffort,
    branch: run.branch,
    mode: spec.mode,
  });

  return new Promise<RunRecord>((resolve) => {
    // fd 3 is a launcher-only control channel. Provider stdout is untrusted and may
    // contain text that looks exactly like ::result::/::pid::; never parse it as control.
    const child = spawn("bash", args, { env, stdio: ["ignore", "pipe", "pipe", "pipe"] });
    let settled = false;

    let sawResult = false;
    let resultExit = 0;
    let resultCommits = 0;
    let resultCi: CiState = "none";
    let resultDisposition: "normal" | "abandoned" = "normal";
    let tokenExhaustion: TokenExhaustionSignal | null = null;
    let outputSeq = run.outputSeq;
    let launcherTimedOut = false;
    let launcherKillTimer: NodeJS.Timeout | undefined;
    const launcherTimeout = setTimeout(
      () => {
        if (settled || !child.pid) return;
        launcherTimedOut = true;
        terminateProcessTree(child.pid, "SIGTERM");
        launcherKillTimer = setTimeout(
          () => terminateProcessTree(child.pid!, "SIGKILL"),
          30_000,
        );
      },
      launcherTimeoutMs(config.maxRuntimeMinutes),
    );
    if (child.pid) {
      // Persist before the shell's first control record so startup crashes can still
      // identify and terminate an orphaned checkout/npm/gh process tree.
      store.updateRun(run.id, { remotePid: child.pid, status: "running" });
    }

    const handleLine = (
      rawLine: string,
      stream: "stdout" | "stderr",
      trustedControl = false,
    ): void => {
      const line = rawLine.replace(/\r$/, "");
      if (line === "") return;

      const control = parseTrustedControlLine(line, trustedControl);

      // Only ordinary provider output is scanned; control lines are generated by us.
      if (!control && !tokenExhaustion) {
        tokenExhaustion = detectProviderTokenExhaustion(run.agent, line, stream);
      }

      if (control?.kind === "pid") {
        store.updateRun(run.id, { remotePid: control.pid ?? null, status: "running" });
        return;
      }

      if (control?.kind === "event") {
        outputSeq += 1;
        logger.info("event", { runId: run.id, issue: run.issueNumber, message: redact(control.message ?? "") });
        return;
      }

      if (control?.kind === "result" && control.result) {
        sawResult = true;
        resultExit = control.result.exit;
        resultCommits = control.result.commits;
        resultCi = control.result.ci;
        resultDisposition = control.result.disposition;
        const { pr, commit, plan } = control.result;
        store.updateRun(run.id, {
          prUrl: pr || null,
          prNumber: pr ? Number.parseInt(pr.split("/").pop() ?? "", 10) || null : null,
          lastCommit: commit || null,
          planPath: plan || null,
        });
        return;
      }

      for (const rendered of toTerminalLines(line, run.agent)) {
        if (rendered.trim()) {
          outputSeq += 1;
          logger.debug("output", { runId: run.id, line: redact(rendered) });
        }
      }
    };

    child.stdout!.on("data", lineReader((line) => handleLine(line, "stdout")));
    child.stderr!.on("data", lineReader((line) => handleLine(line, "stderr")));
    const controlStream = child.stdio[3];
    if (controlStream && "on" in controlStream) {
      controlStream.on("data", lineReader((line) => handleLine(line, "stdout", true)));
    }

    const finish = (outcome: RunOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(launcherTimeout);
      if (launcherKillTimer) clearTimeout(launcherKillTimer);
      // A clean process exit with commits but no PR is not a delivery handoff. Calling
      // it provisionally shipped makes autoship skip it and leaves a false success.
      // Convert it to an agent failure so the autonomous repair ladder relaunches the
      // agent to push/open the PR.
      const observed = store.getRun(run.id);
      const effectiveOutcome = requirePrForDelivery(outcome, observed?.prNumber ?? null);
      const status: TerminalStatus = effectiveOutcome.status;
      let summary: string | null;

      if (effectiveOutcome.status === "token_exhausted") {
        const { summary: exhaustionSummary, until } = tokenExhaustionSummary(
          run.agent,
          effectiveOutcome.signal,
          now(),
        );
        summary = exhaustionSummary;
        store.setSuppressedUntil(run.agent, until.getTime());
      } else {
        summary = effectiveOutcome.summary;
      }

      const finalized = store.updateRun(run.id, {
        status,
        exitCode: effectiveOutcome.exitCode,
        failureSummary: summary ? redact(summary) : null,
        outputSeq,
        finishedAt: now(),
        finalizationPending: true,
        remotePid: null,
      });

      logger.info("run finished", {
        runId: run.id,
        issue: run.issueNumber,
        status,
        exitCode: effectiveOutcome.exitCode,
      });

      resolve(finalized);
    };

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(launcherTimeout);
      if (launcherKillTimer) clearTimeout(launcherKillTimer);
      logger.error("agent process failed to start", { runId: run.id, error: redact(err.message) });
      const finalized = store.updateRun(run.id, {
        status: "failed",
        exitCode: null,
        failureSummary: redact(`Could not launch the agent: ${err.message}`),
        outputSeq,
        finishedAt: now(),
        finalizationPending: true,
        remotePid: null,
      });
      resolve(finalized);
    });

    child.on("close", (code) => {
      finish(
        classifyRunOutcome({
          closeCode: launcherTimedOut ? 124 : code,
          sawResult,
          resultExit: launcherTimedOut ? 124 : resultExit,
          resultCommits,
          resultCi,
          resultDisposition,
          tokenExhaustion,
          maxRuntimeMinutes: config.maxRuntimeMinutes,
        }),
      );
    });
  });
}

/**
 * Consumes a stream line-by-line. Agent output arrives in arbitrarily-sized buffers, and
 * both the JSON events and the ::control:: protocol are line-oriented, so a partial line
 * must be held back until its newline arrives.
 */
function lineReader(onLine: (line: string) => void): (buffer: Buffer) => void {
  let pending = "";
  return (buffer: Buffer) => {
    pending += buffer.toString();
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) onLine(line);
  };
}
