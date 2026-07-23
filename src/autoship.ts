/**
 * Autoship — merge and deploy a green PR without a human, with rails.
 *
 * This is the orchestration layer. It decides WHETHER to ship and enforces the two
 * repo-agnostic rails; the repo-specific act of merging and deploying is delegated to a
 * per-instance shell command (`DISPATCHER_AUTOSHIP_CMD`), because "how do I ship" differs
 * per target (internal-tools runs deploy.sh; the dispatcher restarts its own unit).
 *
 * The order of checks is the whole point, and every one of them was paid for in the
 * internal-tools incident that took production down for 40 hours:
 *
 *   1. Only a clean agent exit (exitCode 0) that opened a PR is a candidate --
 *      regardless of which of shipped/ci_pending/ci_failed status it currently wears,
 *      since this function is the sole authority that decides among those. Nothing
 *      else (an agent that gave up or crashed) ships.
 *   2. Re-confirm CI is green NOW, from `gh pr checks` exit status — never a verdict
 *      observed earlier, never the agent's self-report.
 *   3. Data-loss gate: read the PR diff and hold anything irreversible for a human.
 *      If the diff cannot be read, HOLD — fail safe, never ship blind.
 *   4. Only then invoke the ship command. Its exit code is authoritative: 0 = shipped
 *      and verified (the command owns deploy + health-check + rollback); non-zero = it
 *      failed and rolled back, and we escalate.
 *
 * Self-healing: a red CI verdict at step 2 does not immediately page a human. Up to
 * `ciSelfHealMaxAttempts` times, this module instead hands control back to the caller
 * (`{ action: "ci_self_heal" }`), which relaunches the agent on the same branch to
 * diagnose and fix the failure — a resume, so dispatch-agent.sh feeds it the actual
 * failing checks rather than making it guess. Only once that budget is exhausted does a
 * red PR get the `autoship-held` label and a human notification. This mirrors the
 * generated-conflict repair above it: automation gets first crack at a known-recoverable
 * problem, and a human is paged only once automation has genuinely given up.
 *
 * The ship command is trusted to be honest about success because it, not this module,
 * can see production health. This module's job is to make sure it is only ever called on
 * a green, non-destructive PR.
 */

import { assessDataLossRisk, parseUnifiedDiff } from "./autoship-gate.ts";
import { classifyShipResult, type AutoshipShipState } from "./autoship-deployment.ts";
import {
  repairGeneratedFileConflicts,
  type GeneratedConflictRepairRequest,
  type GeneratedConflictRepairResult,
} from "./generated-conflict-repair.ts";
import type { RunRecord } from "./state.ts";
import type { ExecResult } from "./exec.ts";
import { NOTIFY_PRIORITY_DEFAULT, NOTIFY_PRIORITY_HIGH, type Notifier } from "./notify.ts";
import type { Logger } from "./logger.ts";
import type { GithubPrMergeInfo } from "./github.ts";

/** Label left on a PR that autoship refused to ship, so it is easy to find and requeue. */
export const AUTOSHIP_HELD_LABEL = "autoship-held";

/** The GitHub surface autoship needs. A subset of GithubClient, so tests inject a fake. */
export interface AutoshipGithub {
  prChecksState(pr: number): Promise<"pass" | "pending" | "fail">;
  waitForPrChecks(pr: number, timeoutSeconds: number): Promise<"pass" | "pending" | "fail">;
  prMergeInfo(pr: number): Promise<GithubPrMergeInfo | null>;
  prDiff(pr: number): Promise<string | null>;
  comment(issue: number, body: string): Promise<boolean>;
  addLabel(issue: number, label: string): Promise<boolean>;
}

/** Runs the repo-specific ship command with autoship context in the environment. */
export type ShipRunner = (
  command: string,
  env: Record<string, string>,
  options?: { cwd?: string },
) => Promise<ExecResult>;

