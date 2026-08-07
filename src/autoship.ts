/**
 * Autoship — merge and deploy a green PR without a human.
 *
 * This is the orchestration layer. It decides WHETHER to ship and enforces the two
 * repo-agnostic rails; the repo-specific act of merging and deploying is delegated to a
 * per-instance shell command (`DISPATCHER_AUTOSHIP_CMD`), because "how do I ship" differs
 * per target (one target may run deploy.sh; another may restart its own unit).
 *
 * The order of checks is the whole point, and every one of them was paid for in the
 * prior production failures:
 *
 *   1. A clean agent exit (exitCode 0) that opened a PR is a candidate. So are
 *      `pr_ready` and `ci_pending` runs descended from a later provider-capacity exit:
 *      their trusted commits + PR evidence already proves the provider is no longer
 *      needed. `ci_pending` preserves that trust while fresh checks or detached
 *      deployment verification are pending.
 *      Nothing else (an agent that gave up or crashed) ships.
 *   2. Re-confirm CI is green NOW, from `gh pr checks` exit status — never a verdict
 *      observed earlier, never the agent's self-report.
 *   3. Promote drafts and repair merge conflicts; unresolved merge state enters the
 *      agent-repair ladder rather than a human hold.
 *   4. Invoke the ship command. Exit status and structured health must both prove
 *      production success; every other result enters deploy recovery.
 *
 * Self-healing: a red CI verdict at step 2 does not immediately page a human. Up to
 * `ciSelfHealMaxAttempts` times, this module hands control back to the caller to relaunch
 * the assigned agent. It then requests one frontier escalation. Only failure after that
 * final attempt returns `exhausted`; the dispatcher owns the sole hold/page path.
 *
 * The ship command is trusted to be honest about success because it, not this module,
 * can see production health. This module re-gates CI but deliberately does not classify
 * a green change as destructive or require human review; backup and rollback own risk.
 */

import { classifyShipResult } from "./autoship-deployment.ts";
import {
  repairGeneratedFileConflicts,
  type GeneratedConflictRepairRequest,
  type GeneratedConflictRepairResult,
} from "./generated-conflict-repair.ts";
import { selectImages, formatImageSelectionResult, type CiImageLookup } from "./ci-image-acquisition.ts";
import type { RunRecord } from "./state.ts";
import type { ExecResult } from "./exec.ts";
import { NOTIFY_PRIORITY_DEFAULT, type Notifier } from "./notify.ts";
import type { Logger } from "./logger.ts";
import type { GithubPrMergeInfo } from "./github.ts";
import { classifyMissingChecksAfterGrace } from "./ci-readiness.ts";
import {
  acceptanceRepairReason,
  assessAcceptanceEvidence,
} from "./acceptance-evidence.ts";
import {
  decideRecovery,
  type RecoveryDecision,
  type RecoveryKind,
} from "./recovery-policy.ts";

/** Label left on a PR that autoship refused to ship, so it is easy to find and requeue. */
export const AUTOSHIP_HELD_LABEL = "autoship-held";
/** GitHub occasionally creates Actions checks shortly after PR creation. */
export const MISSING_CHECKS_GRACE_MS = 5 * 60 * 1000;

