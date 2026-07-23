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
  PARKED_STATUSES,
  RESUMABLE_STATUSES,
  LADDER_STATUSES,
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
 * starting the issue over; a parked run (ci_pending) also keeps its claim so the next
 * scan just re-checks CI instead of relaunching the agent; a ladder run (ci_failed) is
 * never actually left in this state across a scan boundary in normal operation (the
 * self-heal/escalate ladder resolves it synchronously) but keeps its claim too, so an
 * abnormal case never gets silently double-dispatched. Every other terminal status
 * (shipped, held, failed) frees the issue.
 */
export function shouldReleaseClaim(status: string): boolean {
  return !(
    (RESUMABLE_STATUSES as readonly string[]).includes(status) ||
    (PARKED_STATUSES as readonly string[]).includes(status) ||
    (LADDER_STATUSES as readonly string[]).includes(status)
  );
}

/**
 * Chooses the parked (ci_pending) run to recheck this scan, or null. Oldest-first: the
 * parked runs are already ordered by createdAt. Unlike `selectResumable`, there is no
 * cap or provider-suppression check -- a CI recheck is a single cheap `gh pr checks`
 * call, not a full agent relaunch, so none of the token/resume-budget concerns apply.
 */
export function selectParked(parked: RunRecord[]): RunRecord | null {
  return parked[0] ?? null;
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

  // ── Recheck parked (CI-pending) work ──
  // A parked run holds its issue's claim without any agent process running, so it is
  // checked before fresh work for the same reason resumables are: leaving it parked
  // while starting something new would work, but finishing what is already in flight is
  // the right default. Unlike resuming, this NEVER relaunches the agent -- it is a
  // single `gh pr checks` call re-evaluated through the exact same ship/hold decision
  // (`evaluateAutoship`) a fresh run goes through.
  const parked = selectParked(store.parkedRuns());
  if (parked) {
    if (config.dryRun) {
      return {
        started: null,
        message: `[dry-run] would recheck CI for issue #${parked.issueNumber} (PR #${parked.prNumber ?? "?"}).`,
      };
    }
    await recheckParkedRun(deps, parked);
    return {
      started: store.getRun(parked.id),
      message: `Rechecked CI for issue #${parked.issueNumber}.`,
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
 * Self-heal: relaunches the agent on the same branch to fix a PR whose CI autoship just
 * found red, then finalizes the new terminal run exactly like any other run. Reentry
 * mirrors `resumeRun` (same checkout, same branch, trigger "resume" so dispatch-agent.sh
 * feeds the resumed agent the actual failing checks) but tracks its own counter —
 * `ciSelfHealAttempts` — so the cap is independent of the crash/timeout resume budget.
 * `autoshipRun` is the sole place that decides whether another attempt is warranted; this
 * function only ever executes an attempt it already approved.
 *
 * Recursing into `finalizeRun` lets the new terminal run go through the exact same
 * comment/notify/autoship pipeline as any other run: if the fix worked, autoship ships
 * it; if CI is still red, autoshipRun either allows another self-heal (attempt < cap) or
 * stamps `autoship-held` (cap reached) — the recursion depth is bounded by
 * `ciSelfHealMaxAttempts`.
 */
async function selfHealRun(deps: DispatcherDeps, run: RunRecord, attempt: number): Promise<void> {
  const { config, store, github, logger, notifier } = deps;
  const now = deps.now ?? (() => Date.now());

  const reentered = store.updateRun(run.id, {
    status: "claimed",
    trigger: "resume",
    ciSelfHealAttempts: attempt,
    exitCode: null,
    failureSummary: null,
    finishedAt: null,
  });

  logger.info("self-heal: relaunching agent to fix red CI", {
    runId: run.id,
    issue: run.issueNumber,
    attempt,
  });

  await github.addLabel(run.issueNumber, WORKING_LABEL);

  const terminal = await launchRun(reentered, { config, store, logger, notifier, now });
  await finalizeRun(deps, terminal);
}

/**
 * Escalation: the one-shot follow-up after selfHealRun's budget is exhausted and CI is
 * still red. Relaunches on the same branch/checkout (a resume, exactly like selfHealRun)
 * but overrides the run's agent/model/effort to `cliModel` — resolved via `modelByCliModel`
 * so the launched CLI and its model label stay consistent with the registry entry (an
 * escalation model is necessarily a `claude` model today, but this does not hard-code
 * that). Falls back to "claude" only if the configured model is somehow not in the
 * registry; `config.ts` already validates DISPATCHER_CI_ESCALATION_MODEL at startup, so
 * that fallback is a belt-and-suspenders default, not the expected path. Uses "effort:max"
 * or its per-agent equivalent — a last-resort attempt should not be effort-capped.
 * `run.ciEscalated` is set before launching so autoshipRun never grants a second one.
 */
async function escalateRun(deps: DispatcherDeps, run: RunRecord, cliModel: string): Promise<void> {
  const { config, store, github, logger, notifier } = deps;
  const now = deps.now ?? (() => Date.now());

  const modelEntry = modelByCliModel(cliModel);
  const agent: DispatcherAgent = modelEntry?.cli === "codex" ? "codex" : "claude";
  const modelLabel = modelEntry?.modelLabel ?? cliModel;
  const cliEffort = agent === "claude" ? "xhigh" : "high";

  const reentered = store.updateRun(run.id, {
    status: "claimed",
    trigger: "resume",
    agent,
    modelLabel,
    cliModel,
    effortLabel: "effort:max",
    cliEffort,
    ciEscalated: true,
    exitCode: null,
    failureSummary: null,
    finishedAt: null,
  });

  logger.info("self-heal: escalating to a stronger model", {
    runId: run.id,
    issue: run.issueNumber,
    agent,
    cliModel,
  });

  await github.addLabel(run.issueNumber, WORKING_LABEL);

  const terminal = await launchRun(reentered, { config, store, logger, notifier, now });
  await finalizeRun(deps, terminal);
}

/**
 * Once-only GitHub bookkeeping after a run reaches a terminal state: apply the failure
 * deferral policy, release the working label (unless the run is still resumable/parked),
 * comment on the issue, hand off to `evaluateAutoship` to resolve the real outcome, and
 * send the run notification (except for token exhaustion, which already notified through
 * its own cooldown path, and except when evaluateAutoship just triggered a self-heal/
 * escalation relaunch, whose OWN recursive finalizeRun call will send the real one once
 * that settles).
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

  // evaluateAutoship is the sole authority on whether this run's PR actually ships,
  // stays parked, drives the self-heal ladder, or gets held -- see its own doc comment.
  const { relaunched } = await evaluateAutoship(deps, run);

  // A relaunch's own recursive finalizeRun call (via selfHealRun/escalateRun) sends the
  // real "run finished" notification once IT settles; sending one here too, for a status
  // (ci_failed) that is already stale by the time this line runs, would just be a
  // misleading extra push moments before the accurate one.
  if (relaunched) return;

  // Re-read: evaluateAutoship may have just changed run.status (shipped/ci_pending/held)
  // in the store -- `run` above is a snapshot from before that call.
  const finalRun = store.getRun(run.id) ?? run;

  // Token exhaustion already sent its single notification through the cooldown path;
  // re-sending here would defeat the one-alert-per-window guarantee.
  if (finalRun.status !== "token_exhausted") {
    const priority =
      finalRun.status === "shipped" || finalRun.status === "ci_pending"
        ? NOTIFY_PRIORITY_DEFAULT
        : NOTIFY_PRIORITY_HIGH;
    notifier
      .send(
        `Dispatcher: #${finalRun.issueNumber} ${finalRun.status.replace("_", " ")}`,
        finalRun.prUrl ? `PR: ${finalRun.prUrl}` : (finalRun.failureSummary ?? finalRun.issueTitle),
        priority,
      )
      .catch(() => undefined);
  }
}

/**
 * Runs the autoship decision for one run and applies its outcome to the persisted
 * status. This is the ONLY place a run's status becomes `shipped` or `held`, and the
 * only place `ci_pending`/`ci_failed` transition based on a fresh CI read. Called both
 * right after a fresh/resumed/self-healed/escalated run finishes (from `finalizeRun`)
 * and again on every parked recheck (`recheckParkedRun`, WITHOUT going through
 * `finalizeRun` at all) -- so it must be safe and cheap to call repeatedly against the
 * same run.id, and it owns its own comment/notify for every outcome (autoshipRun's
 * internal paths already do this for shipped/held/self-heal/escalate; only the
 * still-pending recheck path is deliberately silent).
 *
 * Returns whether it triggered a self-heal/escalation relaunch, so `finalizeRun` knows
 * whether its own tail notification would just be stale noise.
 */
async function evaluateAutoship(deps: DispatcherDeps, run: RunRecord): Promise<{ relaunched: boolean }> {
  const { store, github, notifier, logger } = deps;

  if (!deps.ship) {
    // Autoship not configured for this repo: nothing will ever merge + deploy
    // automatically, and there is no self-heal ladder without it. Map the agent's own
    // preliminary classification onto the closest available terminal meaning, rather
    // than leaving a "shipped" run pretending to be a real success or a "ci_failed" run
    // stuck in a status this configuration can never resolve: a green PR is left for a
    // human to review and merge manually (`held`); a red PR falls back to the plain
    // `failed` accounting the dispatcher used before the self-heal ladder existed.
    // `ci_pending` stands as-is -- parking and cheaply re-checking CI is a universal
    // improvement that does not depend on autoship being configured.
    if (run.status === "shipped") store.updateRun(run.id, { status: "held" });
    else if (run.status === "ci_failed") store.updateRun(run.id, { status: "failed" });
    return { relaunched: false };
  }

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
        ciSelfHealMaxAttempts: deps.config.ciSelfHealMaxAttempts,
        ciEscalationModel: deps.config.ciEscalationModel,
      },
      run,
    );
    logger.info("autoship outcome", { runId: run.id, issue: run.issueNumber, action: outcome.action });

    switch (outcome.action) {
      case "shipped":
        store.updateRun(run.id, { status: "shipped" });
        return { relaunched: false };
      case "ci_not_green":
        if (outcome.state === "pending") {
          // Only touch the record on the TRANSITION into parked -- a recheck that finds
          // it still pending must stay silent and cheap, not re-write every ~15 minutes
          // while nothing has actually changed.
          if (run.status !== "ci_pending") store.updateRun(run.id, { status: "ci_pending" });
        } else {
          // Self-heal and escalation are both exhausted; autoshipRun already stamped
          // autoship-held and commented in that case.
          store.updateRun(run.id, { status: "held" });
        }
        return { relaunched: false };
      case "ci_self_heal":
        store.updateRun(run.id, { status: "ci_failed" });
        await selfHealRun(deps, run, outcome.attempt);
        return { relaunched: true };
      case "ci_escalate":
        store.updateRun(run.id, { status: "ci_failed" });
        await escalateRun(deps, run, outcome.model);
        return { relaunched: true };
      case "held":
      case "merge_blocked":
      case "conflict_recovery_failed":
      case "ship_failed":
        store.updateRun(run.id, { status: "held" });
        return { relaunched: false };
      case "skipped":
        return { relaunched: false };
    }
  } catch (err) {
    // An autoship failure must never break the loop; it has its own ntfy path.
    logger.error("autoship threw", {
      runId: run.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return { relaunched: false };
  }
}

/**
 * Re-examines a parked (ci_pending) run's PR without relaunching the agent -- just a
 * fresh CI check via `evaluateAutoship`. If CI has resolved, this proceeds exactly like
 * a fresh run's autoship evaluation (ship it, or start the self-heal ladder); if still
 * pending, the run stays parked and the next scan checks again. Deliberately does NOT
 * go through `finalizeRun` -- there is no new agent run to record telemetry for or post
 * a "run finished" comment about, and evaluateAutoship already owns its own comment/
 * notify for every outcome that actually changes.
 */
export async function recheckParkedRun(deps: DispatcherDeps, run: RunRecord): Promise<void> {
  deps.logger.info("rechecking parked run's CI", { runId: run.id, issue: run.issueNumber });
  await evaluateAutoship(deps, run);
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

/**
 * Builds the issue comment for a finished run. `run.status` here is always the
 * PROVISIONAL classification from classifyRunOutcome (runner.ts) -- posted before
 * evaluateAutoship gets a chance to confirm/override it, so "shipped" at this point
 * means "CI was green when the agent finished," not "actually merged and deployed
 * yet." autoship's own follow-up comment (self-heal / escalate / held / shipped)
 * clarifies the real outcome moments later.
 */
export function buildIssueComment(
  run: RunRecord,
  resumable: boolean,
  deferralSummary: string | null,
): string {
  const statusLabel =
    run.status === "shipped" ? "complete — CI green, handing off to autoship" : run.status.replace("_", " ");
  const header = `🤖 **Dispatcher run ${statusLabel}** — ${run.agent} (\`${run.cliModel}\`, effort \`${run.cliEffort}\`)`;

  const lines = [header, ""];
  lines.push(`- Branch: \`${run.branch}\``);
  if (run.lastCommit) lines.push(`- Last commit: \`${run.lastCommit}\``);
  if (run.planPath) lines.push(`- Plan: \`${run.planPath}\``);
  if (run.prUrl) lines.push(`- Pull request: ${run.prUrl}`);
  if (run.failureSummary) lines.push(`- Result: ${run.failureSummary}`);
  if (deferralSummary) lines.push(`- Queue deferral: ${deferralSummary}`);

  lines.push("");
  if (run.status === "ci_pending") {
    lines.push(
      "CI had not finished when the run ended. The dispatcher will check back once CI resolves — " +
        "it will NOT relaunch the agent while waiting.",
    );
  } else if (run.status === "ci_failed") {
    lines.push(
      "CI is red. The dispatcher is relaunching the agent to diagnose and fix it (self-heal), " +
        "escalating to a stronger model if that does not resolve it, before holding for a human.",
    );
  } else if (resumable) {
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
