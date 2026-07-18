/**
 * Routing analytics report (#319).
 *
 * A pure Markdown builder over the telemetry records — the PRD's "minimal useful
 * analytics view". No dashboard, no dependencies: `ai-dispatcher report` reads the
 * telemetry file and prints this (see `main.ts`).
 *
 * Two honesty rules carry over from telemetry: token totals are reported as `unavailable`
 * when the launcher emitted no counts (never a fabricated 0), and human-override issues
 * are tabulated separately and excluded from the learning-facing rates so manual choices
 * never masquerade as evidence for the rubric (PRD principle §8).
 */

import { modelByCliModel } from "./models.ts";
import type { AttemptRecord, IssueRecord, TokenSource } from "./telemetry.ts";
import { CHARACTERISTIC_LABEL_PREFIXES } from "./routing.ts";

export interface ReportOptions {
  /** Optional header timestamp; omitted keeps the output deterministic for tests. */
  generatedAtIso?: string;
}

/** Task category for an issue, read from its `task:*` characteristic label; else "unclassified". */
function taskCategoryOf(issueNumber: number, attempts: AttemptRecord[]): string {
  const prefix = `${CHARACTERISTIC_LABEL_PREFIXES.taskType}:`;
  for (const a of attempts) {
    if (a.issueNumber !== issueNumber) continue;
    const hit = a.issueCharacteristicLabels.find((l) => l.startsWith(prefix));
    if (hit) return hit.slice(prefix.length);
  }
  return "unclassified";
}

function pct(numerator: number, denominator: number): string {
  if (denominator === 0) return "n/a";
  return `${Math.round((numerator / denominator) * 100)}% (${numerator}/${denominator})`;
}

const SOURCE_RELIABILITY: Record<TokenSource, number> = { reported: 0, estimated: 1, unavailable: 2 };

interface TokenSum {
  input: number;
  output: number;
  cached: number;
  source: TokenSource;
}

/** Folds every provider total across a set of issues into one sum, tracking the worst source. */
function sumTokens(issues: IssueRecord[]): TokenSum {
  const sum: TokenSum = { input: 0, output: 0, cached: 0, source: "reported" };
  let sawAny = false;
  for (const issue of issues) {
    for (const totals of Object.values(issue.tokensByProvider)) {
      sawAny = true;
      sum.input += totals.inputTokens;
      sum.output += totals.outputTokens;
      sum.cached += totals.cachedTokens;
      if (SOURCE_RELIABILITY[totals.source] > SOURCE_RELIABILITY[sum.source]) sum.source = totals.source;
    }
  }
  if (!sawAny) sum.source = "unavailable";
  return sum;
}

function tokenLine(sum: TokenSum): string {
  if (sum.source === "unavailable") {
    return "unavailable — the launcher control protocol emits no token counts";
  }
  const tag = sum.source === "estimated" ? " (estimated)" : "";
  return `${sum.input} in / ${sum.output} out / ${sum.cached} cached${tag}`;
}

function providerOf(cliModel: string | null): string {
  if (!cliModel) return "unknown";
  return modelByCliModel(cliModel)?.provider ?? "unknown";
}

/**
 * Builds the routing report. `attempts` supply per-attempt evidence (task category,
 * retry/handoff, frontier use); `issues` supply the aggregated outcomes.
 */