/** The GitHub surface autoship needs. A subset of GithubClient, so tests inject a fake. */
export interface AutoshipGithub {
  /** PR lifecycle state — used to recognise an already-merged PR and stand down (#10). */
  prState(pr: number): Promise<"open" | "merged" | "closed" | "unknown">;
  prChecksState(pr: number): Promise<"pass" | "pending" | "fail" | "unknown">;
  /** Optional richer read; older adapters can use prChecksState as a compatibility fallback. */
  prChecksEvidence?(pr: number): Promise<{
    state: "pass" | "pending" | "fail" | "unknown";
    checkCount: number | null;
  }>;
  waitForPrChecks(pr: number, timeoutSeconds: number): Promise<"pass" | "pending" | "fail" | "unknown">;
  prMergeInfo(pr: number): Promise<GithubPrMergeInfo | null>;
  prDiff(pr: number): Promise<string | null>;
  /** Issue/PR text and diff are optional for older adapters; the real adapter supplies them. */
  issueBody?(issue: number): Promise<string | null>;
  prTitleAndBody?(pr: number): Promise<{ title: string; body: string } | null>;
  comment(issue: number, body: string): Promise<boolean>;
  addLabel(issue: number, label: string): Promise<boolean>;
  /** The issue's current labels; retained as part of the GitHub surface for diagnostics. */
  issueLabels(issue: number): Promise<string[] | null>;
  /** `gh pr ready <pr>`: promotes a draft PR to ready for review. */
  markPrReady(pr: number): Promise<boolean>;
  /** `gh issue close <n>`: the ONLY place an issue closes -- see the shipped path below. */
  closeIssue(issue: number): Promise<boolean>;
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
  /** Assigned-model repair attempts per owned phase before frontier escalation. */
  ciSelfHealMaxAttempts: number;
  /**
   * CLI model for the one final automatic attempt after ordinary repairs are spent.
   */
  ciEscalationModel: string;
  /**
   * Durable checkpoint called immediately before a ship command can merge or restart.
   * The dispatcher uses it to park the claim before a self-restart can kill its parent.
   */
  beforeShip?: (context: { pr: number; mergedSha: string | null }) => void | Promise<void>;
  /** Persists the first empty-check observation before a delayed workflow recheck. */
  recordMissingChecksAt?: (at: number) => void | Promise<void>;
  repairGeneratedConflicts?: (
    request: GeneratedConflictRepairRequest,
  ) => Promise<GeneratedConflictRepairResult>;
  /** Optional CI image lookup for selecting CI-built images over dev-server rebuilds. */
  ciImageLookup?: CiImageLookup;
}

