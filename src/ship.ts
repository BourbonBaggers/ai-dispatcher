/**
 * `ai-dispatcher ship` — a one-shot merge/deploy/verify for a single, already-open pull
 * request created outside the dispatcher (issue #27).
 *
 * This is deliberately NOT `autoship.ts` with the dispatcher plumbing stripped out: it
 * shares the ship command, its classification, and its "exit zero is not proof of
 * delivery" rules, but it makes exactly one pass and never retries, repairs, or
 * escalates. If CI is red, the PR is conflicted, or state cannot be read, it reports what
 * to fix and returns — the operator (or a future invocation) decides what happens next.
 * There is no repair ladder, no frontier escalation, and no `autoship-held` label,
 * because there is no dispatcher-owned run for either of those to attach to.
 */

import { classifyShipResult } from "./autoship-deployment.ts";
import type { ExecResult } from "./exec.ts";
import type { GithubPrMergeInfo } from "./github.ts";
import type { Logger } from "./logger.ts";

/** Runs the repo-specific ship command with autoship context in the environment. */
export type ShipRunner = (
  command: string,
  env: Record<string, string>,
  options?: { cwd?: string },
) => Promise<ExecResult>;

/** The GitHub surface `shipRun` needs. A subset of GithubClient, so tests inject a fake. */
export interface ShipGithub {
  prState(pr: number): Promise<"open" | "merged" | "closed" | "unknown">;
  prChecksState(pr: number): Promise<"pass" | "pending" | "fail" | "unknown">;
  prMergeInfo(pr: number): Promise<GithubPrMergeInfo | null>;
  prTitleAndBody(pr: number): Promise<{ title: string; body: string } | null>;
  closeIssue(issue: number): Promise<boolean>;
}

export interface ShipDeps {
  github: ShipGithub;
  ship: ShipRunner;
  logger: Logger;
  autoshipCmd: string;
  repoSlug: string;
  autoshipDeploymentCheckout: string;
}

export interface ShipRequest {
  pr: number;
  /** Optional issue to close after verified delivery; null means no issue operation. */
  issueNumber: number | null;
}

export type ShipOutcome =
  | { action: "blocked"; reason: string }
  | { action: "ci_not_green"; state: "pending" | "fail" | "unknown" }
  | { action: "deploy_pending"; mergedSha: string | null }
  | { action: "deploy_failed"; detail: string }
  | { action: "shipped"; mergedSha: string; deployedSha: string; issueClosed: boolean | null };

/**
 * GitHub's documented auto-close keywords (close/fix/resolve, with -s/-d forms) followed
 * by `#123`, `GH-123`, or a full issue URL. Any match is disqualifying regardless of which
 * issue number it names: merging a PR that carries one lets GitHub close that issue the
 * instant the merge lands, before this command's deploy/health verification ever runs.
 */
