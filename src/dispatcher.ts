/**
 * The scan/claim/launch/resume/reconcile loop (ported from the embedded dispatcher's
 * service.ts, #188/#232/#245/#249/#281).
 *
 * The standalone service is a single long-running process, so concurrency control is far
 * simpler than the embedded version's Postgres partial-unique-index claims: the state
 * store's single-instance lock guarantees one dispatcher, and `launchRun` runs the agent
 * to completion before the loop continues — the dispatcher is strictly serial by
 * construction, so no in-flight claim race is possible.
 *
 * Each scan: finish resumable work first, then pick at most one fresh issue by priority
 * tier, claim it, launch it, do the once-only GitHub bookkeeping, and prune. The pure
 * decision points are exported so they are unit-testable without a real agent or GitHub.
 */

import {
  RESUMABLE_STATUSES,
  WORKING_LABEL,
  branchNameFor,
  type DispatcherAgent,
} from "./labels.ts";
import { selectEligibleIssue } from "./selection.ts";
import { untrustedAuthorComment, UNTRUSTED_AUTHOR_LABEL } from "./author-auth.ts";
import { isProviderSuppressed, formatResetTime } from "./token-exhaustion.ts";
import {
  getBlockingIssueDeferrals,
  recordTerminalRunOutcome,
  type IssueFailureRecord,
} from "./failure-policy.ts";
import { launchRun } from "./runner.ts";
import { join } from "node:path";
import { NOTIFY_PRIORITY_DEFAULT, NOTIFY_PRIORITY_HIGH, type Notifier } from "./notify.ts";
import { autoshipRun, type ShipRunner } from "./autoship.ts";
import { modelByCliModel } from "./models.ts";
import { UNAVAILABLE_TOKENS, type AttemptRecord, type TelemetryStore } from "./telemetry.ts";
import type { GithubClient, GithubIssue } from "./github.ts";
import type { DispatcherConfig } from "./config.ts";
import type { Logger } from "./logger.ts";
import type { StateStore, RunRecord } from "./state.ts";

/**
 * How many times the dispatcher relaunches a run by itself before leaving it for a
 * human. Without a cap a run that dies instantly would be resurrected forever; with one,
 * a genuinely stuck issue stops burning tokens and waits to be looked at.
 */
export const MAX_AUTO_RESUMES = 3;

export interface DispatcherDeps {
  config: DispatcherConfig;
  store: StateStore;
  github: GithubClient;
  logger: Logger;
  notifier: Notifier;
  /**
   * Runs the repo-specific autoship command. Optional: when omitted, or when
   * config.autoshipCmd is null, autoship is inert and every run stops at its PR.
   */
  ship?: ShipRunner;
  /** Optional evidence store; when present, every terminal run records an attempt (#319). */
  telemetry?: TelemetryStore;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
}

export interface ScanResult {
  started: RunRecord | null;
  message: string;
}

async function markUntrustedAuthorIssuesOnce(
  deps: DispatcherDeps,
  issues: GithubIssue[],
  candidates: { issueNumber: number; eligible: boolean; reason: string }[],
): Promise<void> {
  const byNumber = new Map(issues.map((issue) => [issue.number, issue]));
  const blocked = candidates.filter(
    (candidate) => !candidate.eligible && candidate.reason.startsWith("untrusted issue author "),
  );

  for (const candidate of blocked) {
    const issue = byNumber.get(candidate.issueNumber);
    if (!issue || issue.labels.includes(UNTRUSTED_AUTHOR_LABEL)) continue;

    await deps.github.addLabel(issue.number, UNTRUSTED_AUTHOR_LABEL);
    await deps.github.comment(issue.number, untrustedAuthorComment(issue.authorLogin));
    deps.logger.warn("blocked issue from untrusted author", {
      issue: issue.number,
      author: issue.authorLogin ?? undefined,
    });
  }
}

