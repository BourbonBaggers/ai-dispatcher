/**
 * Telemetry data model + durable store (#319).
 *
 * The PRD's real goal is "a trustworthy evidence loop": capture attempt-level and
 * issue-level records with enough structure to compare routing decisions later, and be
 * *honest* about what is measured. Two honesty rules are load-bearing:
 *
 *   1. Token counts carry an explicit source — `reported | estimated | unavailable`. The
 *      current launcher control protocol does not emit token counts, so real attempts
 *      record `unavailable` rather than a fabricated number. A future launcher that emits
 *      usage can set `reported` without any schema change.
 *   2. Success is not a clean CLI exit or a PR. An issue succeeds only when it is merged
 *      AND reaches production AND needs no material human repair (PRD "Definition of
 *      success"). Autoship can observe and verify delivery, but attempt records and
 *      lifecycle overlays remain separate; absent overlay facts stay conservative.
 *
 * The aggregation is pure and unit-tested directly; the store mirrors `state.ts` — an
 * atomic JSON file (temp-file + rename), zero runtime dependencies.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { RoutingConfidence } from "./routing.ts";
import type { CapacityState } from "./capacity.ts";

// ── Token usage (honest about provenance) ────────────────────────────────────────

export const TOKEN_SOURCE = ["reported", "estimated", "unavailable"] as const;
export type TokenSource = (typeof TOKEN_SOURCE)[number];

export interface TokenUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  source: TokenSource;
}

/** The honest default when the launcher emits no usage: zeros are wrong, so counts are null. */
export const UNAVAILABLE_TOKENS: TokenUsage = {
  inputTokens: null,
  outputTokens: null,
  cachedTokens: null,
  source: "unavailable",
};

// ── Attempt-level record ─────────────────────────────────────────────────────────

export interface AttemptRecord {
  issueNumber: number;
  attemptId: string;
  provider: string;
  /** Explicit model identifier requested (from the label). */
  modelRequested: string;
  /** Model actually used, if the CLI made it detectable; else null. */
  modelUsed: string | null;
  selectedModelLabel: string;
  issueCharacteristicLabels: string[];
  routingRationaleLabels: string[];
  routingConfidence: RoutingConfidence | null;
  capacityStateAtAssignment: CapacityState | null;
  startedAt: number;
  endedAt: number | null;
  activeDurationMs: number | null;
  tokens: TokenUsage;
  cliExitCode: number | null;
  /** Retry / handoff reason that led to this attempt, or null for the first attempt. */
  retryReason: string | null;
  testsRun: boolean;
  testsPassed: boolean | null;
  prCreated: boolean;
  humanInterventionRequired: boolean;
  frontierModelUsed: boolean;
  manualOverride: boolean;
  /** Dispatcher terminal status (pr_ready/shipped/ci_pending/ci_failed/held/failed/timed_out/interrupted/token_exhausted). */
  terminalStatus: string;
}

// ── Issue-level record ───────────────────────────────────────────────────────────

export const PR_STATUS = ["none", "draft", "open", "merged", "closed"] as const;
export type PrStatus = (typeof PR_STATUS)[number];

export const CI_STATUS = ["unknown", "pending", "pass", "fail"] as const;
export type CiStatus = (typeof CI_STATUS)[number];

export const MERGE_STATUS = ["unmerged", "merged"] as const;
export type MergeStatus = (typeof MERGE_STATUS)[number];

export const PRODUCTION_STATUS = ["unknown", "deployed", "failed"] as const;
export type ProductionStatus = (typeof PRODUCTION_STATUS)[number];

export interface TokenTotals {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  /** Least-reliable source among the folded attempts — the total is only as good as its worst input. */
  source: TokenSource;
}

/**
 * Lifecycle facts an attempt cannot know (merge, production, regressions). Recorded
 * externally as they become known; every field is optional and defaults conservatively.
 */
export interface IssueOutcomeOverlay {
  prStatus?: PrStatus;
  ciStatus?: CiStatus;
  mergeStatus?: MergeStatus;
  productionStatus?: ProductionStatus;
  regressionDetected?: boolean;
  humanRepairRequired?: boolean;
  estimatedApiValueUsd?: number | null;
}