const AUTO_CLOSE_KEYWORD_RE =
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s*(?:#\d+|GH-\d+|https?:\/\/github\.com\/[^/\s]+\/[^/\s]+\/issues\/\d+)/i;

/** Returns the matched text, or null if `text` carries no GitHub auto-close keyword. */
export function findAutoCloseKeyword(text: string): string | null {
  return AUTO_CLOSE_KEYWORD_RE.exec(text)?.[0] ?? null;
}

/**
 * Runs one merge/deploy/verify pass for an ad hoc PR. Never throws: every failure mode is
 * reported as a typed outcome so the CLI can print it and exit non-zero.
 */
export async function shipRun(deps: ShipDeps, request: ShipRequest): Promise<ShipOutcome> {
  const { github, logger } = deps;
  const { pr, issueNumber } = request;

  const prState = await github.prState(pr);
  if (prState === "unknown") {
    return { action: "blocked", reason: `PR #${pr} state could not be read from GitHub.` };
  }
  if (prState === "closed") {
    return { action: "blocked", reason: `PR #${pr} is closed without merging.` };
  }
  if (prState === "merged") {
    return await shipAlreadyMerged(deps, request);
  }

  const titleBody = await github.prTitleAndBody(pr);
  if (!titleBody) {
    return { action: "blocked", reason: `PR #${pr} title/body could not be read from GitHub.` };
  }
  const keyword = findAutoCloseKeyword(`${titleBody.title}\n${titleBody.body}`);
  if (keyword) {
    return {
      action: "blocked",
      reason:
        `PR #${pr} title/body contains a GitHub auto-close keyword ("${keyword}"). ` +
        "Remove it so merging cannot close an issue before deployment is verified.",
    };
  }

  const mergeInfo = await github.prMergeInfo(pr);
  if (!mergeInfo) {
    return { action: "blocked", reason: `PR #${pr} mergeability could not be read from GitHub.` };
  }
  if (mergeInfo.isDraft) {
    return { action: "blocked", reason: `PR #${pr} is a draft; ship requires a non-draft PR.` };
  }
  if (!mergeInfo.headRefOid || !mergeInfo.baseRefOid) {
    return { action: "blocked", reason: `PR #${pr} head/base SHA could not be read.` };
  }
  if (mergeInfo.mergeStateStatus === "DIRTY") {
    return {
      action: "blocked",
      reason: `PR #${pr} has merge conflicts with its base branch; resolve them and rerun.`,
    };
  }

  const ci = await github.prChecksState(pr);
  if (ci !== "pass") {
    logger.info("ship: CI not green, not shipping", { pr, ci });
    return { action: "ci_not_green", state: ci };
  }

  logger.info("ship: shipping", {
    pr,
    prHeadSha: mergeInfo.headRefOid,
    baseSha: mergeInfo.baseRefOid,
    deploymentCheckout: deps.autoshipDeploymentCheckout,
  });
  const result = await deps.ship(
    deps.autoshipCmd,
    shipEnv(deps, mergeInfo, request),
    { cwd: deps.autoshipDeploymentCheckout },
  );
  return await resolveShipResult(deps, request, result);
}

/** Re-deploys and verifies an already-merged PR's exact merge SHA (safe rerun, #10-style). */
async function shipAlreadyMerged(deps: ShipDeps, request: ShipRequest): Promise<ShipOutcome> {
  const { github, logger } = deps;
  const { pr } = request;
  logger.info("ship: PR already merged — continuing with deployment verification", { pr });

  const mergeInfo = await github.prMergeInfo(pr);
  if (!mergeInfo?.mergeCommitOid) {
    return {
      action: "blocked",
      reason: `PR #${pr} is merged, but its merge commit SHA could not be read for deployment.`,
    };
  }

  const result = await deps.ship(
    deps.autoshipCmd,
    { ...shipEnv(deps, mergeInfo, request), AUTOSHIP_MERGED_SHA: mergeInfo.mergeCommitOid },
    { cwd: deps.autoshipDeploymentCheckout },
  );
  return await resolveShipResult(deps, request, result);
}

function shipEnv(
  deps: ShipDeps,
  mergeInfo: GithubPrMergeInfo,
  request: ShipRequest,
): Record<string, string> {
  const env: Record<string, string> = {
    AUTOSHIP_PR_NUMBER: String(request.pr),
    AUTOSHIP_BRANCH: mergeInfo.headRefName,
    AUTOSHIP_REPO: deps.repoSlug,
    AUTOSHIP_PR_HEAD_SHA: mergeInfo.headRefOid,
    AUTOSHIP_BASE_SHA: mergeInfo.baseRefOid,
    AUTOSHIP_DEPLOYMENT_CHECKOUT: deps.autoshipDeploymentCheckout,
  };
  if (request.issueNumber !== null) {
    env.AUTOSHIP_ISSUE_NUMBER = String(request.issueNumber);
  }
  return env;
}

async function resolveShipResult(
  deps: ShipDeps,
  request: ShipRequest,
  result: ExecResult,
): Promise<ShipOutcome> {
  const { github, logger } = deps;
  const { pr, issueNumber } = request;
  const classified = classifyShipResult(result);

  if (result.code === 0 && classified.state === "merge_succeeded_deployment_not_attempted") {
    logger.info("ship: detached deployment pending verification", {
      pr,
      mergedSha: classified.report?.mergedSha,
    });
    return { action: "deploy_pending", mergedSha: classified.report?.mergedSha ?? null };
  }

  // Exit zero is not success when the ship command's own structured report says
  // production health failed or is unknown — the same rule autoship.ts applies.
  if (result.code !== 0 || classified.state !== "shipped" || classified.health !== "pass") {
    logger.error("ship: ship command failed", {
      pr,
      code: result.code,
      state: classified.state,
      health: classified.health,
      report: classified.report,
    });
    return { action: "deploy_failed", detail: shipFailureDetail(pr, result.code, classified) };
  }

  // Re-read GitHub after the command: the report must describe THIS PR's actual merge,
  // not a stale healthy production SHA left over from an earlier deploy.
  const deliveredMerge = await github.prMergeInfo(pr).catch(() => null);
  if (
    !deliveredMerge?.mergeCommitOid ||
    deliveredMerge.mergeCommitOid !== classified.report?.mergedSha ||
    (classified.report.prHeadSha !== null &&
      classified.report.prHeadSha !== deliveredMerge.headRefOid)
  ) {
    return {
      action: "deploy_failed",
      detail:
        `Ship command reported healthy production for PR #${pr}, but its merge/head SHA ` +
        "evidence did not match GitHub's current PR state.",
    };
  }

  logger.info("ship: shipped", { pr, state: classified.state, health: classified.health });

  let issueClosed: boolean | null = null;
  if (issueNumber !== null) {
    issueClosed = await github.closeIssue(issueNumber).catch(() => false);
    if (!issueClosed) {
      logger.error("ship: shipped but failed to close the issue", { pr, issue: issueNumber });
    }
  }

  return {
    action: "shipped",
    mergedSha: classified.report.mergedSha!,
    deployedSha: classified.report.deployedSha ?? classified.report.mergedSha!,
    issueClosed,
  };
}

function shipFailureDetail(
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
    classified.detail ? `Detail: ${classified.detail}` : null,
  ].filter((line): line is string => line !== null);
  return facts.join(" ");
}
