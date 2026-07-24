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
  CLAIMING_STATUSES,
  WORKING_LABEL,
  branchNameFor,
  type DispatcherAgent,
} from "./labels.ts";
import { selectEligibleIssue } from "./selection.ts";
import { untrustedAuthorComment, UNTRUSTED_AUTHOR_LABEL } from "./author-auth.ts";
import { isProviderSuppressed, formatResetTime } from "./token-exhaustion.ts";
import { launchRun } from "./runner.ts";
import { join } from "node:path";
import { NOTIFY_PRIORITY_HIGH, type Notifier } from "./notify.ts";
import { autoshipRun, AUTOSHIP_HELD_LABEL, type ShipRunner } from "./autoship.ts";
import { modelByCliModel } from "./models.ts";
import { UNAVAILABLE_TOKENS, type AttemptRecord, type TelemetryStore } from "./telemetry.ts";
import type { GithubClient, GithubIssue } from "./github.ts";
import type { DispatcherConfig } from "./config.ts";
import type { Logger } from "./logger.ts";
import type { StateStore, RunRecord } from "./state.ts";
import {
  decideRecovery,
  updateRecovery,
  type RecoveryKind,
} from "./recovery-policy.ts";

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
 * Whether a terminal run has stopped actively working — i.e. the dispatcher should drop
 * its `agent-working` label and NOT promise an automatic agent resume in the issue
 * comment. A resumable run (interrupted / timed_out / token_exhausted) is still working
 * (the next scan relaunches the agent); a parked run (ci_pending) is waiting on a CI
 * recheck; a ladder run (ci_failed) is mid-self-heal. All three keep `agent-working`. Every
 * other terminal status (shipped, held, failed) is done working, so this returns true.
 *
 * NOTE: this is NOT the same question as "does the run keep its ISSUE claim" — that is
 * `CLAIMING_STATUSES` (state.ts), which additionally includes `held`. A held run has no
 * agent working (so this returns true, dropping the label) yet still holds its claim, so
 * the issue is not re-dispatched from scratch while a human decides — clearing
 * `autoship-held` resumes autoship of the existing PR instead (`recheckHeldRun`).
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
  const resumableRuns = store.resumableRuns();
  const resumable = selectResumable(resumableRuns, isSuppressed, MAX_AUTO_RESUMES);
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

  // A crash/timeout that reaches the ordinary resume cap must not become a silent,
  // permanently claiming zombie. Escalate it to the frontier once; if that attempt also
  // reaches the cap, this is genuine exhaustion and the operator gets the single page.
  const capped = resumableRuns.find(
    (run) => !isSuppressed(run.agent) && run.resumeCount >= MAX_AUTO_RESUMES,
  );
  if (capped) {
    if (config.dryRun) {
      return {
        started: null,
        message: `[dry-run] would escalate exhausted resumes for issue #${capped.issueNumber}.`,
      };
    }
    const agentRecovery = capped.recovery?.agent;
    if (agentRecovery?.escalated) {
      await exhaustRun(
        deps,
        capped,
        "agent",
        `The process remained interrupted after ${MAX_AUTO_RESUMES} frontier resume attempts.`,
      );
    } else {
      const prepared = store.updateRun(capped.id, {
        recovery: updateRecovery(capped.recovery, "agent", {
          attempts: config.ciSelfHealMaxAttempts,
        }),
      });
      await escalateRun(
        deps,
        prepared,
        config.ciEscalationModel,
        "agent",
        `The process remained interrupted after ${MAX_AUTO_RESUMES} resume attempts.`,
      );
    }
    return {
      started: store.getRun(capped.id),
      message: `Escalated exhausted resumes for issue #${capped.issueNumber}.`,
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

  // ── Resume autoship for an un-held PR ──
  // A held run keeps its issue claim, so a human clearing `autoship-held` no longer makes
  // the issue eligible for a fresh-from-scratch re-dispatch (issue #10) — instead the
  // dispatcher resumes autoship of the ready PR that is already there. Checked before fresh
  // work for the same reason resumables/parked are: finish what is already in flight first.
  // Reads at most one label set per held run; a still-held run is a cheap no-op. Skipped in
  // dry-run, which must never merge/deploy anything.
  if (!config.dryRun) {
    for (const run of store.heldRuns()) {
      const { rechecked } = await recheckHeldRun(deps, run);
      if (rechecked) {
        return {
          started: store.getRun(run.id),
          message: `Resumed autoship for un-held issue #${run.issueNumber} (PR #${run.prNumber ?? "?"}).`,
        };
      }
    }
  }

  // ── Fresh work ──
  const listing = await github.listOpenIssues();
  if (!listing.ok) {
    return { started: null, message: `Could not list issues: ${listing.error}` };
  }

  const claimedByIssue = store.claimingRunsByIssue();
  const { candidates, target } = selectEligibleIssue(listing.issues, {
    providerSuppressed: (agent) => isSuppressed(agent),
    suppressedReason: (agent) => {
      const until = suppressedUntil(agent);
      const provider = agent === "claude" ? "Claude" : "Codex";
      return `${provider} is out of tokens — paused until ${until ? formatResetTime(until) : "reset"}`;
    },
    claimedByIssue,
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
 * Relaunch the assigned agent on the same branch to repair one owned delivery phase.
 * Agent, CI, merge/conflict, and deploy recovery have independent counters in the
 * unified ledger, so success in one phase cannot consume another phase's repair budget.
 * Recursing through `finalizeRun` is bounded by the recovery policy and preserves the
 * normal classification, telemetry, and autoship path for every attempt.
 */
async function repairRun(
  deps: DispatcherDeps,
  run: RunRecord,
  kind: RecoveryKind,
  attempt: number,
  reason: string,
): Promise<void> {
  const { config, store, github, logger, notifier } = deps;
  const now = deps.now ?? (() => Date.now());

  const reentered = store.updateRun(run.id, {
    status: "claimed",
    trigger: "resume",
    recovery: updateRecovery(run.recovery, kind, { attempts: attempt }),
    exitCode: null,
    failureSummary: reason,
    finishedAt: null,
  });

  logger.info("self-heal: relaunching agent to repair delivery failure", {
    runId: run.id,
    issue: run.issueNumber,
    kind,
    attempt,
  });

  await github.addLabel(run.issueNumber, WORKING_LABEL);

  const terminal = await launchRun(reentered, { config, store, logger, notifier, now });
  await finalizeRun(deps, terminal);
}

/**
 * Run the one-shot frontier attempt after the assigned model's repair budget for one
 * phase is spent. Phase budgets are independent: using the CI escalation does not consume
 * the later merge or deploy escalation.
 *
 * Relaunches on the same branch/checkout (a resume, exactly like repairRun) but
 * overrides the run's agent/model/effort to `cliModel` — resolved via `modelByCliModel`
 * so the launched CLI and its model label stay consistent with the registry entry (an
 * escalation model is necessarily a `claude` model today, but this does not hard-code
 * that). Falls back to "claude" only if the configured model is somehow not in the
 * registry; `config.ts` already validates DISPATCHER_CI_ESCALATION_MODEL at startup, so
 * that fallback is a belt-and-suspenders default, not the expected path. Uses "effort:max"
 * or its per-agent equivalent — a last-resort attempt should not be effort-capped.
 * The relevant ledger entry is set before launching so autoship never grants a second
 * frontier attempt for the same failure kind.
 */
async function escalateRun(
  deps: DispatcherDeps,
  run: RunRecord,
  cliModel: string,
  kind: RecoveryKind,
  reason: string,
): Promise<void> {
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
    recovery: updateRecovery(run.recovery, kind, { escalated: true }),
    exitCode: null,
    failureSummary: reason,
    finishedAt: null,
  });

  logger.info(`self-heal: escalating ${kind} to a stronger model`, {
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
 * The sole human-handoff path. Reaching here proves the assigned-model repair budget
 * and the frontier attempt for this phase are both spent. The durable hold keeps the
 * claim, and the single high-priority notification contains the actual exhausted phase
 * and last observed failure.
 */
async function exhaustRun(
  deps: DispatcherDeps,
  run: RunRecord,
  kind: RecoveryKind,
  reason: string,
): Promise<void> {
  const finalRun = deps.store.updateRun(run.id, {
    status: "held",
    failureSummary: `${kind} recovery exhausted: ${reason}`,
    finishedAt: (deps.now ?? (() => Date.now()))(),
  });
  await deps.github.addLabel(run.issueNumber, AUTOSHIP_HELD_LABEL);
  await deps.github.removeLabel(run.issueNumber, WORKING_LABEL);
  await deps.github.comment(
    run.issueNumber,
    [
      `## Dispatcher exhausted — ${kind} still failing after frontier escalation`,
      "",
      reason,
      "",
      `The assigned model used ${deps.config.ciSelfHealMaxAttempts} repair attempt(s), then ` +
        `\`${deps.config.ciEscalationModel}\` made the final attempt. Automation is now exhausted.`,
      "",
      "This is the only state that requires operator involvement.",
    ].join("\n"),
  );
  deps.logger.error("dispatcher recovery exhausted", {
    runId: run.id,
    issue: run.issueNumber,
    kind,
    reason,
  });
  await deps.notifier
    .send(
      `Dispatcher EXHAUSTED #${run.issueNumber}`,
      finalRun.failureSummary ?? reason,
      NOTIFY_PRIORITY_HIGH,
    )
    .catch(() => undefined);
}

/**
 * Once-only GitHub bookkeeping after a run reaches a terminal state: release the working
 * label unless the run is still resumable/parked,
 * comment on the issue, hand off to `evaluateAutoship` to resolve the real outcome, and
 * send the run notification (except for token exhaustion, which already notified through
 * its own cooldown path, and except when evaluateAutoship just triggered a self-heal/
 * escalation relaunch, whose OWN recursive finalizeRun call will send the real one once
 * that settles).
 */
export async function finalizeRun(deps: DispatcherDeps, run: RunRecord): Promise<void> {
  const { store, github, logger } = deps;
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

  // A plain agent failure is not a human handoff. It gets the same bounded recovery
  // ladder as CI, merge, and deploy: assigned-model repairs, then one frontier attempt.
  // Intermediate failures stay internal—no high-priority push and no "go fix this"
  // issue comment while automation still owns the problem.
  if (run.status === "failed") {
    const decision = decideRecovery(run.recovery, "agent", deps.config.ciSelfHealMaxAttempts);
    if (decision.action === "retry") {
      await repairRun(
        deps,
        run,
        "agent",
        decision.attempt,
        run.failureSummary ?? `Agent exited ${run.exitCode ?? "without a result"}.`,
      );
      return;
    }
    if (decision.action === "escalate") {
      await escalateRun(
        deps,
        run,
        deps.config.ciEscalationModel,
        "agent",
        run.failureSummary ?? `Agent exited ${run.exitCode ?? "without a result"}.`,
      );
      return;
    }
    await exhaustRun(deps, run, "agent", run.failureSummary ?? `Agent exited ${run.exitCode ?? "without a result"}.`);
    return;
  }

  const resumable = !shouldReleaseClaim(run.status);
  if (!resumable) {
    await github.removeLabel(run.issueNumber, WORKING_LABEL);
  }

  await github.comment(run.issueNumber, buildIssueComment(run, resumable));

  logger.info("run finalized", { runId: run.id, issue: run.issueNumber, status: run.status });

  // evaluateAutoship is the sole authority on whether this run's PR actually ships,
  // stays parked, drives the self-heal ladder, or gets held -- see its own doc comment.
  const { relaunched } = await evaluateAutoship(deps, run);

  // A relaunch's own recursive finalizeRun call (via selfHealRun/escalateRun) sends the
  // real "run finished" notification once IT settles; sending one here too, for a status
  // (ci_failed) that is already stale by the time this line runs, would just be a
  // misleading extra push moments before the accurate one.
  if (relaunched) return;

  // No progress/failure push here. Autoship owns the one verified-success notification,
  // token exhaustion owns its cooldown notification, and exhaustRun owns the only
  // operator-action page. Everything else remains automation-internal.
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
    const decision = decideRecovery(run.recovery, "deploy", deps.config.ciSelfHealMaxAttempts);
    if (decision.action === "retry") {
      await repairRun(
        deps,
        run,
        "deploy",
        decision.attempt,
        "No autoship command is configured for this repository.",
      );
      return { relaunched: true };
    }
    if (decision.action === "escalate") {
      await escalateRun(
        deps,
        run,
        deps.config.ciEscalationModel,
        "deploy",
        "No autoship command is configured for this repository.",
      );
      return { relaunched: true };
    }
    await exhaustRun(deps, run, "deploy", "No autoship command is configured for this repository.");
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
      case "deploy_pending":
        // Self-deployment restarts this service from a detached systemd unit. Persist a
        // parked claim before that restart can kill us; the new process rechecks the
        // already-merged SHA and closes only after the detached verifier records health.
        store.updateRun(run.id, { status: "ci_pending" });
        return { relaunched: false };
      case "ci_not_green":
        if (outcome.state === "pending") {
          // Only touch the record on the TRANSITION into parked -- a recheck that finds
          // it still pending must stay silent and cheap, not re-write every ~15 minutes
          // while nothing has actually changed.
          if (run.status !== "ci_pending") store.updateRun(run.id, { status: "ci_pending" });
          return { relaunched: false };
        }
        // Defensive fallback: autoship normally maps red CI directly to a recovery
        // outcome. Never let a future caller turn a raw `fail` into a premature hold.
        {
          const decision = decideRecovery(
            run.recovery,
            "ci",
            deps.config.ciSelfHealMaxAttempts,
          );
          const reason = `PR #${run.prNumber ?? "?"} CI is failing.`;
          if (decision.action === "retry") {
            await repairRun(deps, run, "ci", decision.attempt, reason);
            return { relaunched: true };
          }
          if (decision.action === "escalate") {
            await escalateRun(
              deps,
              run,
              deps.config.ciEscalationModel,
              "ci",
              reason,
            );
            return { relaunched: true };
          }
          await exhaustRun(deps, run, "ci", reason);
          return { relaunched: false };
        }
      case "repair":
        store.updateRun(run.id, { status: "ci_failed" });
        await repairRun(deps, run, outcome.kind, outcome.attempt, outcome.reason);
        return { relaunched: true };
      case "escalate":
        store.updateRun(run.id, { status: "ci_failed" });
        await escalateRun(deps, run, outcome.model, outcome.kind, outcome.reason);
        return { relaunched: true };
      case "exhausted":
        await exhaustRun(deps, run, outcome.kind, outcome.reason);
        return { relaunched: false };
      case "skipped":
        return { relaunched: false };
    }
  } catch (err) {
    logger.error("autoship threw", {
      runId: run.id,
      error: err instanceof Error ? err.message : String(err),
    });
    const reason = `Autoship orchestration threw: ${err instanceof Error ? err.message : String(err)}`;
    const decision = decideRecovery(run.recovery, "merge", deps.config.ciSelfHealMaxAttempts);
    if (decision.action === "retry") {
      await repairRun(deps, run, "merge", decision.attempt, reason);
      return { relaunched: true };
    }
    if (decision.action === "escalate") {
      await escalateRun(deps, run, deps.config.ciEscalationModel, "merge", reason);
      return { relaunched: true };
    }
    await exhaustRun(deps, run, "merge", reason);
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
 * Rechecks a HELD run to see whether a human has approved it for shipping. A held run keeps
 * its issue claim (HELD_STATUSES ⊂ CLAIMING_STATUSES), so the issue is never re-dispatched
 * from scratch while it waits. The single signal that a human has approved is the removal of
 * the `autoship-held` label; while that label is still present this is a cheap no-op. A closed
 * issue retires the held run before any label or autoship work, because human closure is
 * terminal and must not produce repeated notifications. Once the label is gone on an OPEN
 * issue, this RESUMES autoship of the existing ready PR through the exact same
 * `evaluateAutoship` pipeline a fresh or parked run goes through — merge + deploy the PR that
 * is already there — rather than relaunching the agent to redo work that is already done
 * (issue #10). Like `recheckParkedRun`, it deliberately does NOT go through `finalizeRun`:
 * there is no new agent run to record telemetry for, and `evaluateAutoship` owns its own
 * comment/notify for every outcome. Returns whether it actually resumed, so the scan loop
 * knows whether this counts as the scan's action.
 */
export async function recheckHeldRun(deps: DispatcherDeps, run: RunRecord): Promise<{ rechecked: boolean }> {
  // A human closing the issue is a terminal resolution. Retire the historical hold so
  // it releases its claim, becomes prunable, and cannot emit the same "already merged"
  // alert on every poll. UNKNOWN also fails closed: a transient GitHub read failure is
  // not evidence that a human approved shipping.
  const issueState = await deps.github.issueState(run.issueNumber);
  if (issueState === "CLOSED") {
    deps.store.updateRun(run.id, { status: "abandoned" });
    deps.logger.info("closed issue — retiring held run", {
      runId: run.id,
      issue: run.issueNumber,
      pr: run.prNumber ?? undefined,
    });
    return { rechecked: false };
  }
  if (issueState !== "OPEN") {
    return { rechecked: false };
  }

  const labels = await deps.github.issueLabels(run.issueNumber);
  if (labels.includes(AUTOSHIP_HELD_LABEL)) {
    // Still held by a human — leave it exactly as it is.
    return { rechecked: false };
  }
  deps.logger.info("held PR un-held — resuming autoship without relaunching the agent", {
    runId: run.id,
    issue: run.issueNumber,
    pr: run.prNumber ?? undefined,
  });
  await evaluateAutoship(deps, run);
  return { rechecked: true };
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
 * yet." autoship's own follow-up action determines the real outcome moments later.
 */
export function buildIssueComment(
  run: RunRecord,
  resumable: boolean,
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
  lines.push("");
  if (run.status === "ci_pending") {
    lines.push(
      "CI had not finished when the run ended. The dispatcher will check back once CI resolves — " +
        "it will NOT relaunch the agent while waiting.",
    );
  } else if (run.status === "ci_failed") {
    lines.push(
      "CI is red. The dispatcher is relaunching the agent to diagnose and fix it (self-heal), " +
        "then escalating to one frontier-model attempt if the assigned model cannot resolve it.",
    );
  } else if (resumable) {
    lines.push(
      "The branch and checkout are preserved. The dispatcher will resume this run on its next " +
        "scan, continuing from the first milestone without a `[DONE]` marker — completed work is not redone.",
    );
  } else if (run.status === "failed") {
    lines.push(
      "The dispatcher is relaunching the agent on the same branch to diagnose and repair the failure, " +
        "then will make one frontier-model attempt if the assigned model cannot resolve it.",
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
    // Never prune a run that still holds its issue claim — that would drop a live claim
    // out from under the issue. This is every CLAIMING status: active, resumable, parked,
    // mid-ladder, AND held (a held run keeps its claim so it is not re-dispatched, #10).
    if ((CLAIMING_STATUSES as readonly string[]).includes(run.status)) {
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