/**
 * Chooses the resumable run to pick up this scan, or null. A run is eligible only when
 * its provider is not in a token cooldown and it is still under the auto-resume cap.
 * Oldest-first: the resumables are already ordered by createdAt.
 */
export function selectResumable(
  resumables: RunRecord[],
  isSuppressed: (agent: DispatcherAgent) => boolean,
  maxResumes: number,
): RunRecord | null {
  return resumables.find((run) => !isSuppressed(run.agent) && run.resumeCount < maxResumes) ?? null;
}

/**
 * Whether a terminal run releases its issue claim. A resumable run (interrupted /
 * timed_out / token_exhausted) KEEPS its claim so the next scan resumes it rather than
 * starting the issue over; every other terminal status frees the issue.
 */
export function shouldReleaseClaim(status: string): boolean {
  return !(RESUMABLE_STATUSES as readonly string[]).includes(status);
}

/** Runs a single scan: resume first, else claim and launch at most one fresh issue. */
export async function runScanOnce(deps: DispatcherDeps): Promise<ScanResult> {
  const { config, store, github, logger, notifier } = deps;
  const now = deps.now ?? (() => Date.now());
  const nowMs = now();

  // Serial guard. The store lock already guarantees one dispatcher process, but an
  // active row means a previous scan's run is (or was) in flight — never start a second.
  const active = store.activeRun();
  if (active) {
    return { started: null, message: `A run is already active (issue #${active.issueNumber}).` };
  }

  const settings = store.getSettings();
  const suppressedUntil = (agent: DispatcherAgent): Date | null => {
    const raw = agent === "claude" ? settings.claudeSuppressedUntil : settings.codexSuppressedUntil;
    return raw === null ? null : new Date(raw);
  };
  const isSuppressed = (agent: DispatcherAgent): boolean =>
    isProviderSuppressed(suppressedUntil(agent), nowMs);

  // ── Resume first ──
  // A resumable run holds its issue's claim, so leaving it parked while we pick up fresh
  // work would quietly abandon it. Interrupted/timed-out runs get the next slot.
  const resumable = selectResumable(store.resumableRuns(), isSuppressed, MAX_AUTO_RESUMES);
  if (resumable) {
    if (config.dryRun) {
      return {
        started: null,
        message: `[dry-run] would resume issue #${resumable.issueNumber} (${resumable.agent}).`,
      };
    }
    const resumed = await resumeRun(deps, resumable);
    return {
      started: resumed,
      message: `Resumed the interrupted run on issue #${resumable.issueNumber} before starting new work.`,
    };
  }

  // ── Fresh work ──
  const listing = await github.listOpenIssues();
  if (!listing.ok) {
    return { started: null, message: `Could not list issues: ${listing.error}` };
  }

  const claimedByIssue = store.claimingRunsByIssue();
  const deferredByIssue = getBlockingIssueDeferrals(store.issueFailures(), nowMs);

  const { candidates, target } = selectEligibleIssue(listing.issues, {
    providerSuppressed: (agent) => isSuppressed(agent),
    suppressedReason: (agent) => {
      const until = suppressedUntil(agent);
      const provider = agent === "claude" ? "Claude" : "Codex";
      return `${provider} is out of tokens — paused until ${until ? formatResetTime(until) : "reset"}`;
    },
    claimedByIssue,
    deferredByIssue,
    authorAuth: config.authorAuth,
  });

  if (!config.dryRun) {
    await markUntrustedAuthorIssuesOnce(deps, listing.issues, candidates);
  }

  logger.debug("scan evaluated issues", {
    total: listing.issues.length,
    eligible: candidates.filter((c) => c.eligible).length,
  });

  if (!target) {
    return { started: null, message: "No eligible issues." };
  }

  const { issue } = target;
  const { agent, modelLabel, cliModel, effortLabel, cliEffort } = target.assignment;
  const branch = branchNameFor(issue.number, issue.title);

  if (config.dryRun) {
    return {
      started: null,
      message: `[dry-run] would start ${agent} (${cliModel}, effort ${cliEffort}) on issue #${issue.number} — branch ${branch}.`,
    };
  }

  if (target.staleWorkingLabel) {
    // The label says an agent is on it, but no run of ours claims it — a stale label from
    // a removal that failed or a run killed before cleanup. Heal it rather than letting it
    // wedge the issue out of the queue forever.
    await github.removeLabel(issue.number, WORKING_LABEL);
    logger.warn("cleared a stale agent-working label", { issue: issue.number });
  }

  // The claim IS the run row insert; the store enforces serial + no-double-claim.
  const run = store.createRun({
    issueNumber: issue.number,
    issueTitle: issue.title.slice(0, 500),
    issueUrl: issue.url,
    agent,
    modelLabel,
    cliModel,
    effortLabel,
    cliEffort,
    branch,
    checkoutPath: join(config.worktreeDir, branch),
    planPath: null,
    trigger: "poll",
  });

  logger.info("claimed issue", { runId: run.id, issue: issue.number, agent, cliModel, cliEffort });

  // Label after claiming: the state row is the authoritative lock, and a failed label
  // write must not leave us thinking the claim failed.
  await github.addLabel(issue.number, WORKING_LABEL);
  notifier
    .send(`Dispatcher: ${agent} started #${issue.number}`, issue.title, NOTIFY_PRIORITY_DEFAULT)
    .catch(() => undefined);

  const terminal = await launchRun(run, { config, store, logger, notifier, now });
  await finalizeRun(deps, terminal);
  pruneOldRuns(deps);

  return { started: terminal, message: `Ran ${agent} on issue #${issue.number}.` };
}