export interface AutoshipDeps {
  github: AutoshipGithub;
  ship: ShipRunner;
  notifier: Notifier;
  logger: Logger;
  /** The configured DISPATCHER_AUTOSHIP_CMD, or null when autoship is disabled. */
  autoshipCmd: string | null;
  /** owner/repository, forwarded to the ship command. */
  repoSlug: string;
  /** Dedicated checkout/worktree used only by autoship deployment and rollback. */
  autoshipDeploymentCheckout: string;
  generatedConflictAllowlist: readonly string[];
  generatedConflictRegenCmd: string | null;
  generatedConflictMaxAttempts: number;
  generatedConflictCiWaitSeconds: number;
  /** Cap on self-heal relaunches for a red-CI PR before autoship-held is stamped. */
  ciSelfHealMaxAttempts: number;
  /**
   * CLI model for the ONE escalation attempt after ciSelfHealMaxAttempts is exhausted and
   * CI is still red — a last, stronger-model try before giving up on human review.
   */
  ciEscalationModel: string;
  repairGeneratedConflicts?: (
    request: GeneratedConflictRepairRequest,
  ) => Promise<GeneratedConflictRepairResult>;
}

export type AutoshipOutcome =
  | { action: "skipped"; reason: string }
  | { action: "ci_not_green"; state: "pending" | "fail" }
  | { action: "ci_self_heal"; attempt: number; maxAttempts: number }
  | { action: "ci_escalate"; model: string }
  | { action: "held"; reasons: string[] }
  | { action: "merge_blocked"; reason: string }
  | { action: "conflict_recovery_failed"; reason: string; conflictPaths: string[] }
  | { action: "shipped" }
  | { action: "ship_failed"; code: number | null; detail: string; state: AutoshipShipState };

/**
 * Decide and, if warranted, ship one finalized run. Safe to call for every run — it
 * self-guards and returns `skipped` for anything that is not a green-CI PR success.
 * Never throws: an autoship failure must not break the dispatch loop.
 */
