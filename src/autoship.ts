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
 *   1. Only a SUCCEEDED run that opened a PR is a candidate. Nothing else ships.
 *   2. Re-confirm CI is green NOW, from `gh pr checks` exit status — never a verdict
 *      observed earlier, never the agent's self-report.
 *   3. Data-loss gate: read the PR diff and hold anything irreversible for a human.
 *      If the diff cannot be read, HOLD — fail safe, never ship blind.
 *   4. Only then invoke the ship command. Its exit code is authoritative: 0 = shipped
 *      and verified (the command owns deploy + health-check + rollback); non-zero = it
 *      failed and rolled back, and we escalate.
 *
 * The ship command is trusted to be honest about success because it, not this module,
 * can see production health. This module's job is to make sure it is only ever called on
 * a green, non-destructive PR.
 */

import { assessDataLossRisk, parseUnifiedDiff } from "./autoship-gate.ts";
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
  generatedConflictAllowlist: readonly string[];
  generatedConflictRegenCmd: string | null;
  generatedConflictMaxAttempts: number;
  generatedConflictCiWaitSeconds: number;
  repairGeneratedConflicts?: (
    request: GeneratedConflictRepairRequest,
  ) => Promise<GeneratedConflictRepairResult>;
}

export type AutoshipOutcome =
  | { action: "skipped"; reason: string }
  | { action: "ci_not_green"; state: "pending" | "fail" }
  | { action: "held"; reasons: string[] }
  | { action: "merge_blocked"; reason: string }
  | { action: "conflict_recovery_failed"; reason: string; conflictPaths: string[] }
  | { action: "shipped" }
  | { action: "ship_failed"; code: number | null; detail: string };

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
  if (run.status !== "succeeded" || run.prNumber === null) {
    return { action: "skipped", reason: "run is not a PR-producing success" };
  }
  const pr = run.prNumber;

  // 2. Re-confirm CI now. A verdict from when the run ended is not trusted.
  const ci = await github.prChecksState(pr);
  if (ci !== "pass") {
    logger.info("autoship: CI not green, not shipping", { issue: run.issueNumber, pr, ci });
    if (ci === "fail") {
      // CI has definitively failed. Hold the issue so the dispatcher does not re-run the
      // agent in an infinite poll loop — without a hold, the issue stays eligible because
      // selection only looks at labels, not prior succeeded runs, so it picks this up every
      // 15 minutes forever. A human must clear the failing checks and remove autoship-held.
      await github.addLabel(run.issueNumber, AUTOSHIP_HELD_LABEL).catch(() => false);
      await github
        .comment(
          run.issueNumber,
          [
            "## Autoship held — CI is failing",
            "",
            `CI checks on PR #\${pr} are failing. The dispatcher will not re-run until the \`autoship-held\` label is removed.`,
            "",
            "Fix the failing checks, then remove the \`autoship-held\` label to re-enable dispatch.",
          ].join("\n"),
        )
        .catch(() => false);
      await notifier
        .send(
          `Autoship HELD #\${run.issueNumber}`,
          `PR #\${pr} CI is failing — held for human review.`,
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
  logger.info("autoship: shipping", { issue: run.issueNumber, pr });
  const result = await deps.ship(deps.autoshipCmd, {
    AUTOSHIP_PR_NUMBER: String(pr),
    AUTOSHIP_ISSUE_NUMBER: String(run.issueNumber),
    AUTOSHIP_BRANCH: run.branch,
    AUTOSHIP_REPO: deps.repoSlug,
  });

  if (result.code !== 0) {
    const detail = (result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`).slice(-500);
    logger.error("autoship: ship command failed", { issue: run.issueNumber, pr, code: result.code });
    await notifier
      .send(
        `Autoship FAILED for #${run.issueNumber}`,
        `PR #${pr} passed CI but the ship command exited ${result.code}. It should have rolled back — verify production. Detail: ${detail}`,
        NOTIFY_PRIORITY_HIGH,
      )
      .catch(() => undefined);
    return { action: "ship_failed", code: result.code, detail };
  }

  logger.info("autoship: shipped", { issue: run.issueNumber, pr });
  await notifier
    .send(`Autoship: shipped #${run.issueNumber}`, `PR #${pr} merged and deployed.`, NOTIFY_PRIORITY_DEFAULT)
    .catch(() => undefined);
  return { action: "shipped" };
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

async function mergeBlocked(
  deps: AutoshipDeps,
  run: RunRecord,
  pr: number,
  reason: string,
): Promise<AutoshipOutcome> {
  const { logger, notifier, github } = deps;
  logger.warn("autoship: PR is not mergeable", { issue: run.issueNumber, pr, reason });
  await github
    .comment(
      run.issueNumber,
      [
        "## Autoship held — PR is not mergeable",
        "",
        reason,
        "",
        "The dispatcher did not attempt generated-file conflict recovery.",
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

  await github.addLabel(run.issueNumber, AUTOSHIP_HELD_LABEL).catch(() => false);
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