export type AutoshipOutcome =
  | { action: "skipped"; reason: string }
  | { action: "ci_not_green"; state: "pending" | "fail" | "unknown" }
  | { action: "repair"; kind: RecoveryKind; attempt: number; maxAttempts: number; reason: string }
  | { action: "escalate"; kind: RecoveryKind; model: string; reason: string }
  | { action: "exhausted"; kind: RecoveryKind; reason: string }
  | { action: "deploy_pending"; mergedSha: string | null }
  | { action: "shipped" };

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
  // Candidacy is about what the run PRODUCED, not which of pr_ready/ci_pending/ci_failed
  // status label it currently wears -- this function is the SOLE authority that decides
  // among those, called both right after a fresh run and again on every parked recheck
  // (dispatcher.ts's evaluateAutoship), so it must not gate on a status it might itself
  // be about to overwrite. `pr_ready` is authoritative delivery evidence when the
  // provider later exits on capacity: the runner assigns that status only after trusted
  // commits + PR + green-CI control records. A recheck may then park the same delivery as
  // `ci_pending` while fresh CI or detached deployment verification resolves; that state
  // must retain the same artifact trust across scans. Requiring the raw provider exit to
  // be zero contradicted that reconciliation and stranded an otherwise complete PR (#38).
  const artifactBackedDelivery =
    (run.status === "pr_ready" || run.status === "ci_pending") && run.exitCode !== null;
  if ((run.exitCode !== 0 && !artifactBackedDelivery) || run.prNumber === null) {
    return { action: "skipped", reason: "run has no trusted PR-ready delivery evidence" };
  }
  const pr = run.prNumber;

  // Green CI and production health cannot prove that the business outcome was attempted.
  // Check the issue against the actual PR evidence before merge (and again on a merged
  // rerun) so an explicit omission remains repairable and the issue stays open.
  const acceptance = await acceptanceEvidence(deps, run, pr);
  if (acceptance.status === "unknown") {
    logger.warn("autoship: acceptance evidence could not be read; parking", {
      issue: run.issueNumber,
      pr,
    });
    return { action: "ci_not_green", state: "unknown" };
  }
  if (acceptance.status === "fail") {
    const reason = [
      `PR #${pr} does not yet demonstrate every stated business acceptance criterion.`,
      acceptanceRepairReason(acceptance.evidence),
    ].join("\n");
    await github.comment(run.issueNumber, `## Autoship: acceptance criteria need repair\n\n${reason}`).catch(() => false);
    return recoveryOutcome(deps, run, "merge", reason);
  }

  // 1b. Already merged? Deploy its exact merge SHA instead of retrying `gh pr merge` or
  // standing down for manual verification. Merge is not shipped; verified production is.
  const prState = await github.prState(pr);
  if (prState === "merged") {
    return await alreadyMerged(deps, run, pr);
  }
  if (prState === "unknown") {
    logger.warn("autoship: PR state could not be read; parking without spending recovery", {
      issue: run.issueNumber,
      pr,
    });
    return { action: "ci_not_green", state: "unknown" };
  }
  if (prState === "closed") {
    return mergeBlocked(deps, run, pr, "PR is closed without merging");
  }

  // Mergeability is checked before CI. A stale/conflicted PR often has no check suite;
  // reading CI first used to misclassify that durable state as harmless `unknown`.
  const mergeInfo = await github.prMergeInfo(pr);
  if (!mergeInfo) {
    logger.warn("autoship: PR mergeability could not be read; parking without spending recovery", {
      issue: run.issueNumber,
      pr,
    });
    return { action: "ci_not_green", state: "unknown" };
  }
  if (mergeInfo.mergeStateStatus === "DIRTY") {
    const recovered = await recoverGeneratedConflicts(deps, run, pr, mergeInfo);
    if (recovered.action !== "recovered") return recovered.outcome;
  } else if (mergeInfo.mergeStateStatus === "BEHIND") {
    return await mergeBlocked(deps, run, pr, "PR branch is behind the current base branch");
  } else if (mergeInfo.mergeStateStatus === "UNKNOWN") {
    return { action: "ci_not_green", state: "unknown" };
  }

  // 2. Re-confirm CI now. A verdict from when the run ended is not trusted.
  const ciEvidence = await github.prChecksEvidence?.(pr) ?? {
    state: await github.prChecksState(pr),
    checkCount: null,
  };
  const firstNoChecks = ciEvidence.checkCount === 0
    ? run.ciChecksFirstObservedAt ?? Date.now()
    : null;
  const readiness = classifyMissingChecksAfterGrace(
    { checks: ciEvidence.state, checkCount: ciEvidence.checkCount, mergeState: "clean" },
    firstNoChecks,
    Date.now(),
    MISSING_CHECKS_GRACE_MS,
  );
  if (ciEvidence.checkCount === 0 && run.ciChecksFirstObservedAt === undefined) {
    // The first empty result is durable evidence of when the grace clock began, not
    // proof that CI is pending. Persist it before returning so restart cannot reset it.
    await deps.recordMissingChecksAt?.(firstNoChecks ?? Date.now());
  }
  if (readiness.kind === "repair" && readiness.reason === "checks-missing") {
    await github.comment(
      run.issueNumber,
      `## Autoship: missing CI checks on PR #${pr}\n\nNo check suite exists after the workflow grace period. Repairing the existing branch automatically; the issue claim and PR are retained.`,
    ).catch(() => false);
    return await recoveryOutcome(deps, run, "ci", `PR #${pr} has no CI check suite after the workflow grace period.`);
  }
  const ci = ciEvidence.state;
  if (ci !== "pass") {
    logger.info("autoship: CI not green, not shipping", { issue: run.issueNumber, pr, ci });
    if (ci === "fail") {
      return recoveryOutcome(
        deps,
        run,
        "ci",
        `PR #${pr} CI is still failing`,
      );
    }
    return { action: "ci_not_green", state: ci };
  }

  if (mergeInfo.isDraft) {
    // POLICY (2026-07-23): no human-review gate. Always promote a draft to ready and
    // ship it — a draft is not a safety control, CI + the escalation ladders are.
    await github.markPrReady(pr).catch(() => false);
    logger.info("autoship: promoted a draft PR to ready for review", {
      issue: run.issueNumber,
      pr,
    });
    // Fall through and ship in the same pass.
  }
  // POLICY (2026-07-23): reviewDecision === "REVIEW_REQUIRED" is deliberately NOT a
  // block. Autoship ships every green PR without human approval; the ship command
  // merges with admin override (branch-protection review requirements are removed on
  // these repos). The only permitted hold is a frontier-model-stumped failure.
  if (!mergeInfo.headRefOid || !mergeInfo.baseRefOid) {
    return await mergeBlocked(deps, run, pr, "PR head/base SHA could not be read");
  }
  // POLICY (2026-07-23): autoship EVERYTHING. The ONLY permitted hold is after a
  // failure has been retried and escalated to the frontier model and it is still
  // stumped (the CI-exhausted and ship-failed ladders below). There is deliberately
  // NO data-loss / destructive-change gate and NO human-review gate here: backup +
  // rollback (captured by deploy.sh before every deploy, restored by rollback.sh /
  // self-ship's detached rollback phase) is the safety net for an irreversible or bad
  // change, not a pre-merge hold. Destructive migrations ship like anything else.

  // Ship. The command owns merge + deploy + health-check + rollback.
  logger.info("autoship: shipping", {
    issue: run.issueNumber,
    pr,
    prHeadSha: mergeInfo.headRefOid,
    baseSha: mergeInfo.baseRefOid,
    deploymentCheckout: deps.autoshipDeploymentCheckout,
  });

  // Determine which images to use: CI images if available, otherwise fallback to rebuild.
  // We query based on the PR head SHA; the ship command can re-query if the merged SHA differs.
  const shipEnv: Record<string, string> = {
    AUTOSHIP_PR_NUMBER: String(pr),
    AUTOSHIP_ISSUE_NUMBER: String(run.issueNumber),
    AUTOSHIP_BRANCH: run.branch,
    AUTOSHIP_REPO: deps.repoSlug,
    AUTOSHIP_PR_HEAD_SHA: mergeInfo.headRefOid,
    AUTOSHIP_BASE_SHA: mergeInfo.baseRefOid,
    AUTOSHIP_DEPLOYMENT_CHECKOUT: deps.autoshipDeploymentCheckout,
  };

  if (deps.ciImageLookup) {
    const startMs = Date.now?.() ?? 0;
    const imageResult = await selectImages(deps.ciImageLookup, mergeInfo.headRefOid, startMs).catch(
      () => ({ source: "fallback" as const, reason: "ci_evidence_unknown" as const }),
    );
    const formatted = formatImageSelectionResult(imageResult);
    Object.assign(shipEnv, formatted);

    logger.info("autoship: image selection determined", {
      issue: run.issueNumber,
      pr,
      ...formatted,
    });
  }

  await deps.beforeShip?.({ pr, mergedSha: null });
  const result = await deps.ship(deps.autoshipCmd, shipEnv, {
    cwd: deps.autoshipDeploymentCheckout,
  });
  const classified = classifyShipResult(result);

  if (
    result.code === 0 &&
    classified.state === "merge_succeeded_deployment_not_attempted"
  ) {
    logger.info("autoship: detached deployment pending verification", {
      issue: run.issueNumber,
      pr,
      mergedSha: classified.report?.mergedSha,
    });
    return { action: "deploy_pending", mergedSha: classified.report?.mergedSha ?? null };
  }

  // Exit zero is not success when the ship command's own structured report says
  // production health failed or is unknown. Recording that as shipped is precisely the
  // false-success state that leaves the operator cleaning up a merged, undeployed PR.
  if (result.code !== 0 || classified.state !== "shipped" || classified.health !== "pass") {
    logger.error("autoship: ship command failed", {
      issue: run.issueNumber,
      pr,
      code: result.code,
      state: classified.state,
      health: classified.health,
      report: classified.report,
    });
    return recoveryOutcome(
      deps,
      run,
      "deploy",
      autoshipFailureBody(pr, result.code, classified),
    );
  }

  // The deploy report must describe this PR's actual merge, not merely some healthy
  // production SHA left in stale output. Re-read GitHub after the command because an
  // open PR may have been merged by the ship implementation itself.
  const deliveredMerge = await github.prMergeInfo(pr).catch(() => null);
  if (
    !deliveredMerge?.mergeCommitOid ||
    deliveredMerge.mergeCommitOid !== classified.report?.mergedSha ||
    (classified.report.prHeadSha !== null &&
      classified.report.prHeadSha !== deliveredMerge.headRefOid)
  ) {
    return recoveryOutcome(
      deps,
      run,
      "deploy",
      `Ship command reported healthy production for PR #${pr}, but its merge/head SHA evidence did not match GitHub's current PR state.`,
    );
  }

  logger.info("autoship: shipped", {
    issue: run.issueNumber,
    pr,
    state: classified.state,
    health: classified.health,
    report: classified.report,
  });

  // Close the issue HERE, and only here: PR bodies never carry a GitHub auto-close
  // keyword (Closes/Fixes/Resolves #n), specifically so merging never closes an issue
  // before its deploy is verified while its
  // deploy was still mid-build, prod still on the previous release). The ship command's
  // exit code alone is not quite enough to trust: classifyShipResult can still report
  // health "fail"/"unknown" on a structured status line even when the process exited 0
  // (e.g. a script that reports honestly but exits 0 for its own reasons), so gate on
  // the parsed health, not merely on having reached this branch.
  const closed = await github.closeIssue(run.issueNumber).catch(() => false);
  if (!closed) {
    logger.error("autoship: shipped but failed to close the issue", {
      issue: run.issueNumber,
      pr,
    });
    return recoveryOutcome(
      deps,
      run,
      "merge",
      `Production deployment for PR #${pr} verified, but GitHub issue #${run.issueNumber} could not be closed.`,
    );
  }

  await notifier
    .send(`Autoship: shipped #${run.issueNumber}`, `PR #${pr} merged and deployed.`, NOTIFY_PRIORITY_DEFAULT)
    .catch(() => undefined);
  return { action: "shipped" };
}

