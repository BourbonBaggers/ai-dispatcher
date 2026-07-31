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
  assignmentForModel,
  resolveRoutingOverride,
  DISPATCH_READY_LABEL,
  EFFORT_LABELS,
  HOLD_LABELS,
  isDispatchRequested,
  migrationForLegacyIntakeLabels,
  NEEDS_INPUT_LABEL,
  validateDispatchReadyContract,
  type DispatcherAgent,
  type ResolvedAssignment,
} from "./labels.ts";
import { assessIssueText, applyAssessment } from "./issue-assessment.ts";
import { selectEligibleIssue } from "./selection.ts";
import { untrustedAuthorComment, UNTRUSTED_AUTHOR_LABEL } from "./author-auth.ts";
import { detectAgentOverride, conflictCommentFor, selectAgentModel } from "./agent-override.ts";
import { isProviderSuppressed } from "./token-exhaustion.ts";
import { launchRun } from "./runner.ts";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { NOTIFY_PRIORITY_HIGH, type Notifier } from "./notify.ts";
import { autoshipRun, AUTOSHIP_HELD_LABEL, type ShipRunner } from "./autoship.ts";
import {
  dispatchableModels,
  effectiveModelPrice,
  modelByCliModel,
  tierRank,
  MODEL_TIERS,
  type ModelEntry,
} from "./models.ts";
import {
  deriveEffort,
  deriveMinimumTier,
  effortForRouteTier,
  parseCharacteristics,
  planNextAttempt,
  routeIssue,
  CHARACTERISTIC_LABEL_PREFIXES,
  HUMAN_OVERRIDE_LABEL,
  type FailureCategory,
} from "./routing.ts";
import {
  assessPools,
  isModelCapacityExhausted,
  type CapacityAssessment,
  type PoolUsageObservation,
} from "./capacity.ts";
import {
  readLiveCapacity,
  type CapacityReadResult,
} from "./capacity-adapters.ts";
import {
  renderCostSummary,
  UNAVAILABLE_TOKENS,
  type AttemptCostEvidence,
  type AttemptRecord,
  type TelemetryStore,
} from "./telemetry.ts";
import type { GithubClient, GithubIssue } from "./github.ts";
import type { DispatcherConfig } from "./config.ts";
import type { Logger } from "./logger.ts";
import {
  phaseForStatus,
  type StateStore,
  type RunPhase,
  type RunRecord,
  type RoutingAssignmentEvidence,
} from "./state.ts";
import { appendRunOutputEntry } from "./run-output.ts";
import { redact } from "./sanitize.ts";
import {
  decideRecovery,
  updateRecovery,
  type RecoveryKind,
} from "./recovery-policy.ts";
import { run as execRun, terminateProcessTree } from "./exec.ts";
import {
  BLOCKED_LABEL,
  blockedQueueAuditPrompt,
  decideBlockedQueueAudit,
  parseModelAuditVerdict,
  referencedIssueNumbers,
  resolveBlockedQueueAuditConfig,
  selectBlockedQueueAuditCandidates,
  type BlockedQueueAuditConfig,
  type DependencyEvidence,
  type ModelAuditVerdict,
} from "./blocked-queue.ts";

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
  /** Injectable live-capacity reader; production defaults to both provider adapters. */
  readCapacity?: (nowMs: number) => Promise<CapacityReadResult>;
  /** Injectable orphan inspection/termination for startup reconciliation tests. */
  processCommand?: (pid: number) => string | null;
  terminateOrphan?: (pid: number) => void;
  /** Injectable agent launcher for crash-boundary tests. */
  launch?: typeof launchRun;
  /** Injectable stale-blocked-queue semantic auditor for deterministic tests. */
  blockedQueueAuditor?: (
    prompt: string,
    config: BlockedQueueAuditConfig,
  ) => Promise<ModelAuditVerdict>;
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
  isSuppressed: (run: RunRecord) => boolean,
  maxResumes: number,
): RunRecord | null {
  return resumables.find((run) => !isSuppressed(run) && run.resumeCount < maxResumes) ?? null;
}

/**
 * Whether a terminal run has stopped actively working — i.e. the dispatcher should drop
 * its `agent-working` label and NOT promise an automatic agent resume in the issue
 * comment. A resumable run (interrupted / timed_out / token_exhausted) is still working
 * (the next scan relaunches the agent); a parked run (ci_pending) is waiting on a CI
 * recheck; a ladder run (ci_failed) is mid-self-heal. All three keep `agent-working`. Every
 * other terminal status (pr_ready, shipped, held, failed) is done working, so this returns true.
 *
 * NOTE: this is NOT the same question as "does the run keep its ISSUE claim" — that is
 * `CLAIMING_STATUSES` (state.ts), which additionally includes `pr_ready` and `held`.
 * Neither has an active agent, but both retain the issue claim: a PR handoff must not
 * rerun, and clearing a proven exhausted `autoship-held` resumes the existing PR.
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

/** Every relaunch consumes budget; repeated provider startup output is not durable progress. */
export function nextResumeCount(run: Pick<RunRecord, "resumeCount">): number {
  return run.resumeCount + 1;
}

/** A new repair rung gets its own finite resume budget and monotonic attempt id. */
export function nextRecoveryLaunch(
  run: Pick<RunRecord, "outputSeq" | "attemptNumber">,
): Pick<RunRecord, "resumeCount" | "lastProgressSeq" | "attemptNumber"> {
  return {
    resumeCount: 0,
    lastProgressSeq: run.outputSeq,
    attemptNumber: run.attemptNumber + 1,
  };
}

export function checkpointLadderRun(store: StateStore, run: RunRecord): RunRecord {
  return store.updateRun(run.id, {
    status: "ci_failed",
    phase: "recovering",
    finalizationPending: true,
  });
}

function recordRunPhase(
  deps: Pick<DispatcherDeps, "config" | "store" | "now">,
  run: RunRecord,
  phase: RunPhase,
  message: string,
  patch: Partial<RunRecord> = {},
): RunRecord {
  const now = deps.now ?? (() => Date.now());
  const current = deps.store.getRun(run.id) ?? run;
  const outputSeq = current.outputSeq + 1;
  if (deps.config.stateDir) {
    appendRunOutputEntry(deps.config.stateDir, {
      version: 1,
      runId: run.id,
      seq: outputSeq,
      timestamp: now(),
      type: "phase",
      stream: "control",
      phase,
      message: redact(message),
    });
    return deps.store.updateRun(run.id, { ...patch, phase, outputSeq });
  }
  return deps.store.updateRun(run.id, { ...patch, phase });
}

export function isOwnedLauncherCommand(command: string | null, run: RunRecord): boolean {
  if (!command || !command.includes("dispatch-agent.sh")) return false;
  const argument = (name: string, value: string): boolean =>
    new RegExp(`(?:^|\\s)--${name}\\s+${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|$)`).test(
      command,
    );
  return (
    argument("issue", String(run.issueNumber)) &&
    argument("branch", run.branch)
  );
}