export async function autoshipRun(deps: AutoshipDeps, run: RunRecord): Promise<AutoshipOutcome> {
  const { github, notifier, logger } = deps;

  if (!deps.autoshipCmd) {
    return { action: "skipped", reason: "autoship not configured" };
  }
  // Candidacy is about what the run PRODUCED, not which of shipped/ci_pending/ci_failed
  // status label it currently wears -- this function is the SOLE authority that decides
  // among those, called both right after a fresh run and again on every parked recheck
  // (dispatcher.ts's evaluateAutoship), so it must not gate on a status it might itself
  // be about to overwrite. A clean agent exit (0) with a PR is always worth evaluating;
  // a non-zero exit or zero commits (both land as `run.status === "failed"`) never is --
  // there is nothing to ship or fix.
  if (run.exitCode !== 0 || run.prNumber === null) {
    return { action: "skipped", reason: "run is not a PR-producing clean exit" };
  }
  const pr = run.prNumber;

  // 2. Re-confirm CI now. A verdict from when the run ended is not trusted.
  const ci = await github.prChecksState(pr);
  if (ci !== "pass") {
    logger.info("autoship: CI not green, not shipping", { issue: run.issueNumber, pr, ci });
    if (ci === "fail") {
      const attemptsSoFar = run.ciSelfHealAttempts ?? 0;
      if (attemptsSoFar < deps.ciSelfHealMaxAttempts) {
        // CI failed, but we have not exhausted the self-heal budget yet. Hand this back
        // to the caller to relaunch the agent on the same branch (a resume, so
        // dispatch-agent.sh feeds it the actual failing checks) rather than paging a
        // human immediately — humans should only see autoship-held once automation has
        // genuinely given up.
        const attempt = attemptsSoFar + 1;
        logger.info("autoship: CI failed, attempting self-heal", {
          issue: run.issueNumber,
          pr,
          attempt,
          maxAttempts: deps.ciSelfHealMaxAttempts,
        });
        await notifier
          .send(
            `Autoship: self-heal ${attempt}/${deps.ciSelfHealMaxAttempts} for #${run.issueNumber}`,
            `PR #${pr} CI failed — relaunching the agent to diagnose and fix before holding for a human.`,
            NOTIFY_PRIORITY_DEFAULT,
          )
          .catch(() => undefined);
        return { action: "ci_self_heal", attempt, maxAttempts: deps.ciSelfHealMaxAttempts };
      }

      const alreadyEscalated = run.ciEscalated ?? false;
      if (!alreadyEscalated) {
        // The default-model self-heal budget is exhausted and CI is still red. Before
        // paging a human, spend exactly one attempt with a stronger model
        // (ciEscalationModel, e.g. claude-opus-4-8) — some failures a fast/general model
        // gets stuck on are within a frontier model's reach. This is a separate,
        // one-shot budget from ciSelfHealMaxAttempts, tracked by run.ciEscalated.
        logger.info("autoship: self-heal exhausted, escalating model", {
          issue: run.issueNumber,
          pr,
          attemptsSoFar,
          escalationModel: deps.ciEscalationModel,
        });
        await github
          .comment(
            run.issueNumber,
            [
              "## Autoship: self-heal failed, escalating",
              "",
              `Self-heal failed after ${attemptsSoFar} attempt(s). Escalating to ` +
                `\`${deps.ciEscalationModel}\` for one last automated fix attempt before ` +
                "holding for human review.",
            ].join("\n"),
          )
          .catch(() => false);
        await notifier
          .send(
            `Autoship: escalating #${run.issueNumber} to ${deps.ciEscalationModel}`,
            `PR #${pr} CI still failing after ${attemptsSoFar} self-heal attempt(s) — escalating to ${deps.ciEscalationModel} for one last attempt.`,
            NOTIFY_PRIORITY_DEFAULT,
          )
          .catch(() => undefined);
        return { action: "ci_escalate", model: deps.ciEscalationModel };
      }

      // Self-heal AND the escalation attempt are both exhausted. Hold the issue so the
      // dispatcher does not re-run the agent in an infinite poll loop — without a hold,
      // the issue stays eligible because selection only looks at labels, not prior
      // prior resolved runs, so it picks this up every 15 minutes forever. A human must
      // clear the failing checks and remove autoship-held.
      await stampHold(deps, run, "ci-exhausted");
      await github
        .comment(
          run.issueNumber,
          [
            "## Autoship held — CI is still failing after self-heal and escalation",
            "",
            `CI checks on PR #${pr} are failing after ${attemptsSoFar} automatic fix attempt(s) ` +
              `and an escalation attempt with \`${deps.ciEscalationModel}\`. ` +
              "The dispatcher will not re-run until the `autoship-held` label is removed.",
            "",
            "Fix the failing checks, then remove the `autoship-held` label to re-enable dispatch.",
          ].join("\n"),
        )
        .catch(() => false);
      await notifier
        .send(
          `Autoship HELD #${run.issueNumber}`,
          `PR #${pr} CI is still failing after ${attemptsSoFar} self-heal attempt(s) and escalation to ${deps.ciEscalationModel} — held for human review.`,
          NOTIFY_PRIORITY_HIGH,
        )
        .catch(() => undefined);
    }
    return { action: "ci_not_green", state: ci };
  }

  const mergeInfo = await github.prMergeInfo(pr);
  if (!mergeInfo) {
    return await mergeBlocked(deps, run, pr, "PR mergeability could not be read");
  }
  if (mergeInfo.isDraft) {
    return await mergeBlocked(deps, run, pr, "PR is still a draft");
  }
  if (mergeInfo.reviewDecision === "REVIEW_REQUIRED") {
    return await mergeBlocked(deps, run, pr, "PR requires review approval");
  }
  if (!mergeInfo.headRefOid || !mergeInfo.baseRefOid) {
    return await mergeBlocked(deps, run, pr, "PR head/base SHA could not be read");
  }
  if (mergeInfo.mergeStateStatus === "DIRTY") {
    const recovered = await recoverGeneratedConflicts(deps, run, pr, mergeInfo);
    if (recovered.action !== "recovered") return recovered.outcome;
  }

  // 3. Data-loss gate. Unreadable diff → hold (fail safe).
  const diff = await github.prDiff(pr);
  if (diff === null) {
    return await hold(deps, run, pr, [
      "the PR diff could not be read, so the data-loss gate could not be evaluated",
    ]);
  }
  const assessment = assessDataLossRisk(parseUnifiedDiff(diff));
  if (assessment.held) {
    return await hold(deps, run, pr, assessment.reasons);
  }

  // 4. Ship. The command owns merge + deploy + health-check + rollback.
  logger.info("autoship: shipping", {
    issue: run.issueNumber,
    pr,
    prHeadSha: mergeInfo.headRefOid,
    baseSha: mergeInfo.baseRefOid,
    deploymentCheckout: deps.autoshipDeploymentCheckout,
  });
  const result = await deps.ship(deps.autoshipCmd, {
    AUTOSHIP_PR_NUMBER: String(pr),
    AUTOSHIP_ISSUE_NUMBER: String(run.issueNumber),
    AUTOSHIP_BRANCH: run.branch,
    AUTOSHIP_REPO: deps.repoSlug,
    AUTOSHIP_PR_HEAD_SHA: mergeInfo.headRefOid,
    AUTOSHIP_BASE_SHA: mergeInfo.baseRefOid,
    AUTOSHIP_DEPLOYMENT_CHECKOUT: deps.autoshipDeploymentCheckout,
  }, { cwd: deps.autoshipDeploymentCheckout });
  const classified = classifyShipResult(result);

  if (result.code !== 0) {
    logger.error("autoship: ship command failed", {
      issue: run.issueNumber,
      pr,
      code: result.code,
      state: classified.state,
      health: classified.health,
      report: classified.report,
    });
    // A failed (and, per the ship command's own contract, rolled-back) deploy is not
    // something a retry on the next scan fixes by itself -- without a hold this would
    // hammer the same ship command again every ~15 minutes on an unresolved deploy
    // problem, the same silent-loop class of bug as the other hold paths (#366).
    await stampHold(deps, run, "ship-failed");
    await notifier
      .send(
        autoshipFailureTitle(run.issueNumber, classified.state),
        autoshipFailureBody(pr, result.code, classified),
        NOTIFY_PRIORITY_HIGH,
      )
      .catch(() => undefined);
    return { action: "ship_failed", code: result.code, detail: classified.detail, state: classified.state };
  }

  logger.info("autoship: shipped", {
    issue: run.issueNumber,
    pr,
    state: classified.state,
    health: classified.health,
    report: classified.report,
  });
  await notifier
    .send(`Autoship: shipped #${run.issueNumber}`, `PR #${pr} merged and deployed.`, NOTIFY_PRIORITY_DEFAULT)
    .catch(() => undefined);
  return { action: "shipped" };
}