async function acceptanceEvidence(
  deps: AutoshipDeps,
  run: RunRecord,
  pr: number,
): Promise<
  | { status: "unknown" }
  | { status: "pass"; evidence: ReturnType<typeof assessAcceptanceEvidence> }
  | { status: "fail"; evidence: ReturnType<typeof assessAcceptanceEvidence> }
> {
  // Compatibility matters for a rolling upgrade: an injected/test adapter without these
  // reads cannot manufacture a failure, while the production GithubClient always has them.
  if (!deps.github.issueBody || !deps.github.prDiff) return { status: "pass", evidence: { status: "insufficient", criteria: [], findings: [] } };
  const [body, diff, prText] = await Promise.all([
    deps.github.issueBody(run.issueNumber),
    deps.github.prDiff(pr),
    deps.github.prTitleAndBody?.(pr) ?? Promise.resolve(null),
  ]);
  if (body === null || diff === null || (deps.github.prTitleAndBody && prText === null)) {
    return { status: "unknown" };
  }
  const evidence = assessAcceptanceEvidence(
    `${run.issueTitle}\n${body}`,
    `${prText?.title ?? ""}\n${prText?.body ?? ""}\n${diff}`,
  );
  if (evidence.status === "fail") return { status: "fail", evidence };
  return { status: "pass", evidence };
}