/** Re-enters the SAME run record in resume mode; the branch, checkout, and plan carry over. */
export async function resumeRun(deps: DispatcherDeps, run: RunRecord): Promise<RunRecord> {
  const { config, store, github, logger, notifier } = deps;
  const now = deps.now ?? (() => Date.now());

  // Did the last attempt DO anything? A run that produced output was working and got
  // killed; a run that produced nothing is dying on the launchpad. Only the second kind
  // burns tokens for nothing, so only it counts against the resume cap — otherwise a run
  // of restarts strands real work (embedded #193).
  const madeProgress = run.outputSeq > run.lastProgressSeq;

  const reentered = store.updateRun(run.id, {
    status: "claimed",
    trigger: "resume",
    resumeCount: madeProgress ? 0 : run.resumeCount + 1,
    lastProgressSeq: run.outputSeq,
    exitCode: null,
    failureSummary: null,
    finishedAt: null,
  });

  logger.info("resuming run", {
    runId: run.id,
    issue: run.issueNumber,
    resumeCount: reentered.resumeCount,
    madeProgress,
  });

  await github.addLabel(run.issueNumber, WORKING_LABEL);

  const terminal = await launchRun(reentered, { config, store, logger, notifier, now });
  await finalizeRun(deps, terminal);
  return terminal;
}

/**
 * Once-only GitHub bookkeeping after a run reaches a terminal state: apply the failure
 * deferral policy, release the working label (unless the run is still resumable), comment
 * on the issue, and send the run notification (except for token exhaustion, which already
 * notified through its own cooldown path).
 */