function autoshipFailureTitle(issue: number, state: AutoshipShipState): string {
  switch (state) {
    case "merge_succeeded_deployment_not_attempted":
      return `Autoship MERGED but did not deploy #${issue}`;
    case "deployment_failed_rollback_succeeded":
      return `Autoship rolled back #${issue}`;
    case "deployment_failed_rollback_failed":
      return `Autoship rollback FAILED #${issue}`;
    case "deployment_state_unknown":
      return `Autoship state UNKNOWN #${issue}`;
    case "shipped":
      return `Autoship FAILED for #${issue}`;
  }
}

function autoshipFailureBody(
  pr: number,
  code: number | null,
  classified: ReturnType<typeof classifyShipResult>,
): string {
  const report = classified.report;
  const facts = [
    `PR #${pr} passed CI but the ship command exited ${code}.`,
    `State: ${classified.state}.`,
    `Health: ${classified.health}.`,
    report?.mergedSha ? `Merged SHA: ${report.mergedSha}.` : null,
    report?.deployedSha ? `Deployed SHA: ${report.deployedSha}.` : null,
    report?.rollbackSha ? `Rollback SHA: ${report.rollbackSha}.` : null,
    report?.lastKnownGoodSha ? `Last-known-good SHA: ${report.lastKnownGoodSha}.` : null,
    report?.deploymentCheckoutPath ? `Deployment checkout: ${report.deploymentCheckoutPath}.` : null,
    classified.detail ? `Detail: ${classified.detail}` : null,
  ].filter((line): line is string => line !== null);

  if (classified.state === "deployment_state_unknown") {
    facts.push("Human production verification is required.");
  }

  return facts.join(" ");
}