async function recoveryOutcome(
  deps: AutoshipDeps,
  run: RunRecord,
  kind: RecoveryKind,
  reason: string,
): Promise<Extract<AutoshipOutcome, { action: "repair" | "escalate" | "exhausted" }>> {
  const decision: RecoveryDecision = decideRecovery(
    run.recovery,
    kind,
    deps.ciSelfHealMaxAttempts,
  );
  switch (decision.action) {
    case "retry":
      return {
        action: "repair",
        kind,
        attempt: decision.attempt,
        maxAttempts: decision.maxAttempts,
        reason,
      };
    case "escalate":
      await deps.github
        .comment(
          run.issueNumber,
          [
            `## Autoship: ${kind} repair attempts exhausted, escalating`,
            "",
            reason,
            "",
            `Escalating to \`${deps.ciEscalationModel}\` for the final automated attempt.`,
          ].join("\n"),
        )
        .catch(() => false);
      return { action: "escalate", kind, model: deps.ciEscalationModel, reason };
    case "exhausted":
      return { action: "exhausted", kind, reason };
    case "hold":
    case "unknown":
      // Hold and unknown conditions exit autoship; treat as exhausted
      return { action: "exhausted", kind, reason: decision.reason };
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
    facts.push("The automated recovery attempt must re-read production state before redeploying.");
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
  | {
      action: "failed";
      outcome: Extract<AutoshipOutcome, { action: "repair" | "escalate" | "exhausted" | "ci_not_green" }>;
    }
> {
  const { github, logger } = deps;
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
    return {
      action: "failed",
      outcome: await recoveryOutcome(
        deps,
        run,
        "merge",
        `PR #${pr} merge-conflict recovery failed: ${result.reason}; conflicts: ${result.conflictPaths.join(", ")}`,
      ),
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
  const ci = await github.waitForPrChecks(pr, deps.generatedConflictCiWaitSeconds);
  if (ci !== "pass") {
    logger.info("autoship: repaired PR CI not green, not shipping", { issue: run.issueNumber, pr, ci });
    if (ci === "fail") {
      return {
        action: "failed",
        outcome: await recoveryOutcome(
          deps,
          run,
          "ci",
          `PR #${pr} CI failed after generated-conflict recovery.`,
        ),
      };
    }
    return { action: "failed", outcome: { action: "ci_not_green", state: "pending" } };
  }

  return { action: "recovered" };
}

/** Deploy and verify an already-merged PR by exact merge commit SHA. */
async function alreadyMerged(deps: AutoshipDeps, run: RunRecord, pr: number): Promise<AutoshipOutcome> {
  const { github, notifier, logger } = deps;
  logger.info("autoship: PR already merged — continuing with deployment verification", {
    issue: run.issueNumber,
    pr,
  });
  const mergeInfo = await github.prMergeInfo(pr);
  if (!mergeInfo?.mergeCommitOid) {
    return recoveryOutcome(
      deps,
      run,
      "merge",
      `PR #${pr} is merged, but its merge commit SHA could not be read for deployment.`,
    );
  }

  await deps.beforeShip?.({ pr, mergedSha: mergeInfo.mergeCommitOid });
  const result = await deps.ship(
    deps.autoshipCmd!,
    {
      AUTOSHIP_PR_NUMBER: String(pr),
      AUTOSHIP_ISSUE_NUMBER: String(run.issueNumber),
      AUTOSHIP_BRANCH: run.branch,
      AUTOSHIP_REPO: deps.repoSlug,
      AUTOSHIP_PR_HEAD_SHA: mergeInfo.headRefOid,
      AUTOSHIP_BASE_SHA: mergeInfo.baseRefOid,
      AUTOSHIP_MERGED_SHA: mergeInfo.mergeCommitOid,
      AUTOSHIP_DEPLOYMENT_CHECKOUT: deps.autoshipDeploymentCheckout,
    },
    { cwd: deps.autoshipDeploymentCheckout },
  );
  const classified = classifyShipResult(result);
  if (
    result.code === 0 &&
    classified.state === "merge_succeeded_deployment_not_attempted"
  ) {
    return { action: "deploy_pending", mergedSha: mergeInfo.mergeCommitOid };
  }
  if (result.code !== 0 || classified.state !== "shipped" || classified.health !== "pass") {
    return recoveryOutcome(
      deps,
      run,
      "deploy",
      autoshipFailureBody(pr, result.code, classified),
    );
  }

  const closed = await github.closeIssue(run.issueNumber).catch(() => false);
  if (!closed) {
    logger.error("autoship: deployed already-merged PR but failed to close issue", {
      issue: run.issueNumber,
      pr,
    });
    return recoveryOutcome(
      deps,
      run,
      "merge",
      `Already-merged PR #${pr} deployed successfully, but GitHub issue #${run.issueNumber} could not be closed.`,
    );
  }
  await notifier
    .send(
      `Autoship: shipped #${run.issueNumber}`,
      `PR #${pr} was already merged; merged commit ${mergeInfo.mergeCommitOid} is now deployed and verified.`,
      NOTIFY_PRIORITY_DEFAULT,
    )
    .catch(() => undefined);
  return { action: "shipped" };
}

async function mergeBlocked(
  deps: AutoshipDeps,
  run: RunRecord,
  pr: number,
  reason: string,
): Promise<AutoshipOutcome> {
  const { logger } = deps;
  logger.warn("autoship: PR is not mergeable", { issue: run.issueNumber, pr, reason });
  return recoveryOutcome(deps, run, "merge", `PR #${pr} is not mergeable: ${reason}`);
}