function processCommand(pid: number): string | null {
  try {
    return execFileSync("ps", ["-o", "args=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 5_000,
    }).trim() || null;
  } catch {
    return null;
  }
}

function terminateOrphan(pid: number): void {
  terminateProcessTree(pid, "SIGTERM");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  terminateProcessTree(pid, "SIGKILL");
}

/** Immutable assignment restored for every non-frontier repair, regardless of prior phases. */
export function assignedIdentity(run: RunRecord): Pick<
  RunRecord,
  "agent" | "modelLabel" | "cliModel" | "effortLabel" | "cliEffort"
> {
  return {
    agent: run.assignedAgent,
    modelLabel: run.assignedModelLabel,
    cliModel: run.assignedCliModel,
    effortLabel: run.assignedEffortLabel,
    cliEffort: run.assignedCliEffort,
  };
}

interface RefinedAssignment {
  assignment: ResolvedAssignment | null;
  routing: RoutingAssignmentEvidence | null;
  needsInput: string | null;
}

/**
 * Second-pass routing for the one issue actually being picked up (#51 §1).
 *
 * The scan's first pass is label-only and IO-free so it can rank every candidate without
 * a read per issue. Only the winner earns a body read — and that read is what makes the
 * simplified intake contract honest: the author supplies type, priority, and risk, and the
 * dispatcher works out context, ambiguity, verification, and recoverability by *reading the
 * issue* instead of asking a human to predict them.
 *
 * Degrades honestly. A failed body read leaves the label-only assignment untouched rather
 * than inventing characteristics, exactly like every other unknown GitHub read.
 */
async function refineAssignmentFromIssueText(
  deps: DispatcherDeps,
  issue: GithubIssue,
  capacityByPool: Map<string, CapacityAssessment>,
  nowMs: number,
): Promise<RefinedAssignment> {
  const none: RefinedAssignment = { assignment: null, routing: null, needsInput: null };
  // An unreadable issue body is `unknown`, never a fabricated characteristic set: keep the
  // label-only assignment rather than routing on invented evidence. Refinement is an
  // improvement on the first pass, so it must never be able to fail a pickup outright.
  let body: string | null = null;
  try {
    body = await deps.github.issueBody(issue.number);
  } catch (err) {
    deps.logger.debug("routing: issue body read failed", {
      issue: issue.number,
      error: err instanceof Error ? err.message : String(err),
    });
    return none;
  }
  if (body === null) {
    deps.logger.debug("routing: issue body unavailable, keeping label-only assignment", {
      issue: issue.number,
    });
    return none;
  }

  const assessment = assessIssueText(issue.title, body);
  const characteristics = applyAssessment(parseCharacteristics(issue.labels), assessment, issue.labels);
  const decision = routeIssue(characteristics, capacityByPool, dispatchableModels());
  const effort = deriveEffort(characteristics);

  if (decision.needsInput) {
    return { assignment: null, routing: null, needsInput: decision.reason };
  }
  if (!decision.selected) return none;

  const assignment = assignmentForModel(decision.selected, effort.effortLabel);
  if (!assignment.ok) return none;

  return {
    assignment: assignment.value,
    routing: {
      source: "automatic",
      minimumTier: decision.minimumTier,
      characteristicLabels: characteristicLabels(issue.labels),
      rationaleLabels: decision.rationaleLabels,
      confidence: decision.confidence,
      capacitySelection: decision.capacitySelection,
      selectedPool: decision.selected.capacityPool,
      effortReason: effort.reason,
      capacity: capacityEvidence(capacityByPool),
      assignedAt: nowMs,
      // Why this route, in the dispatcher's own words — the audit trail for a decision no
      // label records any more.
      assessmentEvidence: assessment.evidence,
    },
    needsInput: null,
  };
}

/**
 * Normalizes queued issues from the old intake contract to the new one (#51 §6).
 *
 * Runs before selection so a migrated issue is immediately eligible in the same scan, and
 * mutates the in-memory labels to match what was just written — otherwise the issue would
 * be judged against its pre-migration labels and skipped for one cycle.
 *
 * Deliberately conservative: only issues that already ask for dispatch are touched, held
 * issues and human overrides are left exactly as they are, and an issue that cannot be
 * normalized safely is left for a human rather than guessed at. Label writes are
 * idempotent, so a crash mid-migration simply resumes on the next scan — no issue is
 * claimed, duplicated, or lost by this pass.
 */
async function migrateIntakeLabels(deps: DispatcherDeps, issues: GithubIssue[]): Promise<void> {
  for (const issue of issues) {
    if (!isDispatchRequested(issue.labels)) continue;
    if (issue.labels.some((label) => (HOLD_LABELS as readonly string[]).includes(label))) continue;
    if (issue.labels.includes(HUMAN_OVERRIDE_LABEL)) continue;

    const migration = migrationForLegacyIntakeLabels(issue.labels);
    if (!migration.add.length && !migration.remove.length) continue;

    for (const label of migration.add) {
      if (!(await deps.github.addLabel(issue.number, label))) return;
    }
    for (const label of migration.remove) {
      await deps.github.removeLabel(issue.number, label);
    }
    issue.labels = [...issue.labels.filter((l) => !migration.remove.includes(l)), ...migration.add];
    deps.logger.info("migrated intake labels", {
      issue: issue.number,
      added: migration.add,
      removed: migration.remove,
      ...(migration.needsInputReason ? { needsInput: migration.needsInputReason } : {}),
    });
  }
}

/**
 * Detects and blocks issues with conflicting agent labels.
 *
 * When an issue has multiple agent labels, the dispatcher cannot select a single agent.
 * This function applies the `blocked` label and posts an explanatory comment once,
 * then updates the in-memory labels to prevent the issue from being claimed.
 *
 * Runs before assignment evaluation so conflicts are caught early.
 */
async function handleAgentLabelConflicts(deps: DispatcherDeps, issues: GithubIssue[]): Promise<void> {
  for (const issue of issues) {
    const override = detectAgentOverride(issue.labels);
    if (!override.hasConflict) continue;
    if (issue.labels.includes("blocked")) continue; // Already blocked

    const comment = conflictCommentFor(override.conflictingLabels ?? []);
    if (!(await deps.github.addLabel(issue.number, "blocked"))) return;
    if (!(await deps.github.comment(issue.number, comment))) {
      deps.logger.warn("failed to post agent conflict comment", {
        issue: issue.number,
        labels: override.conflictingLabels,
      });
    }

    issue.labels = [...issue.labels, "blocked"];
    deps.logger.info("blocked issue with conflicting agent labels", {
      issue: issue.number,
      conflicts: override.conflictingLabels,
    });
  }
}