async function recoverGeneratedConflicts(
  deps: AutoshipDeps,
  run: RunRecord,
  pr: number,
  mergeInfo: GithubPrMergeInfo,
): Promise<
  | { action: "recovered" }
  | { action: "failed"; outcome: Extract<AutoshipOutcome, { action: "conflict_recovery_failed" | "ci_not_green" }> }
> {
  const { github, logger, notifier } = deps;
  const repair = deps.repairGeneratedConflicts ?? ((request) => repairGeneratedFileConflicts(request));
  logger.warn("autoship: PR has merge conflicts; evaluating generated-file recovery", {
    issue: run.issueNumber,
    pr,
  });

  const result = await repair({
    repoSlug: deps.repoSlug,
    pr,
    baseRefName: mergeInfo.baseRefName,
    headRefName: mergeInfo.headRefName,
    allowlistedPaths: deps.generatedConflictAllowlist,
    regenerationCommand: deps.generatedConflictRegenCmd,
    maxAttempts: deps.generatedConflictMaxAttempts,
  });

  if (!result.ok) {
    logger.warn("autoship: generated-file conflict recovery refused or failed", {
      issue: run.issueNumber,
      pr,
      conflicts: result.conflictPaths,
      reason: result.reason,
    });
    // Same gap as the CI-exhaustion and merge_blocked holds (#366): a comment that says
    // "held" without ever stamping the label leaves the issue fully eligible, so it gets
    // re-claimed and re-run on every subsequent scan despite the conflict never resolving
    // itself.
    await stampHold(deps, run, "conflict-recovery-failed");
    await github
      .comment(
        run.issueNumber,
        [
          "## Autoship held — merge conflicts need review",
          "",
          "CI is green, but the PR is not mergeable. Automatic generated-file conflict",
          "recovery did not run to completion.",
          "",
          `Reason: ${result.reason}`,
          "",
          ...result.conflictPaths.map((path) => `- ${path}`),
        ].join("\n"),
      )
      .catch(() => false);
    await notifier
      .send(
        `Autoship HELD #${run.issueNumber}`,
        `PR #${pr} has merge conflicts that were not auto-recovered: ${result.reason}`,
        NOTIFY_PRIORITY_HIGH,
      )
      .catch(() => undefined);
    return {
      action: "failed",
      outcome: {
        action: "conflict_recovery_failed",
        reason: result.reason,
        conflictPaths: result.conflictPaths,
      },
    };
  }

  logger.info("autoship: recovered generated-file conflicts", {
    issue: run.issueNumber,
    pr,
    discardedPaths: result.discardedPaths,
    commit: result.commit,
  });
  await github
    .comment(
      run.issueNumber,
      [
        "## Autoship recovered generated-file conflicts",
        "",
        "The PR was rebuilt from the current base branch. Stale generated files were",
        "discarded and regenerated before CI was rerun.",
        "",
        `Repair commit: \`${result.commit}\``,
        "",
        ...result.discardedPaths.map((path) => `- ${path}`),
      ].join("\n"),
    )
    .catch(() => false);
  await notifier
    .send(
      `Autoship: recovered #${run.issueNumber}`,
      `PR #${pr} generated-file conflicts repaired; waiting for CI before merge.`,
      NOTIFY_PRIORITY_DEFAULT,
    )
    .catch(() => undefined);

  const ci = await github.waitForPrChecks(pr, deps.generatedConflictCiWaitSeconds);
  if (ci !== "pass") {
    logger.info("autoship: repaired PR CI not green, not shipping", { issue: run.issueNumber, pr, ci });
    return { action: "failed", outcome: { action: "ci_not_green", state: ci } };
  }

  return { action: "recovered" };
}