export function buildRoutingReport(
  attempts: AttemptRecord[],
  issues: IssueRecord[],
  opts: ReportOptions = {},
): string {
  const L: string[] = [];
  const learnable = issues.filter((i) => !i.manualOverrideInvolved);
  const overrides = issues.filter((i) => i.manualOverrideInvolved);
  const successes = learnable.filter((i) => i.success);

  L.push("# AI dispatcher routing report");
  if (opts.generatedAtIso) L.push(`_Generated ${opts.generatedAtIso}_`);
  L.push("");

  // ── Overview ────────────────────────────────────────────────────────────────
  L.push("## Overview");
  L.push("");
  L.push(`- Issues tracked: ${issues.length}`);
  L.push(`- Learnable issues (auto-routed): ${learnable.length}`);
  L.push(`- Human-override issues (tracked separately, excluded from learning): ${overrides.length}`);
  L.push(`- Production successes (auto-routed): ${successes.length}`);
  L.push("");

  if (issues.length === 0) {
    L.push("_No telemetry recorded yet._");
    return L.join("\n");
  }

  // ── Completed features by provider and model ─────────────────────────────────
  L.push("## Completed production features by provider / model");
  L.push("");
  const byModel = new Map<string, number>();
  for (const s of successes) {
    const model = s.finalCompletingModel ?? "unknown";
    byModel.set(model, (byModel.get(model) ?? 0) + 1);
  }
  if (byModel.size === 0) {
    L.push("_No production successes yet._");
  } else {
    L.push("| Provider | Model | Completed features |");
    L.push("| --- | --- | --- |");
    for (const [model, count] of [...byModel.entries()].sort((a, b) => b[1] - a[1])) {
      L.push(`| ${providerOf(model)} | ${model} | ${count} |`);
    }
  }
  L.push("");

  // ── Success rate by task category ────────────────────────────────────────────
  L.push("## Success rate by task category");
  L.push("");
  const byCategory = new Map<string, { total: number; success: number }>();
  for (const issue of learnable) {
    const cat = taskCategoryOf(issue.issueNumber, attempts);
    const bucket = byCategory.get(cat) ?? { total: 0, success: 0 };
    bucket.total += 1;
    if (issue.success) bucket.success += 1;
    byCategory.set(cat, bucket);
  }
  L.push("| Task category | Success rate |");
  L.push("| --- | --- |");
  for (const [cat, b] of [...byCategory.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    L.push(`| ${cat} | ${pct(b.success, b.total)} |`);
  }
  L.push("");

  // ── Efficiency headline ──────────────────────────────────────────────────────
  const firstAttemptSuccesses = learnable.filter((i) => i.success && i.totalAttempts === 1).length;
  const retriedIssues = learnable.filter((i) => i.totalAttempts > 1).length;
  const activeMs = successes.reduce((acc, i) => acc + i.totalActiveDurationMs, 0);
  const perFeatureMs = successes.length > 0 ? Math.round(activeMs / successes.length) : 0;
  const apiValues = learnable.map((i) => i.estimatedApiValueUsd).filter((v): v is number => v !== null);
  L.push("## Efficiency");
  L.push("");
  L.push(`- First-attempt success rate: ${pct(firstAttemptSuccesses, learnable.length)}`);
  L.push(`- Retry / handoff rate: ${pct(retriedIssues, learnable.length)}`);
  L.push(`- Active time per successful feature: ${successes.length > 0 ? `${Math.round(perFeatureMs / 1000)}s` : "n/a"}`);
  L.push(`- Tokens per successful feature: ${tokenLine(sumTokens(successes))}`);
  L.push(
    `- Estimated API-equivalent value consumed: ${apiValues.length > 0 ? `$${apiValues.reduce((a, b) => a + b, 0).toFixed(2)}` : "not available (no pricing recorded)"}`,
  );
  L.push("");

  // ── Frontier utilization ─────────────────────────────────────────────────────
  const frontierAttempts = attempts.filter((a) => a.frontierModelUsed).length;
  const frontierSuccesses = successes.filter((i) => providerFrontier(i.finalCompletingModel)).length;
  L.push("## Frontier utilization");
  L.push("");
  L.push(`- Attempts on frontier models: ${pct(frontierAttempts, attempts.length)}`);
  L.push(`- Production successes completed by a frontier model: ${frontierSuccesses}`);
  L.push("- Dormant/unused subscription capacity: not measurable from history (no provider quota API).");
  L.push("");

  // ── Confidence vs outcome ────────────────────────────────────────────────────
  L.push("## Routing confidence vs outcome");
  L.push("");
  const byConfidence = new Map<string, { total: number; success: number }>();
  for (const issue of learnable) {
    const conf = firstConfidence(issue.issueNumber, attempts) ?? "unknown";
    const bucket = byConfidence.get(conf) ?? { total: 0, success: 0 };
    bucket.total += 1;
    if (issue.success) bucket.success += 1;
    byConfidence.set(conf, bucket);
  }
  L.push("| Confidence at assignment | Success rate |");
  L.push("| --- | --- |");
  for (const conf of ["high", "medium", "low", "unknown"]) {
    const b = byConfidence.get(conf);
    if (b) L.push(`| ${conf} | ${pct(b.success, b.total)} |`);
  }
  L.push("");

  // ── Human overrides (separate) ───────────────────────────────────────────────
  L.push("## Human overrides (tracked separately, not used for learning)");
  L.push("");
  if (overrides.length === 0) {
    L.push("_None recorded._");
  } else {
    const overrideSuccess = overrides.filter((i) => i.success).length;
    L.push(`- Override issues: ${overrides.length}`);
    L.push(`- Override success rate: ${pct(overrideSuccess, overrides.length)}`);
  }
  L.push("");

  // ── Recommendations ──────────────────────────────────────────────────────────
  L.push("## Routing-policy recommendations");
  L.push("");
  for (const rec of recommendations(byCategory, frontierAttempts, attempts.length, retriedIssues, learnable.length)) {
    L.push(`- ${rec}`);
  }

  return L.join("\n");
}

function providerFrontier(cliModel: string | null): boolean {
  if (!cliModel) return false;
  return modelByCliModel(cliModel)?.frontier ?? false;
}

function firstConfidence(issueNumber: number, attempts: AttemptRecord[]): string | null {
  const first = attempts
    .filter((a) => a.issueNumber === issueNumber)
    .sort((a, b) => a.startedAt - b.startedAt)[0];
  return first?.routingConfidence ?? null;
}

/** Heuristic, clearly-labelled recommendations — advice for a human, not autonomous action. */
function recommendations(
  byCategory: Map<string, { total: number; success: number }>,
  frontierAttempts: number,
  totalAttempts: number,
  retriedIssues: number,
  learnableIssues: number,
): string[] {
  const out: string[] = [];
  const MIN_SAMPLE = 3; // don't recommend from fewer than this many comparable issues

  for (const [cat, b] of byCategory) {
    if (b.total >= MIN_SAMPLE && b.success === b.total) {
      out.push(`Task category "${cat}" succeeds every time (${b.success}/${b.total}) — safe to keep routing it to the current (or a lower) tier.`);
    } else if (b.total >= MIN_SAMPLE && b.success / b.total < 0.5) {
      out.push(`Task category "${cat}" is failing often (${pct(b.success, b.total)}) — review whether its issues need better requirements or a stronger initial tier.`);
    }
  }

  if (totalAttempts >= MIN_SAMPLE && frontierAttempts / totalAttempts > 0.5) {
    out.push(`Frontier models handled ${pct(frontierAttempts, totalAttempts)} of attempts — high frontier usage; any policy change that raises it further needs explicit human approval.`);
  }
  if (learnableIssues >= MIN_SAMPLE && retriedIssues / learnableIssues > 0.5) {
    out.push(`Over half of issues needed a retry/handoff (${pct(retriedIssues, learnableIssues)}) — the initial tier may be set too low for this workload.`);
  }
  if (out.length === 0) {
    out.push("Not enough comparable data yet to recommend routing changes — keep collecting evidence.");
  }
  return out;
}
