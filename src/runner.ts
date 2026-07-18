/**
 * Agent process supervision (ported from the embedded dispatcher's runner.ts, #188).
 *
 * The standalone service runs DIRECTLY on the dev server, so there is no SSH hop: the
 * runner spawns the bundled `dispatch-agent.sh` with an argv ARRAY — no shell string is
 * ever assembled. Every argument is a validated scalar (issue number, allowlisted model,
 * branch); issue text never appears on the command line, because the agent fetches the
 * issue itself once it is running.
 *
 * The runner reads the script's line-oriented control protocol on stdout
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
import { NOTIFY_PRIORITY_HIGH, type Notifier } from "./notify.ts";

/** The bundled script the runner launches — resolved relative to this module. */
export const DISPATCH_AGENT_SCRIPT = fileURLToPath(
  new URL("../scripts/dispatch-agent.sh", import.meta.url),
);

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
export function dispatchAgentEnv(config: DispatcherConfig): Record<string, string> {
  const env: Record<string, string> = {
    DISPATCHER_REPO: config.repo.slug,
    // Legacy alias the ported script also accepts, kept so a hand-run stays compatible.
    DISPATCHER_REPO_SLUG: config.repo.slug,
    DISPATCHER_REPO_DIR: config.repoDir,
    DISPATCHER_WORKTREE_DIR: config.worktreeDir,
  };
  if (config.envSourceDir) env.DISPATCHER_ENV_SOURCE_DIR = config.envSourceDir;
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
  /** First provider token-exhaustion signal seen this run, if any. */
  tokenExhaustion: TokenExhaustionSignal | null;
  /** For the timed-out summary message. */
  maxRuntimeMinutes: number;
}

export type TerminalStatus =
  | "succeeded"
  | "failed"
  | "timed_out"
  | "interrupted"
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
 *   5. clean exit, CI red (not mergeable)
 *   6. clean exit, CI pending (succeeded but unverified)
 *   7. clean exit (succeeded)
 *   8. non-zero exit (failed)
 */
export function classifyRunOutcome(signals: RunSignals): RunOutcome {
  const {
    closeCode,
    sawResult,
    resultExit,
    resultCommits,
    resultCi,
    tokenExhaustion,
    maxRuntimeMinutes,
  } = signals;

  const exitCode = sawResult ? resultExit : (closeCode ?? 1);

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
    // vote — it has claimed a green suite while CI was red.
    return {
      status: "failed",
      exitCode: 0,
      summary:
        "The agent opened a PR, but its CI is red. The work is not mergeable — see the failing checks in the run output.",
    };
  }

  if (exitCode === 0 && resultCi === "pending") {
    return {
      status: "succeeded",
      exitCode: 0,
      summary:
        "The agent opened a PR, but CI had not finished when the run ended — the result is unverified. Check the PR before trusting it.",
    };
  }

  if (exitCode === 0) {
    return { status: "succeeded", exitCode: 0, summary: null };
  }

  return { status: "failed", exitCode, summary: `The agent exited with code ${exitCode}.` };
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
  const { config, store, logger, notifier } = deps;
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
  const env = { ...process.env, ...dispatchAgentEnv(config) };

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
    const child = spawn("bash", args, { env, stdio: ["ignore", "pipe", "pipe"] });

    let sawResult = false;
    let resultExit = 0;
    let resultCommits = 0;
    let resultCi: CiState = "none";
    let tokenExhaustion: TokenExhaustionSignal | null = null;
    let outputSeq = run.outputSeq;

    const handleLine = (rawLine: string, stream: "stdout" | "stderr"): void => {
      const line = rawLine.replace(/\r$/, "");
      if (line === "") return;

      const control = parseControlLine(line);

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

    child.stdout.on("data", lineReader((line) => handleLine(line, "stdout")));
    child.stderr.on("data", lineReader((line) => handleLine(line, "stderr")));

    const finish = (outcome: RunOutcome): void => {
      const status: TerminalStatus = outcome.status;
      let summary: string | null;

      if (outcome.status === "token_exhausted") {
        const { summary: exhaustionSummary, until } = tokenExhaustionSummary(
          run.agent,
          outcome.signal,
          now(),
        );
        summary = exhaustionSummary;
        store.setSuppressedUntil(run.agent, until.getTime());
        notifier
          .send(
            `Dispatcher: ${run.agent === "claude" ? "Claude" : "Codex"} out of tokens`,
            exhaustionSummary,
            NOTIFY_PRIORITY_HIGH,
          )
          .catch(() => undefined);
      } else {
        summary = outcome.summary;
      }

      const finalized = store.updateRun(run.id, {
        status,
        exitCode: outcome.exitCode,
        failureSummary: summary ? redact(summary) : null,
        outputSeq,
        finishedAt: now(),
      });

      logger.info("run finished", {
        runId: run.id,
        issue: run.issueNumber,
        status,
        exitCode: outcome.exitCode,
      });

      resolve(finalized);
    };

    child.on("error", (err) => {
      logger.error("agent process failed to start", { runId: run.id, error: redact(err.message) });
      const finalized = store.updateRun(run.id, {
        status: "failed",
        exitCode: null,
        failureSummary: redact(`Could not launch the agent: ${err.message}`),
        outputSeq,
        finishedAt: now(),
      });
      resolve(finalized);
    });

    child.on("close", (code) => {
      finish(
        classifyRunOutcome({
          closeCode: code,
          sawResult,
          resultExit,
          resultCommits,
          resultCi,
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