/**
 * Posts the issue's aggregated cost summary at a terminal state (#51 §7).
 *
 * Strictly best-effort: the durable telemetry record is authoritative, so a failure to
 * aggregate or comment must never change delivery status. Runs before the issue is closed
 * so the summary is visible on the completed issue.
 */
async function postCostSummary(deps: DispatcherDeps, issueNumber: number): Promise<void> {
  if (!deps.telemetry) return;
  try {
    const record = deps.telemetry.aggregateOne(issueNumber, (deps.now ?? Date.now)());
    await deps.github.comment(issueNumber, renderCostSummary(record));
  } catch (err) {
    deps.logger.debug("cost summary unavailable", {
      issue: issueNumber,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function characteristicLabels(labels: string[]): string[] {
  const prefixes = Object.values(CHARACTERISTIC_LABEL_PREFIXES).map((prefix) => `${prefix}:`);
  return labels.filter((label) => prefixes.some((prefix) => label.startsWith(prefix)));
}

function usageByPool(store: StateStore): Map<string, PoolUsageObservation> {
  const usage = new Map<string, PoolUsageObservation>();
  for (const model of dispatchableModels()) {
    if (!usage.has(model.capacityPool)) {
      usage.set(model.capacityPool, { lastActivityAt: null, activeRuns: 0 });
    }
  }
  for (const run of store.allRuns()) {
    const model = modelByCliModel(run.cliModel);
    if (!model) continue;
    const current = usage.get(model.capacityPool) ?? {
      lastActivityAt: null,
      activeRuns: 0,
    };
    current.lastActivityAt = Math.max(current.lastActivityAt ?? 0, run.startedAt);
    if (run.status === "claimed" || run.status === "running") current.activeRuns += 1;
    usage.set(model.capacityPool, current);
  }
  return usage;
}

async function pickupCapacity(
  deps: DispatcherDeps,
  nowMs: number,
): Promise<Map<string, CapacityAssessment>> {
  let read: CapacityReadResult;
  try {
    read = await (deps.readCapacity ?? readLiveCapacity)(nowMs);
  } catch {
    read = { snapshots: new Map(), errors: new Map([["capacity", "capacity readers failed"]]) };
  }
  for (const [pool, error] of read.errors) {
    deps.logger.warn("capacity read unavailable — using deterministic fallback", {
      pool,
      reason: error,
    });
  }

  const models = dispatchableModels();
  const pools = [...new Set(models.map((model) => model.capacityPool))];
  const cooldowns = new Map<string, number | null>();
  const authoritative = new Map<string, boolean>();
  for (const agent of ["claude", "codex"] as const) {
    const pool = agent === "claude" ? "claude-subscription" : "codex-subscription";
    const suppression = deps.store.getProviderSuppression(agent);
    cooldowns.set(pool, suppression?.until ?? null);
    authoritative.set(pool, suppression?.authoritative ?? true);
  }
  const assessments = assessPools(
    pools,
    cooldowns,
    usageByPool(deps.store),
    nowMs,
    authoritative,
    read.snapshots,
  );

  // A successful affirmative live read is stronger and newer than a stale cooldown.
  for (const agent of ["claude", "codex"] as const) {
    const pool = agent === "claude" ? "claude-subscription" : "codex-subscription";
    const assessment = assessments.get(pool);
    const allProviderModelsAvailable = dispatchableModels()
      .filter((model) => model.cli === agent)
      .every(
        (model) =>
          assessment && !isModelCapacityExhausted(assessment, model.modelLabel),
      );
    if (
      deps.store.getProviderSuppression(agent) &&
      (assessment?.confidence === "provider-reported" ||
        assessment?.confidence === "cli-reported") &&
      allProviderModelsAvailable
    ) {
      deps.store.setProviderSuppression(agent, null);
      deps.logger.info("cleared stale provider suppression from fresh capacity evidence", {
        agent,
        headroomPercent: assessment.headroomPercent ?? undefined,
      });
    }
  }
  return assessments;
}

function capacityEvidence(
  assessments: Map<string, CapacityAssessment>,
): RoutingAssignmentEvidence["capacity"] {
  return [...assessments.values()].map((assessment) => ({
    pool: assessment.pool,
    state: assessment.state,
    confidence: assessment.confidence,
    observedAt: assessment.observedAt,
    resetAt: assessment.resetAt,
    headroomPercent: assessment.headroomPercent,
    reason: assessment.reason,
  }));
}

/**
 * A quota exit changes capacity, not task difficulty. Re-route inside the original
 * capability band and preserve the original effort; frontier remains unavailable unless
 * the issue characteristics independently required it.
 */
export function planQuotaHandoff(
  run: RunRecord,
  capacityByPool: Map<string, CapacityAssessment>,
): ReturnType<typeof assignmentForModel> {
  const characteristics = parseCharacteristics(run.routing?.characteristicLabels ?? []);
  const decision = routeIssue(characteristics, capacityByPool, dispatchableModels(), {
    rotationCursor: modelByCliModel(run.cliModel)?.capacityPool ?? null,
  });
  if (!decision.selected) return { ok: false, reason: decision.reason };
  const currentModel = modelByCliModel(run.cliModel);
  if (currentModel && tierRank(decision.selected.tier) < tierRank(currentModel.tier)) {
    const comparable = dispatchableModels()
      .filter((model) => !model.frontier)
      .filter((model) => model.capacityPool !== currentModel.capacityPool)
      .filter((model) => tierRank(model.tier) >= tierRank(currentModel.tier))
      .filter((model) => {
        const assessment = capacityByPool.get(model.capacityPool);
        return !(assessment && isModelCapacityExhausted(assessment, model.modelLabel));
      })
      .sort((a, b) => tierRank(a.tier) - tierRank(b.tier))[0];
    if (comparable) return assignmentForModel(comparable, run.assignedEffortLabel);
  }
  return assignmentForModel(decision.selected, run.assignedEffortLabel);
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

  // The runner checkpoints its terminal observation before finalizeRun applies recovery
  // or autoship. A SIGKILL in that narrow window used to strand pr_ready/ci_failed rows
  // forever (or release a failed row for a destructive fresh redispatch). Finish that
  // exact run record before considering any other work.
  const pendingFinalization = store.pendingFinalizations()[0];
  if (pendingFinalization) {
    if (config.dryRun) {
      return {
        started: null,
        message: `[dry-run] would finalize interrupted bookkeeping for issue #${pendingFinalization.issueNumber}.`,
      };
    }
    await finalizeRun(deps, pendingFinalization);
    return {
      started: store.getRun(pendingFinalization.id),
      message: `Recovered finalization for issue #${pendingFinalization.issueNumber}.`,
    };
  }

  const capacityByPool = await pickupCapacity(deps, nowMs);
  const suppressionFor = (agent: DispatcherAgent) => store.getProviderSuppression(agent);
  const suppressedUntil = (agent: DispatcherAgent): Date | null => {
    const record = suppressionFor(agent);
    return record === null ? null : new Date(record.until);
  };
  const isSuppressed = (run: RunRecord): boolean => {
    const model = modelByCliModel(run.cliModel);
    const assessment = model ? capacityByPool.get(model.capacityPool) : undefined;
    // Fresh provider evidence is more specific than the legacy provider-wide cooldown:
    // it can keep a Sonnet run parked while allowing Haiku, for example. Retaining that
    // cooldown until every model is affirmative preserves the fallback if reads fail.
    if (
      assessment &&
      (assessment.confidence === "provider-reported" ||
        assessment.confidence === "cli-reported") &&
      model
    ) {
      return isModelCapacityExhausted(assessment, model.modelLabel);
    }
    if (isProviderSuppressed(suppressedUntil(run.agent), nowMs)) return true;
    return Boolean(
      model && assessment && isModelCapacityExhausted(assessment, model.modelLabel),
    );
  };

  // ── Resume first ──
  // A resumable run holds its issue's claim, so leaving it parked while we pick up fresh
  // work would quietly abandon it. Interrupted/timed-out runs get the next slot.
  const resumableRuns = store.resumableRuns();
  for (const exhausted of resumableRuns.filter(
    (run) => run.status === "token_exhausted" && isSuppressed(run),
  )) {
    const handoff = planQuotaHandoff(exhausted, capacityByPool);
    if (!handoff.ok || handoff.value.agent === exhausted.agent) continue;
    if (config.dryRun) {
      return {
        started: null,
        message: `[dry-run] would hand off quota-blocked issue #${exhausted.issueNumber} to ${handoff.value.agent}.`,
      };
    }
    const handedOff = store.updateRun(exhausted.id, {
      ...handoff.value,
      failureSummary: `capacity handoff from ${exhausted.agent} to ${handoff.value.agent}`,
    });
    logger.info("handing quota-blocked run to another provider", {
      runId: exhausted.id,
      issue: exhausted.issueNumber,
      from: exhausted.agent,
      to: handoff.value.agent,
      model: handoff.value.cliModel,
    });
    const resumed = await resumeRun(deps, handedOff);
    return {
      started: resumed,
      message: `Handed quota-blocked issue #${exhausted.issueNumber} to ${handoff.value.agent}.`,
    };
  }
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
    (run) => !isSuppressed(run) && run.resumeCount >= MAX_AUTO_RESUMES,
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

  // ── Recover a ready PR that autoship did not finish ──
  // With autoship configured, `pr_ready` is not a terminal handoff: it is an intermediate
  // artifact state that must converge to shipped/parked/recovery. Older code could strand
  // it after reconciling a provider-capacity exit because autoship still demanded exit 0.
  // Re-evaluate it before fresh work; without autoship, pr_ready remains the intended
  // terminal human handoff and is left alone.
  const ready = config.autoshipCmd ? store.prReadyRuns()[0] : undefined;
  if (ready) {
    if (config.dryRun) {
      return {
        started: null,
        message: `[dry-run] would resume autoship for ready issue #${ready.issueNumber} (PR #${ready.prNumber ?? "?"}).`,
      };
    }
    await recheckReadyRun(deps, ready);
    return {
      started: store.getRun(ready.id),
      message: `Resumed autoship for ready issue #${ready.issueNumber}.`,
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

  if (!config.dryRun) {
    await migrateIntakeLabels(deps, listing.issues);
    await handleAgentLabelConflicts(deps, listing.issues);
  }

  const claimedByIssue = store.claimingRunsByIssue();
  const evidenceByIssue = new Map<number, RoutingAssignmentEvidence>();
  const cursor = store.getSettings().lastInitialCapacityPool;
  const { candidates, target } = selectEligibleIssue(listing.issues, {
    assignmentForIssue: (issue) => {
      if (issue.labels.includes(DISPATCH_READY_LABEL)) {
        const contract = validateDispatchReadyContract(issue.labels);
        if (!contract.ok) return contract;
      }
      const characteristics = parseCharacteristics(issue.labels);
      const derivedEffort = deriveEffort(characteristics);
      const override = resolveRoutingOverride(issue.labels);
      if (!override.ok) return override;

      if (override.value) {
        const assessment = capacityByPool.get(override.value.model.capacityPool);
        if (
          assessment &&
          isModelCapacityExhausted(assessment, override.value.model.modelLabel)
        ) {
          return {
            ok: false,
            reason: `${override.value.model.capacityPool} is currently exhausted; override will be retried automatically`,
          };
        }
        const effortLabel = override.value.effortLabel ?? derivedEffort.effortLabel;
        const assignment = assignmentForModel(override.value.model, effortLabel);
        if (!assignment.ok) return assignment;
        evidenceByIssue.set(issue.number, {
          source: "human-override",
          minimumTier: override.value.model.tier,
          characteristicLabels: characteristicLabels(issue.labels),
          rationaleLabels: ["route:human-override"],
          confidence: "high",
          capacitySelection: "human-override",
          selectedPool: override.value.model.capacityPool,
          effortReason:
            override.value.effortLabel === null
              ? derivedEffort.reason
              : `explicit human override ${override.value.effortLabel}`,
          capacity: capacityEvidence(capacityByPool),
          assignedAt: nowMs,
        });
        return assignment;
      }

      // Agent-level override: constrain model selection to a specific agent.
      const agentOverride = detectAgentOverride(issue.labels);
      if (agentOverride.agent && !agentOverride.hasConflict) {
        const minimumTier = deriveMinimumTier(characteristics);
        const needsLargeContext = characteristics.contextSize === "large";
        const model = selectAgentModel(agentOverride.agent, minimumTier, needsLargeContext, capacityByPool);
        if (!model) {
          return {
            ok: false,
            reason: `no ${agentOverride.agent} model available for ${minimumTier} tier`,
          };
        }
        const assignment = assignmentForModel(model, derivedEffort.effortLabel);
        if (!assignment.ok) return assignment;
        evidenceByIssue.set(issue.number, {
          source: "automatic",
          minimumTier: model.tier,
          characteristicLabels: characteristicLabels(issue.labels),
          rationaleLabels: [`agent:${agentOverride.agent}`],
          confidence: "high",
          capacitySelection: "agent-override",
          selectedPool: model.capacityPool,
          effortReason: derivedEffort.reason,
          capacity: capacityEvidence(capacityByPool),
          assignedAt: nowMs,
        });
        return assignment;
      }

      const decision = routeIssue(characteristics, capacityByPool, dispatchableModels(), {
        rotationCursor: cursor,
      });
      if (!decision.selected) return { ok: false, reason: decision.reason };
      const assignment = assignmentForModel(decision.selected, derivedEffort.effortLabel);
      if (!assignment.ok) return assignment;
      evidenceByIssue.set(issue.number, {
        source: "automatic",
        minimumTier: decision.minimumTier,
        characteristicLabels: characteristicLabels(issue.labels),
        rationaleLabels: decision.rationaleLabels,
        confidence: decision.confidence,
        capacitySelection: decision.capacitySelection,
        selectedPool: decision.selected.capacityPool,
        effortReason: derivedEffort.reason,
        capacity: capacityEvidence(capacityByPool),
        assignedAt: nowMs,
      });
      return assignment;
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
    const recovered = await recoverBlockedQueueIfIdle(deps, listing.issues, claimedByIssue);
    if (recovered.attempted) return { started: null, message: recovered.message };
    return { started: null, message: "No eligible issues." };
  }

  const { issue } = target;
  let assignment = target.assignment;
  let routing = evidenceByIssue.get(issue.number)!;

  // Only an automatic assignment is refined: a human override is authoritative by
  // definition, and re-reading the issue must never quietly overrule it.
  if (routing.source === "automatic") {
    const refined = await refineAssignmentFromIssueText(deps, issue, capacityByPool, nowMs);
    if (refined.needsInput !== null) {
      if (!config.dryRun) {
        await github.addLabel(issue.number, NEEDS_INPUT_LABEL);
        await github.comment(
          issue.number,
          `## Dispatcher needs input\n\n${refined.needsInput}\n\n` +
            `Add the missing detail and remove \`${NEEDS_INPUT_LABEL}\` to requeue this issue.`,
        );
      }
      return {
        started: null,
        message: `Issue #${issue.number} needs input: ${refined.needsInput}`,
      };
    }
    if (refined.assignment && refined.routing) {
      if (refined.assignment.cliModel !== assignment.cliModel) {
        logger.info("routing: issue text changed the route", {
          issue: issue.number,
          from: assignment.cliModel,
          to: refined.assignment.cliModel,
          tier: refined.routing.minimumTier,
        });
      }
      assignment = refined.assignment;
      routing = refined.routing;
    }
  }

  const { agent, modelLabel, cliModel, effortLabel, cliEffort } = assignment;
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
    routing,
    branch,
    checkoutPath: join(config.worktreeDir, branch),
    planPath: null,
    trigger: "poll",
  });

  logger.info("claimed issue", { runId: run.id, issue: issue.number, agent, cliModel, cliEffort });
  store.setLastInitialCapacityPool(routing.selectedPool);

  // Label after claiming: the state row is the authoritative lock, and a failed label
  // write must not leave us thinking the claim failed.
  if (routing.source === "automatic") {
    for (const label of issue.labels.filter(
      (label) =>
        label.startsWith("agent:") ||
        label.startsWith("model:") ||
        label.startsWith("effort:"),
    )) {
      await github.removeLabel(issue.number, label);
    }
    for (const label of [
      `agent:${agent}`,
      modelLabel,
      effortLabel,
      ...routing.rationaleLabels,
    ]) {
      await github.addLabel(issue.number, label);
    }
  }
  await github.addLabel(issue.number, WORKING_LABEL);
  const terminal = await (deps.launch ?? launchRun)(run, { config, store, logger, notifier, now });
  await finalizeRun(deps, terminal);
  pruneOldRuns(deps);

  return { started: terminal, message: `Ran ${agent} on issue #${issue.number}.` };
}

export async function runBlockedQueueAuditor(
  prompt: string,
  config: BlockedQueueAuditConfig,
): Promise<ModelAuditVerdict> {
  const args =
    config.model.cli === "claude"
      ? [
          "-p",
          "--model",
          config.model.cliModel,
          "--effort",
          config.cliEffort,
          "--output-format",
          "text",
        ]
      : [
          "exec",
          "--model",
          config.model.cliModel,
          "-c",
          `model_reasoning_effort=${config.cliEffort}`,
          "-",
        ];
  const result = await execRun(config.model.cli, args, {
    stdin: prompt,
    timeoutMs: 5 * 60_000,
    killProcessGroup: true,
    maxOutputBytes: 256 * 1024,
  });
  if (!result.ok) {
    return {
      ok: false,
      reason: `${config.model.cli} audit exited ${result.code ?? "unknown"}`,
    };
  }
  return parseModelAuditVerdict(result.stdout);
}

async function recoverBlockedQueueIfIdle(
  deps: DispatcherDeps,
  issues: GithubIssue[],
  claimedByIssue: Map<number, string>,
): Promise<{ attempted: boolean; message: string }> {
  const auditConfig = resolveBlockedQueueAuditConfig(
    deps.config.blockedQueueAuditModel,
    deps.config.blockedQueueAuditEffortLabel,
    deps.config.blockedQueueAuditMaxCandidates,
  );
  if (!auditConfig.ok) {
    deps.logger.warn("blocked queue audit disabled by invalid configuration", {
      reason: auditConfig.reason,
    });
    return { attempted: false, message: "No eligible issues." };
  }

  const candidates = selectBlockedQueueAuditCandidates(issues, {
    claimedByIssue,
    authorAuth: deps.config.authorAuth,
    maxCandidates: auditConfig.value.maxCandidates,
  });
  if (candidates.length === 0) return { attempted: false, message: "No eligible issues." };

  for (const candidate of candidates) {
    const body = await deps.github.issueBody(candidate.issue.number);
    if (body === null) {
      deps.logger.warn("blocked queue audit kept issue blocked because body could not be read", {
        issue: candidate.issue.number,
      });
      continue;
    }
    const dependencyNumbers = referencedIssueNumbers(body, candidate.issue.number);
    const dependencies: DependencyEvidence[] = [];
    for (const dependency of dependencyNumbers) {
      const state = await deps.github.issueState(dependency);
      dependencies.push({
        issueNumber: dependency,
        state: state === "OPEN" || state === "CLOSED" ? state : "UNKNOWN",
      });
    }

    const prompt = blockedQueueAuditPrompt({
      issue: candidate.issue,
      body,
      dependencies,
    });
    const verdict = await (deps.blockedQueueAuditor ?? runBlockedQueueAuditor)(
      prompt,
      auditConfig.value,
    );
    const decision = decideBlockedQueueAudit(dependencies, verdict);
    if (decision.action !== "unblock") {
      deps.logger.info("blocked queue audit kept issue blocked", {
        issue: candidate.issue.number,
        reason: decision.reason,
        dependencies: decision.dependencies,
      });
      continue;
    }

    const dependencySummary = decision.dependencies
      .map((dep) => `#${dep.issueNumber}:${dep.state}`)
      .join(", ");
    if (deps.config.dryRun) {
      deps.logger.info("blocked queue audit would remove stale blocked label", {
        issue: candidate.issue.number,
        rationale: decision.rationale,
        dependencies: dependencySummary,
        model: auditConfig.value.model.cliModel,
        effort: auditConfig.value.cliEffort,
      });
      return {
        attempted: true,
        message: `[dry-run] would remove ${BLOCKED_LABEL} from issue #${candidate.issue.number}.`,
      };
    }

    const removed = await deps.github.removeLabel(candidate.issue.number, BLOCKED_LABEL);
    if (!removed) {
      deps.logger.warn("blocked queue audit could not remove blocked label", {
        issue: candidate.issue.number,
        rationale: decision.rationale,
      });
      return {
        attempted: true,
        message: `Blocked queue audit could not update issue #${candidate.issue.number}.`,
      };
    }
    await deps.github.comment(
      candidate.issue.number,
      [
        "🤖 **Blocked queue audit**",
        "",
        "The dispatcher removed `blocked` after a conservative stale-hold audit.",
        `Rationale: ${decision.rationale}`,
        dependencySummary ? `Dependencies: ${dependencySummary}` : null,
        `Audit model: \`${auditConfig.value.model.cliModel}\`, effort \`${auditConfig.value.cliEffort}\``,
        "",
        "The issue is not claimed by this audit; it will re-enter normal routing on a later scan.",
      ].filter((line): line is string => line !== null).join("\n"),
    );
    deps.logger.info("blocked queue audit removed stale blocked label", {
      issue: candidate.issue.number,
      rationale: decision.rationale,
      dependencies: dependencySummary,
      model: auditConfig.value.model.cliModel,
      effort: auditConfig.value.cliEffort,
    });
    return {
      attempted: true,
      message: `Removed stale ${BLOCKED_LABEL} label from issue #${candidate.issue.number}.`,
    };
  }

  return { attempted: true, message: "No eligible issues; blocked queue audit found no stale holds." };
}

/** Re-enters the SAME run record in resume mode; the branch, checkout, and plan carry over. */
export async function resumeRun(deps: DispatcherDeps, run: RunRecord): Promise<RunRecord> {
  const { config, store, github, logger, notifier } = deps;
  const now = deps.now ?? (() => Date.now());

  // Output is diagnostic evidence, not a safe budget reset: provider startup banners
  // and repeated tool chatter let a wedged process emit one line per launch forever.
  // Checkout artifacts remain preserved, but every relaunch consumes this rung's budget.
  const madeProgress = run.outputSeq > run.lastProgressSeq;

  const reentered = store.updateRun(run.id, {
    status: "claimed",
    phase: "recovering",
    trigger: "resume",
    resumeCount: nextResumeCount(run),
    attemptNumber: run.attemptNumber + 1,
    lastProgressSeq: run.outputSeq,
    exitCode: null,
    failureSummary: null,
    finishedAt: null,
    startedAt: now(),
    finalizationPending: false,
  });

  logger.info("resuming run", {
    runId: run.id,
    issue: run.issueNumber,
    resumeCount: reentered.resumeCount,
    madeProgress,
  });

  await github.addLabel(run.issueNumber, WORKING_LABEL);

  const terminal = await (deps.launch ?? launchRun)(reentered, { config, store, logger, notifier, now });
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
    phase: "recovering",
    trigger: "resume",
    ...assignedIdentity(run),
    recovery: updateRecovery(run.recovery, kind, { attempts: attempt }),
    ...nextRecoveryLaunch(run),
    exitCode: null,
    failureSummary: reason,
    finishedAt: null,
    startedAt: now(),
    finalizationPending: false,
  });

  logger.info("self-heal: relaunching agent to repair delivery failure", {
    runId: run.id,
    issue: run.issueNumber,
    kind,
    attempt,
  });

  await github.addLabel(run.issueNumber, WORKING_LABEL);

  const terminal = await (deps.launch ?? launchRun)(reentered, { config, store, logger, notifier, now });
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
/**
 * Which failure the recovery ledger is actually escalating, so the plan can pick a
 * proportionate response instead of treating every red phase as "needs a bigger brain".
 *
 * `agent` exhaustion is the only kind that genuinely indicates the model could not do the
 * work. CI, merge, and deploy failures are *test* failures in the taxonomy's sense: the
 * change exists and something objective rejected it, which one capability tier up is the
 * right answer to — not a jump to the most expensive model available.
 */
function failureCategoryFor(kind: RecoveryKind): FailureCategory {
  return kind === "agent" ? "implementation-failure" : "test-failure";
}

/**
 * Chooses the escalation model from evidence rather than a fixed constant (#51 §5).
 *
 * `DISPATCHER_CI_ESCALATION_MODEL` remains the floor: if planning cannot produce a
 * candidate — no capacity at the next rung, an unrecognised model, a legacy run with no
 * durable route evidence — the configured model is still used, so this can only ever
 * improve on the previous fixed behaviour, never strand a run.
 *
 * Escalation walks the *route* ladder recorded at pickup, so a frontier model borrowed to
 * repair one phase does not turn the next phase's ordinary repairs into frontier attempts.
 */
async function resolveEscalationModel(
  deps: DispatcherDeps,
  run: RunRecord,
  kind: RecoveryKind,
  fallbackCliModel: string,
  nowMs: number,
): Promise<{ cliModel: string; effortLabel: string; rationale: string }> {
  // The historical behaviour: the configured model at maximum persistence.
  const fallback = {
    cliModel: fallbackCliModel,
    effortLabel: "effort:max",
    rationale: "configured escalation model",
  };
  const currentModel = modelByCliModel(run.cliModel);
  if (!currentModel) return fallback;

  const routeTier = run.routing?.minimumTier ?? currentModel.tier;
  const capacityByPool = await pickupCapacity(deps, nowMs);
  const plan = planNextAttempt(
    failureCategoryFor(kind),
    currentModel,
    capacityByPool,
    dispatchableModels(),
    { routeTier },
  );
  if (!plan.model) return fallback;

  // Effort follows the route the plan escalated to, not a blanket maximum. Spending xhigh
  // on a `capable` repair burns headroom the run may still need for a later phase.
  const escalatedTier =
    plan.action === "escalate-tier" || plan.action === "escalate-frontier"
      ? MODEL_TIERS[Math.min(tierRank(routeTier) + 1, tierRank("frontier"))]!
      : routeTier;
  return {
    cliModel: plan.model.cliModel,
    effortLabel: effortForRouteTier(escalatedTier).effortLabel,
    rationale: plan.rationale,
  };
}

async function escalateRun(
  deps: DispatcherDeps,
  run: RunRecord,
  fallbackCliModel: string,
  kind: RecoveryKind,
  reason: string,
): Promise<void> {
  const { config, store, github, logger, notifier } = deps;
  const now = deps.now ?? (() => Date.now());

  const escalation = await resolveEscalationModel(deps, run, kind, fallbackCliModel, now());
  const cliModel = escalation.cliModel;
  const modelEntry = modelByCliModel(cliModel);
  const agent: DispatcherAgent = modelEntry?.cli === "codex" ? "codex" : "claude";
  const modelLabel = modelEntry?.modelLabel ?? cliModel;
  const cliEffort = EFFORT_LABELS[escalation.effortLabel]?.[agent] ?? (agent === "claude" ? "xhigh" : "high");

  const reentered = store.updateRun(run.id, {
    status: "claimed",
    phase: "recovering",
    trigger: "resume",
    agent,
    modelLabel,
    cliModel,
    effortLabel: escalation.effortLabel,
    cliEffort,
    recovery: updateRecovery(run.recovery, kind, { escalated: true }),
    ...nextRecoveryLaunch(run),
    exitCode: null,
    failureSummary: reason,
    finishedAt: null,
    startedAt: now(),
    finalizationPending: false,
  });

  logger.info(`self-heal: escalating ${kind} to a stronger model`, {
    runId: run.id,
    issue: run.issueNumber,
    agent,
    cliModel,
    effort: escalation.effortLabel,
    rationale: escalation.rationale,
  });

  await github.addLabel(run.issueNumber, WORKING_LABEL);

  const terminal = await (deps.launch ?? launchRun)(reentered, { config, store, logger, notifier, now });
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
  const exhaustedAt = (deps.now ?? (() => Date.now()))();
  let finalRun = recordRunPhase(deps, run, "held", `${kind} recovery exhausted.`, {
    status: "held",
    failureSummary: `${kind} recovery exhausted: ${reason}`,
    exhaustion: {
      kind,
      reason,
      at: exhaustedAt,
      labelApplied: false,
    },
    finishedAt: exhaustedAt,
    finalizationPending: false,
  });
  const labelApplied = await deps.github.addLabel(run.issueNumber, AUTOSHIP_HELD_LABEL);
  if (labelApplied) {
    finalRun = deps.store.updateRun(run.id, {
      exhaustion: { ...finalRun.exhaustion!, labelApplied: true },
    });
  }
  await deps.github.removeLabel(run.issueNumber, WORKING_LABEL);
  await postCostSummary(deps, run.issueNumber);
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

  if (run.status === "abandoned") {
    await github.removeLabel(run.issueNumber, WORKING_LABEL);
    store.updateRun(run.id, { phase: phaseForStatus("abandoned"), finalizationPending: false });
    return;
  }

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

  store.updateRun(run.id, { finalizationPending: false });

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
    if ((run.exitCode === 0 || run.status === "pr_ready") && run.prNumber !== null) {
      recordRunPhase(deps, run, "autoshipping", "Evaluating autoship readiness.");
    }
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
        beforeShip: ({ pr, mergedSha }) => {
          recordRunPhase(deps, run, "deploying", "Autoship deployment started.", {
            status: "ci_pending",
            failureSummary:
              `Deployment started for PR #${pr}` +
              (mergedSha ? ` at merged SHA ${mergedSha}` : "") +
              "; awaiting verified production health.",
          });
        },
      },
      run,
    );
    logger.info("autoship outcome", { runId: run.id, issue: run.issueNumber, action: outcome.action });

    switch (outcome.action) {
      case "shipped":
        recordRunPhase(deps, run, "verifying", "Autoship verified production health.", {
          status: "shipped",
        });
        try {
          deps.telemetry?.setIssueOutcome(run.issueNumber, {
            prStatus: "merged",
            ciStatus: "pass",
            mergeStatus: "merged",
            productionStatus: "deployed",
            finalCompletingModel: run.cliModel,
          });
          await postCostSummary(deps, run.issueNumber);
        } catch (err) {
          // Evidence must never turn a verified production success into a deploy repair.
          logger.warn("telemetry outcome update failed", {
            runId: run.id,
            issue: run.issueNumber,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return { relaunched: false };
      case "deploy_pending":
        // Self-deployment restarts this service from a detached systemd unit. Persist a
        // parked claim before that restart can kill us; the new process rechecks the
        // already-merged SHA and closes only after the detached verifier records health.
        recordRunPhase(deps, run, "verifying", "Detached deployment verification is pending.", {
          status: "ci_pending",
        });
        return { relaunched: false };
      case "ci_not_green":
        if (outcome.state === "pending" || outcome.state === "unknown") {
          // Only touch the record on the TRANSITION into parked -- a recheck that finds
          // it still pending must stay silent and cheap, not re-write every ~15 minutes
          // while nothing has actually changed.
          if (run.status !== "ci_pending") {
            recordRunPhase(deps, run, "waiting_ci", "Waiting for PR checks to resolve.", {
              status: "ci_pending",
            });
          }
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
        checkpointLadderRun(store, run);
        await repairRun(deps, run, outcome.kind, outcome.attempt, outcome.reason);
        return { relaunched: true };
      case "escalate":
        checkpointLadderRun(store, run);
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
  recordRunPhase(deps, run, "waiting_ci", "Rechecking parked PR checks.");
  await evaluateAutoship(deps, run);
}

/** Re-enters autoship for a durable `pr_ready` claim without relaunching its provider. */
export async function recheckReadyRun(deps: DispatcherDeps, run: RunRecord): Promise<void> {
  deps.logger.info("ready PR retained by autoship — resuming delivery", {
    runId: run.id,
    issue: run.issueNumber,
    pr: run.prNumber ?? undefined,
  });
  recordRunPhase(deps, run, "autoshipping", "Resuming autoship for ready PR.");
  await evaluateAutoship(deps, run);
}

/**
 * Rechecks a HELD run. Current-version holds carry durable proof that assigned-model repairs
 * and frontier escalation were exhausted; those wait for the operator to remove
 * `autoship-held`. Legacy holds have no such proof, so the dispatcher clears their label and
 * resumes them automatically instead of preserving obsolete manual gates forever. A held run
 * keeps its issue claim (HELD_STATUSES ⊂ CLAIMING_STATUSES), so it is never re-dispatched from
 * scratch while it waits. A premature closed issue is reopened because closure without
 * verified production is not terminal. An un-held issue resumes through the exact same
 * `evaluateAutoship` pipeline a fresh or parked run goes through — merge + deploy the PR that
 * is already there — rather than relaunching the agent to redo work that is already done
 * (issue #10). Like `recheckParkedRun`, it deliberately does NOT go through `finalizeRun`:
 * there is no new agent run to record telemetry for, and `evaluateAutoship` owns its own
 * comment/notify for every outcome. Returns whether it actually resumed, so the scan loop
 * knows whether this counts as the scan's action.
 */
export async function recheckHeldRun(deps: DispatcherDeps, run: RunRecord): Promise<{ rechecked: boolean }> {
  // Issue closure is an effect of verified shipping, not an alternate success signal.
  // Auto-close keywords and agent mistakes can close immediately on merge, while
  // production is still old or broken. Reopen and retain the claim until autoship proves
  // delivery. UNKNOWN fails closed and simply retries the read later.
  const issueState = await deps.github.issueState(run.issueNumber);
  if (issueState === "CLOSED") {
    const reopened = await deps.github.reopenIssue(run.issueNumber);
    if (!reopened) return { rechecked: false };
    deps.logger.warn("reopened issue that closed before verified production", {
      runId: run.id,
      issue: run.issueNumber,
      pr: run.prNumber ?? undefined,
    });
  }
  if (issueState !== "OPEN" && issueState !== "CLOSED") {
    return { rechecked: false };
  }

  const labels = await deps.github.issueLabels(run.issueNumber);
  if (labels === null) {
    // A read failure is not evidence that the operator removed the hold.
    return { rechecked: false };
  }
  if (run.exhaustion?.labelApplied === false) {
    const applied = await deps.github.addLabel(run.issueNumber, AUTOSHIP_HELD_LABEL);
    if (applied) {
      deps.store.updateRun(run.id, {
        exhaustion: { ...run.exhaustion, labelApplied: true },
        phase: "held",
      });
    }
    return { rechecked: false };
  }
  if (labels.includes(AUTOSHIP_HELD_LABEL) && run.exhaustion) {
    // A current-version hold carries durable proof that the full ladder was spent.
    return { rechecked: false };
  }
  if (labels.includes(AUTOSHIP_HELD_LABEL)) {
    // Old versions created holds for data-loss heuristics, merge conflicts, and first
    // deploy failures. They have no exhaustion proof and must not survive the policy
    // migration as permanent operator work.
    await deps.github.removeLabel(run.issueNumber, AUTOSHIP_HELD_LABEL);
    deps.logger.warn("cleared legacy hold without frontier-exhaustion proof", {
      runId: run.id,
      issue: run.issueNumber,
      pr: run.prNumber ?? undefined,
    });
  }
  deps.logger.info("held PR un-held — resuming autoship without relaunching the agent", {
    runId: run.id,
    issue: run.issueNumber,
    pr: run.prNumber ?? undefined,
  });
  // A frontier-exhausted run normally has a non-zero agent exit and therefore is not
  // eligible for autoship's ordinary PR-ready candidacy check. Removing the durable
  // hold is the explicit authorization to resume the existing PR, not to rerun the
  // failed agent; re-enter the delivery path with the retained artifact evidence.
  const resumed = recordRunPhase(deps, run, "autoshipping", "Resuming autoship for the un-held PR.", {
    status: "pr_ready",
    finalizationPending: false,
  });
  await evaluateAutoship(deps, resumed);
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
/**
 * Economic evidence for one attempt (#51 §7).
 *
 * The three measures stay strictly separate and each carries its provenance. Nothing here
 * is inferred: `billedCost` is null because no provider reports a billed amount to this
 * service, and the list-price equivalent is `unavailable` because trusted token counts do
 * not exist — not because they are zero.
 */
function attemptCostEvidence(model: ModelEntry | null, startedAt: number): AttemptCostEvidence {
  return {
    priceSnapshot: model ? effectiveModelPrice(model, new Date(startedAt)) : null,
    billedCost: null,
    listPriceEquivalent: { amountUsd: null, source: "unavailable", confidence: "unavailable" },
    subscriptionConsumption: null,
    toolCharges: [],
  };
}

export function attemptRecordFromRun(run: RunRecord, _nowMs: number): AttemptRecord {
  const model = modelByCliModel(run.cliModel);
  const selectedCapacity = run.routing?.capacity.find(
    (assessment) => assessment.pool === run.routing?.selectedPool,
  );
  const activeDurationMs =
    run.finishedAt !== null ? Math.max(0, run.finishedAt - run.startedAt) : null;
  return {
    issueNumber: run.issueNumber,
    attemptId: `${run.id}#${run.attemptNumber}`,
    provider: model?.provider ?? run.agent,
    modelRequested: run.cliModel,
    modelUsed: null,
    selectedModelLabel: run.modelLabel,
    issueCharacteristicLabels: run.routing?.characteristicLabels ?? [],
    routingRationaleLabels: run.routing?.rationaleLabels ?? [],
    routingConfidence: run.routing?.confidence ?? null,
    capacityStateAtAssignment: selectedCapacity?.state ?? null,
    effortLabel: run.effortLabel,
    ...(run.routing
      ? {
          effortReason: run.routing.effortReason,
          assignmentSource: run.routing.source,
          capacitySelection: run.routing.capacitySelection,
        }
      : {}),
    startedAt: run.startedAt,
    endedAt: run.finishedAt,
    activeDurationMs,
    // The launcher emits no usage counts, so token-derived measures stay `unavailable`
    // rather than being estimated from wall-clock time (#51 §7). The price snapshot is
    // still captured: it is the one economic fact that is knowable at attempt time, and
    // recording it now is what stops a later price change from rewriting history.
    tokens: UNAVAILABLE_TOKENS,
    cost: attemptCostEvidence(model, run.startedAt),
    cliExitCode: run.exitCode,
    retryReason: run.trigger === "resume" ? "resume" : null,
    testsRun: false,
    testsPassed: null,
    prCreated: Boolean(run.prUrl),
    humanInterventionRequired: false,
    frontierModelUsed: model?.frontier ?? false,
    manualOverride: run.routing?.source === "human-override",
    terminalStatus: run.status,
  };
}

/**
 * Builds the issue comment for a finished run. `run.status` here is always the
 * classification from classifyRunOutcome (runner.ts), posted before autoship. `pr_ready`
 * means the agent handed off a green PR; only autoship may later persist `shipped`.
 */
export function buildIssueComment(
  run: RunRecord,
  resumable: boolean,
): string {
  const statusLabel =
    run.status === "pr_ready" ? "PR ready — CI green, handing off to autoship" : run.status.replace("_", " ");
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
    if (run.remotePid !== null) {
      const command = (deps.processCommand ?? processCommand)(run.remotePid);
      if (isOwnedLauncherCommand(command, run)) {
        (deps.terminateOrphan ?? terminateOrphan)(run.remotePid);
        logger.warn("terminated orphaned launcher process tree before resume", {
          runId: run.id,
          issue: run.issueNumber,
          pid: run.remotePid,
        });
      } else {
        logger.warn("refused to signal stale/reused remote pid", {
          runId: run.id,
          issue: run.issueNumber,
          pid: run.remotePid,
        });
      }
    }
    store.updateRun(run.id, {
      status: "interrupted",
      phase: phaseForStatus("interrupted"),
      exitCode: null,
      failureSummary:
        "The dispatcher restarted while this run was in flight. Its branch and checkout are preserved — it will resume on the next scan.",
      finishedAt: now(),
      remotePid: null,
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
