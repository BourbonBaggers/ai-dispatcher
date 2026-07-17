/**
 * Per-issue repeated-failure deferral (ported from #249).
 *
 * A terminal `failed` run with no commit or PR increments the issue's consecutive
 * count for the normalized failure signature. On the third matching failure the issue
 * is deferred for 24 hours and one notification is sent. Counters reset when a run
 * succeeds or a failed run made meaningful progress (a commit or PR).
 *
 * Pure functions over a plain record array: the store persists the returned records and
 * the dispatcher fires the returned notification, so nothing here touches IO.
 */

import type { DispatcherAgent } from "./labels.ts";

const FAILURE_DEFERRAL_THRESHOLD = 3;
const ISSUE_FAILURE_DEFERRAL_MS = 86_400_000; // 24 hours
const FAILURE_SIGNATURE_MAX_LENGTH = 500;
const FAILURE_SUMMARY_MAX_LENGTH = 1_000;

/** Persisted per-issue failure record (timestamps are epoch ms for stable JSON). */
export interface IssueFailureRecord {
  issueNumber: number;
  agent: DispatcherAgent;
  failureCategory: string;
  failureSignature: string;
  consecutiveFailures: number;
  lastFailureSummary: string | null;
  firstFailedAt: number;
  lastFailedAt: number;
  nextEligibleAt: number | null;
  notifiedAt: number | null;
  resolvedAt: number | null;
}

/** The subset of a terminal run this policy reads. */
export interface TerminalRunLike {
  issueNumber: number;
  agent: DispatcherAgent;
  status: string;
  exitCode: number | null;
  failureSummary: string | null;
  lastCommit: string | null;
  prUrl: string | null;
}

export interface DeferralNotification {
  title: string;
  body: string;
}

export interface RunOutcomeAccounting {
  /** The complete, updated record set to persist. */
  records: IssueFailureRecord[];
  deferred: boolean;
  summary: string | null;
  /** A notification to fire, or null when this transition should stay silent. */
  notification: DeferralNotification | null;
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function failureSummaryFor(run: TerminalRunLike): string {
  return truncate(
    normalizeText(run.failureSummary ?? `The agent exited with code ${run.exitCode ?? "unknown"}.`),
    FAILURE_SUMMARY_MAX_LENGTH,
  );
}

function failureSignatureFor(run: TerminalRunLike): string {
  const summary = failureSummaryFor(run).toLowerCase();
  return truncate(`exit=${run.exitCode ?? "unknown"}:${summary}`, FAILURE_SIGNATURE_MAX_LENGTH);
}

function runMadeMeaningfulProgress(run: TerminalRunLike): boolean {
  return Boolean(run.lastCommit || run.prUrl);
}

function isBlockingDeferral(record: IssueFailureRecord, nowMs: number): boolean {
  if (record.resolvedAt) return false;
  if (record.consecutiveFailures < FAILURE_DEFERRAL_THRESHOLD) return false;
  return !record.nextEligibleAt || record.nextEligibleAt > nowMs;
}

function formatRetryTime(value: number | null): string {
  return value ? new Date(value).toISOString() : "manual review clears it";
}

export function formatIssueDeferralReason(record: IssueFailureRecord): string {
  return `deferred after ${record.consecutiveFailures} matching failures — retry after ${formatRetryTime(
    record.nextEligibleAt,
  )}`;
}

/**
 * issueNumber → human reason, for every issue currently blocked by an active deferral.
 */
export function getBlockingIssueDeferrals(
  records: IssueFailureRecord[],
  nowMs: number,
): Map<number, string> {
  const map = new Map<number, string>();
  for (const record of records) {
    if (isBlockingDeferral(record, nowMs)) {
      map.set(record.issueNumber, formatIssueDeferralReason(record));
    }
  }
  return map;
}

function withRecord(
  records: IssueFailureRecord[],
  issueNumber: number,
  next: IssueFailureRecord,
): IssueFailureRecord[] {
  const out = records.filter((r) => r.issueNumber !== issueNumber);
  out.push(next);
  return out;
}

function resolveIssue(records: IssueFailureRecord[], issueNumber: number, nowMs: number): IssueFailureRecord[] {
  return records.map((r) =>
    r.issueNumber === issueNumber && r.resolvedAt === null
      ? { ...r, consecutiveFailures: 0, nextEligibleAt: null, notifiedAt: null, resolvedAt: nowMs }
      : r,
  );
}

/**
 * Applies a terminal run's outcome to the failure records. Returns the updated set,
 * whether the issue is now deferred, a human summary, and any notification to fire.
 */
export function recordTerminalRunOutcome(
  records: IssueFailureRecord[],
  run: TerminalRunLike,
  nowMs: number,
): RunOutcomeAccounting {
  if (run.status === "succeeded") {
    return { records: resolveIssue(records, run.issueNumber, nowMs), deferred: false, summary: null, notification: null };
  }
  if (run.status !== "failed") {
    return { records, deferred: false, summary: null, notification: null };
  }
  if (runMadeMeaningfulProgress(run)) {
    return { records: resolveIssue(records, run.issueNumber, nowMs), deferred: false, summary: null, notification: null };
  }

  const failureCategory = "issue-failure";
  const failureSignature = failureSignatureFor(run);
  const lastFailureSummary = failureSummaryFor(run);
  const existing = records.find((r) => r.issueNumber === run.issueNumber);
  const sameFailure =
    existing?.resolvedAt === null &&
    existing.failureCategory === failureCategory &&
    existing.failureSignature === failureSignature;

  const consecutiveFailures = sameFailure ? existing!.consecutiveFailures + 1 : 1;
  const deferred = consecutiveFailures >= FAILURE_DEFERRAL_THRESHOLD;
  const nextEligibleAt = deferred ? nowMs + ISSUE_FAILURE_DEFERRAL_MS : null;
  const wasBlocking = existing ? isBlockingDeferral(existing, nowMs) : false;
  const shouldNotify = deferred && !wasBlocking;
  const firstFailedAt = sameFailure && existing ? existing.firstFailedAt : nowMs;
  const notifiedAt = shouldNotify ? nowMs : sameFailure ? (existing?.notifiedAt ?? null) : null;

  const next: IssueFailureRecord = {
    issueNumber: run.issueNumber,
    agent: run.agent,
    failureCategory,
    failureSignature,
    consecutiveFailures,
    lastFailureSummary,
    firstFailedAt,
    lastFailedAt: nowMs,
    nextEligibleAt,
    notifiedAt,
    resolvedAt: null,
  };

  const updated = withRecord(records, run.issueNumber, next);

  if (!deferred) return { records: updated, deferred: false, summary: null, notification: null };

  const summary = `Issue #${run.issueNumber} has failed ${consecutiveFailures} consecutive matching dispatcher attempts. It will be skipped until ${formatRetryTime(
    nextEligibleAt,
  )}. Last failure: ${lastFailureSummary}`;

  const notification = shouldNotify
    ? { title: `Dispatcher: deferred #${run.issueNumber}`, body: summary }
    : null;

  return { records: updated, deferred: true, summary, notification };
}