export async function finalizeRun(deps: DispatcherDeps, run: RunRecord): Promise<void> {
  const { store, github, logger, notifier } = deps;
  const now = deps.now ?? (() => Date.now());

  if (run.status === "abandoned") return;

  // Record the attempt-level evidence for this terminal run (#319). Best-effort: an
  // evidence-store failure must never break the dispatch loop, exactly like notifications.
  if (deps.telemetry) {
    try {
      deps.telemetry.recordAttempt(attemptRecordFromRun(run, now()));
    } catch (err) {
      logger.warn("telemetry record failed", {
        runId: run.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const accounting = recordTerminalRunOutcome(store.issueFailures(), run, now());
  store.setIssueFailures(accounting.records);
  if (accounting.notification) {
    notifier
      .send(accounting.notification.title, accounting.notification.body, NOTIFY_PRIORITY_HIGH)
      .catch(() => undefined);
  }

  const resumable = !shouldReleaseClaim(run.status);
  if (!resumable) {
    await github.removeLabel(run.issueNumber, WORKING_LABEL);
  }

  await github.comment(run.issueNumber, buildIssueComment(run, resumable, accounting.summary));

  logger.info("run finalized", { runId: run.id, issue: run.issueNumber, status: run.status });

  // Autoship: for a green-CI PR success, merge + deploy behind the data-loss gate. Inert
  // unless both a ship runner and config.autoshipCmd are present; self-guards otherwise.
  if (deps.ship) {
    try {
      const outcome = await autoshipRun(
        {
          github,
          ship: deps.ship,
          notifier,
          logger,
          autoshipCmd: deps.config.autoshipCmd,
          autoshipDeploymentCheckout: deps.config.autoshipDeploymentDir,
          repoSlug: deps.config.repo.slug,
          generatedConflictAllowlist: deps.config.generatedConflictAllowlist,
          generatedConflictRegenCmd: deps.config.generatedConflictRegenCmd,
          generatedConflictMaxAttempts: deps.config.generatedConflictMaxAttempts,
          generatedConflictCiWaitSeconds: deps.config.generatedConflictCiWaitSeconds,
        },
        run,
      );
      logger.info("autoship outcome", { runId: run.id, issue: run.issueNumber, action: outcome.action });
    } catch (err) {
      // An autoship failure must never break the loop; it has its own ntfy path.
      logger.error("autoship threw", {
        runId: run.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Token exhaustion already sent its single notification through the cooldown path;
  // re-sending here would defeat the one-alert-per-window guarantee.
  if (run.status !== "token_exhausted") {
    const priority = run.status === "succeeded" ? NOTIFY_PRIORITY_DEFAULT : NOTIFY_PRIORITY_HIGH;
    notifier
      .send(
        `Dispatcher: #${run.issueNumber} ${run.status.replace("_", " ")}`,
        run.prUrl ? `PR: ${run.prUrl}` : (run.failureSummary ?? run.issueTitle),
        priority,
      )
      .catch(() => undefined);
  }
}

/**
 * Maps a terminal run to an attempt-level telemetry record (#319). Deliberately honest
 * about what the dispatcher actually observes: token counts are `unavailable` (the
 * launcher control protocol emits none), and fields the run record does not carry
 * (issue-characteristic labels, routing confidence, manual override) are left empty rather
 * than fabricated. A resume re-enters the same run id, so the attempt id is disambiguated
 * by the terminal timestamp — `resumeCount` alone is not unique because a resume that made
 * progress resets it to 0, which would collide with the first attempt.
 */
export function attemptRecordFromRun(run: RunRecord, nowMs: number): AttemptRecord {
  const model = modelByCliModel(run.cliModel);
  const activeDurationMs =
    run.finishedAt !== null ? Math.max(0, run.finishedAt - run.startedAt) : null;
  return {
    issueNumber: run.issueNumber,
    attemptId: `${run.id}#${run.resumeCount}@${run.finishedAt ?? nowMs}`,
    provider: model?.provider ?? run.agent,
    modelRequested: run.cliModel,
    modelUsed: null,
    selectedModelLabel: run.modelLabel,
    issueCharacteristicLabels: [],
    routingRationaleLabels: [],
    routingConfidence: null,
    capacityStateAtAssignment: null,
    startedAt: run.startedAt,
    endedAt: run.finishedAt,
    activeDurationMs,
    tokens: UNAVAILABLE_TOKENS,
    cliExitCode: run.exitCode,
    retryReason: run.trigger === "resume" ? "resume" : null,
    testsRun: false,
    testsPassed: null,
    prCreated: Boolean(run.prUrl),
    humanInterventionRequired: false,
    frontierModelUsed: model?.frontier ?? false,
    manualOverride: false,
    terminalStatus: run.status,
  };
}

/** Builds the issue comment for a finished run. */
export function buildIssueComment(
  run: RunRecord,
  resumable: boolean,
  deferralSummary: string | null,
): string {
  const header =
    run.status === "succeeded"
      ? `🤖 **Dispatcher run complete** — ${run.agent} (\`${run.cliModel}\`, effort \`${run.cliEffort}\`)`
      : `🤖 **Dispatcher run ${run.status.replace("_", " ")}** — ${run.agent} (\`${run.cliModel}\`, effort \`${run.cliEffort}\`)`;

  const lines = [header, ""];
  lines.push(`- Branch: \`${run.branch}\``);
  if (run.lastCommit) lines.push(`- Last commit: \`${run.lastCommit}\``);
  if (run.planPath) lines.push(`- Plan: \`${run.planPath}\``);
  if (run.prUrl) lines.push(`- Pull request: ${run.prUrl}`);
  if (run.failureSummary) lines.push(`- Result: ${run.failureSummary}`);
  if (deferralSummary) lines.push(`- Queue deferral: ${deferralSummary}`);

  lines.push("");
  if (resumable) {
    lines.push(
      "The branch and checkout are preserved. The dispatcher will resume this run on its next " +
        "scan, continuing from the first milestone without a `[DONE]` marker — completed work is not redone.",
    );
  } else if (run.status === "failed") {
    lines.push(
      "The run was not retried automatically. It will be picked up again once the cause is understood, " +
        "or after its failure-deferral window clears.",
    );
  }

  return lines.join("\n");
}

/**
 * Startup reconciliation. A run left `claimed`/`running` in the state file with no live
 * process is the signature of a crash or restart. Its work still exists on disk, so it
 * becomes `interrupted` (resumable) — never silently reset, never relaunched from scratch.
 */
export function reconcile(deps: DispatcherDeps): void {
  const { store, logger } = deps;
  const now = deps.now ?? (() => Date.now());

  for (const run of store.allRuns()) {
    if (run.status !== "claimed" && run.status !== "running") continue;
    store.updateRun(run.id, {
      status: "interrupted",
      exitCode: null,
      failureSummary:
        "The dispatcher restarted while this run was in flight. Its branch and checkout are preserved — it will resume on the next scan.",
      finishedAt: now(),
    });
    logger.warn("reconciled an orphaned run as interrupted", {
      runId: run.id,
      issue: run.issueNumber,
    });
  }
}

/**
 * Retention: keep only the most recent runs in the state file so it does not grow without
 * bound. Active/resumable runs are always kept regardless of age — dropping one would
 * lose a live claim.
 */
export const RUN_RETENTION = 100;

export function pruneOldRuns(deps: DispatcherDeps): void {
  const { store } = deps;
  const runs = store.allRuns();
  if (runs.length <= RUN_RETENTION) return;
  store.pruneRuns(runsToKeep(runs, RUN_RETENTION));
}

/** Filters a run set to only those that should survive a prune — pure, for tests. */
export function runsToKeep(runs: RunRecord[], budget: number): Set<string> {
  const keep = new Set<string>();
  for (const run of runs) {
    if (run.status === "claimed" || run.status === "running" || !shouldReleaseClaim(run.status)) {
      keep.add(run.id);
    }
  }
  const terminal = runs
    .filter((r) => !keep.has(r.id))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, Math.max(0, budget - keep.size));
  for (const run of terminal) keep.add(run.id);
  return keep;
}

/** Re-export so tests referencing the record shape do not reach into failure-policy. */
export type { IssueFailureRecord };