export interface IssueRecord {
  issueNumber: number;
  originalModel: string | null;
  attemptedModels: string[];
  totalAttempts: number;
  totalActiveDurationMs: number;
  tokensByModel: Record<string, TokenTotals>;
  tokensByProvider: Record<string, TokenTotals>;
  estimatedApiValueUsd: number | null;
  finalCompletingModel: string | null;
  prStatus: PrStatus;
  ciStatus: CiStatus;
  mergeStatus: MergeStatus;
  productionStatus: ProductionStatus;
  regressionDetected: boolean;
  humanRepairRequired: boolean;
  manualOverrideInvolved: boolean;
  success: boolean;
  lastUpdatedAt: number;
}

// ── Pure aggregation ─────────────────────────────────────────────────────────────

/** Reliability order: a total folding any `unavailable` input is itself `unavailable`. */
const SOURCE_RELIABILITY: Record<TokenSource, number> = { reported: 0, estimated: 1, unavailable: 2 };

function leastReliable(a: TokenSource, b: TokenSource): TokenSource {
  return SOURCE_RELIABILITY[a] >= SOURCE_RELIABILITY[b] ? a : b;
}

function foldTokens(into: TokenTotals | undefined, usage: TokenUsage): TokenTotals {
  const base: TokenTotals = into ?? { inputTokens: 0, outputTokens: 0, cachedTokens: 0, source: "reported" };
  return {
    inputTokens: base.inputTokens + (usage.inputTokens ?? 0),
    outputTokens: base.outputTokens + (usage.outputTokens ?? 0),
    cachedTokens: base.cachedTokens + (usage.cachedTokens ?? 0),
    source: leastReliable(base.source, usage.source),
  };
}

/**
 * Folds every attempt for one issue into an issue-level record, overlaid with any known
 * lifecycle facts. `success` follows the PRD definition: merged AND deployed AND no
 * regression AND no material human repair — a clean exit or a PR alone is never success.
 */
export function aggregateIssue(
  issueNumber: number,
  attempts: AttemptRecord[],
  overlay: IssueOutcomeOverlay = {},
  nowMs = 0,
): IssueRecord {
  const mine = attempts
    .filter((a) => a.issueNumber === issueNumber)
    .sort((a, b) => a.startedAt - b.startedAt);

  const attemptedModels: string[] = [];
  const tokensByModel: Record<string, TokenTotals> = {};
  const tokensByProvider: Record<string, TokenTotals> = {};
  let totalActiveDurationMs = 0;
  let finalCompletingModel: string | null = null;
  let lastPrModel: string | null = null;
  let manualOverrideInvolved = false;

  for (const a of mine) {
    const model = a.modelUsed ?? a.modelRequested;
    if (!attemptedModels.includes(model)) attemptedModels.push(model);
    tokensByModel[model] = foldTokens(tokensByModel[model], a.tokens);
    tokensByProvider[a.provider] = foldTokens(tokensByProvider[a.provider], a.tokens);
    totalActiveDurationMs += a.activeDurationMs ?? 0;
    if (a.manualOverride) manualOverrideInvolved = true;
    if (a.prCreated) lastPrModel = model;
    // The completing model is the last attempt that reached a PR with a clean terminal state.
    if (a.terminalStatus === "shipped" && a.prCreated) finalCompletingModel = model;
  }

  const mergeStatus = overlay.mergeStatus ?? "unmerged";
  const productionStatus = overlay.productionStatus ?? "unknown";
  const regressionDetected = overlay.regressionDetected ?? false;
  const humanRepairRequired = overlay.humanRepairRequired ?? false;

  // PRD "Definition of success": all of these, together.
  const success =
    mergeStatus === "merged" &&
    productionStatus === "deployed" &&
    !regressionDetected &&
    !humanRepairRequired;
  if (success && finalCompletingModel === null) finalCompletingModel = lastPrModel;

  return {
    issueNumber,
    originalModel: mine[0] ? (mine[0].modelUsed ?? mine[0].modelRequested) : null,
    attemptedModels,
    totalAttempts: mine.length,
    totalActiveDurationMs,
    tokensByModel,
    tokensByProvider,
    estimatedApiValueUsd: overlay.estimatedApiValueUsd ?? null,
    finalCompletingModel,
    prStatus: overlay.prStatus ?? (mine.some((a) => a.prCreated) ? "draft" : "none"),
    ciStatus: overlay.ciStatus ?? "unknown",
    mergeStatus,
    productionStatus,
    regressionDetected,
    humanRepairRequired,
    manualOverrideInvolved,
    success,
    lastUpdatedAt: nowMs,
  };
}