/**
 * Best-effort label stamp for a hold outcome. `addLabel` returns false (never throws) on
 * a failed gh invocation, and every caller here used to discard that boolean — so when
 * AUTOSHIP_HELD_LABEL did not yet exist as a repo label, every stamp attempt silently
 * no-op'd and the issue stayed fully eligible, indistinguishable from a healthy hold.
 * That gap is exactly what let #366 loop for 7+ hours after the CI-exhaustion hold (and
 * later mergeBlocked) were "fixed" in code: the label existing in GitHub was never
 * verified. This does not retry — a missing label is a one-time repo setup problem, not
 * a transient one — but it makes the failure loud instead of invisible.
 */
async function stampHold(deps: AutoshipDeps, run: RunRecord, context: string): Promise<void> {
  const { github, logger } = deps;
  const ok = await github.addLabel(run.issueNumber, AUTOSHIP_HELD_LABEL).catch(() => false);
  if (!ok) {
    logger.error(
      "autoship: failed to stamp autoship-held — the issue remains eligible and may be " +
        "re-dispatched again despite this hold (check that the label exists in the repo)",
      { issue: run.issueNumber, context },
    );
  }
}

async function mergeBlocked(
  deps: AutoshipDeps,
  run: RunRecord,
  pr: number,
  reason: string,
): Promise<AutoshipOutcome> {
  const { logger, notifier, github } = deps;
  logger.warn("autoship: PR is not mergeable", { issue: run.issueNumber, pr, reason });
  // This used to say "Autoship HELD" in the comment/notification title without ever
  // stamping autoship-held, so the issue stayed fully eligible and got re-claimed and
  // re-dispatched on every single poll — a busy-loop that looked identical to the
  // CI-red infinite-loop bug (#366) but was actually "no human has converted the PR out
  // of draft (or approved it) yet," repeating every ~15 minutes for hours. A human
  // action (mark ready for review / approve / investigate an unreadable PR) is required
  // in all three mergeBlocked cases, and none of them resolve themselves on a retry, so
  // this now holds exactly like the CI-exhausted and data-loss-gate paths do.
  await stampHold(deps, run, "merge-blocked");
  await github
    .comment(
      run.issueNumber,
      [
        "## Autoship held — PR is not mergeable",
        "",
        reason,
        "",
        "The dispatcher did not attempt generated-file conflict recovery.",
        "",
        "The dispatcher will not re-run until the `autoship-held` label is removed. If this " +
          "is a draft PR waiting on review, mark it ready for review (and merge, or clear " +
          "the label to let autoship re-check) once it should proceed.",
      ].join("\n"),
    )
    .catch(() => false);
  await notifier
    .send(`Autoship HELD #${run.issueNumber}`, `PR #${pr} is not mergeable: ${reason}`, NOTIFY_PRIORITY_HIGH)
    .catch(() => undefined);
  return { action: "merge_blocked", reason };
}

/** Record a hold: label the PR, comment why, ntfy, and leave it open for a human. */
async function hold(
  deps: AutoshipDeps,
  run: RunRecord,
  pr: number,
  reasons: string[],
): Promise<AutoshipOutcome> {
  const { github, notifier, logger } = deps;
  logger.warn("autoship: held for data-loss risk", { issue: run.issueNumber, pr, reasons });

  await stampHold(deps, run, "data-loss-gate");
  const body = [
    "## Autoship held — data-loss risk",
    "",
    "CI is green, but this PR contains changes that look irreversible, so it was **not**",
    "shipped automatically. A human must review and merge it.",
    "",
    ...reasons.map((r) => `- ${r}`),
    "",
    "Destructive migrations, bulk deletes, and irreversible transforms never ship unattended.",
  ].join("\n");
  await github.comment(run.issueNumber, body).catch(() => false);
  await notifier
    .send(
      `Autoship HELD #${run.issueNumber}`,
      `PR #${pr} is green but looks destructive; held for review. ${reasons[0] ?? ""}`,
      NOTIFY_PRIORITY_HIGH,
    )
    .catch(() => undefined);

  return { action: "held", reasons };
}
