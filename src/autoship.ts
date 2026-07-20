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
import type { RunRecord } from "./state.ts";
import type { ExecResult } from "./exec.ts";
import { NOTIFY_PRIORITY_DEFAULT, NOTIFY_PRIORITY_HIGH, type Notifier } from "./notify.ts";
import type { Logger } from "./logger.ts";

/** Label left on a PR that autoship refused to ship, so it is easy to find and requeue. */
export const AUTOSHIP_HELD_LABEL = "autoship-held";

/** The GitHub surface autoship needs. A subset of GithubClient, so tests inject a fake. */
export interface AutoshipGithub {
  prChecksState(pr: number): Promise<"pass" | "pending" | "fail">;
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
}

export type AutoshipOutcome =
  | { action: "skipped"; reason: string }
  | { action: "ci_not_green"; state: "pending" | "fail" }
  | { action: "held"; reasons: string[] }
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
    return { action: "ci_not_green", state: ci };
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