/**
 * Learning dataset: issues whose routing was NOT hand-picked by a human. Manual overrides
 * are recorded but must never train the policy (PRD principle §8), so they are excluded
 * here while remaining available for separate analysis.
 */
export function learningDataset(issues: IssueRecord[]): IssueRecord[] {
  return issues.filter((i) => !i.manualOverrideInvolved);
}

/** Attempt-level equivalent: drops manual-override attempts from a learning corpus. */
export function learningAttempts(attempts: AttemptRecord[]): AttemptRecord[] {
  return attempts.filter((a) => !a.manualOverride);
}

// ── Durable store (mirrors state.ts: atomic temp-file + rename, zero deps) ────────

interface PersistedTelemetry {
  version: 1;
  attempts: AttemptRecord[];
  outcomes: Record<string, IssueOutcomeOverlay>;
}

const TELEMETRY_FILE = "telemetry.json";

function emptyTelemetry(): PersistedTelemetry {
  return { version: 1, attempts: [], outcomes: {} };
}

export class TelemetryStore {
  private readonly filePath: string;
  private data: PersistedTelemetry;

  private constructor(filePath: string) {
    this.filePath = filePath;
    this.data = emptyTelemetry();
  }

  /** Opens (or creates) the telemetry file under `dir`. */
  static open(dir: string): TelemetryStore {
    mkdirSync(dir, { recursive: true });
    const store = new TelemetryStore(join(dir, TELEMETRY_FILE));
    store.load();
    return store;
  }

  private load(): void {
    if (!existsSync(this.filePath)) {
      this.persist();
      return;
    }
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as PersistedTelemetry;
      this.data = {
        version: 1,
        attempts: Array.isArray(parsed.attempts) ? parsed.attempts : [],
        outcomes: parsed.outcomes && typeof parsed.outcomes === "object" ? parsed.outcomes : {},
      };
    } catch {
      // A corrupt evidence file must not crash-loop the dispatcher — preserve it for
      // inspection and start clean, exactly as state.ts does.
      renameSync(this.filePath, `${this.filePath}.corrupt-${Date.now()}`);
      this.data = emptyTelemetry();
      this.persist();
    }
  }

  private persist(): void {
    const tmp = `${this.filePath}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), "utf8");
    renameSync(tmp, this.filePath);
  }

  /** Appends an attempt record. */
  recordAttempt(attempt: AttemptRecord): void {
    this.data.attempts.push(attempt);
    this.persist();
  }

  /** Records/merges lifecycle facts for an issue (merge, prod, regression, …). */
  setIssueOutcome(issueNumber: number, overlay: IssueOutcomeOverlay): void {
    const key = String(issueNumber);
    this.data.outcomes[key] = { ...this.data.outcomes[key], ...overlay };
    this.persist();
  }

  allAttempts(): AttemptRecord[] {
    return this.data.attempts.map((a) => ({ ...a }));
  }

  outcomeFor(issueNumber: number): IssueOutcomeOverlay {
    return { ...this.data.outcomes[String(issueNumber)] };
  }

  /** Aggregates every issue seen in the attempts into issue-level records. */
  aggregateAll(nowMs = 0): IssueRecord[] {
    const issueNumbers = [...new Set(this.data.attempts.map((a) => a.issueNumber))].sort((a, b) => a - b);
    return issueNumbers.map((n) =>
      aggregateIssue(n, this.data.attempts, this.data.outcomes[String(n)] ?? {}, nowMs),
    );
  }
}
