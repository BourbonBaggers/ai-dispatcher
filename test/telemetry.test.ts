import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  aggregateIssue,
  learningDataset,
  learningAttempts,
  TelemetryStore,
  UNAVAILABLE_TOKENS,
  type AttemptRecord,
  type TokenUsage,
  renderCostSummary,
} from "../src/telemetry.ts";

const NOW = 1_700_000_000_000;

function attempt(over: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    issueNumber: 1,
    attemptId: "a1",
    provider: "anthropic",
    modelRequested: "claude-sonnet-5",
    modelUsed: null,
    selectedModelLabel: "model:claude-sonnet-5",
    issueCharacteristicLabels: [],
    routingRationaleLabels: [],
    routingConfidence: "high",
    capacityStateAtAssignment: "unknown",
    startedAt: NOW,
    endedAt: NOW + 1000,
    activeDurationMs: 1000,
    tokens: UNAVAILABLE_TOKENS,
    cliExitCode: 0,
    retryReason: null,
    testsRun: true,
    testsPassed: true,
    prCreated: true,
    humanInterventionRequired: false,
    frontierModelUsed: false,
    manualOverride: false,
    terminalStatus: "shipped",
    ...over,
  };
}

const tokens = (over: Partial<TokenUsage>): TokenUsage => ({ ...UNAVAILABLE_TOKENS, ...over });

test("aggregateIssue folds attempts and stays honest about token provenance", () => {
  const attempts = [
    attempt({ attemptId: "a1", modelUsed: "claude-sonnet-5", tokens: tokens({ inputTokens: 100, outputTokens: 20, source: "reported" }) }),
    attempt({ attemptId: "a2", modelUsed: "claude-sonnet-5", tokens: UNAVAILABLE_TOKENS, activeDurationMs: 500 }),
  ];
  const rec = aggregateIssue(1, attempts);
  assert.equal(rec.totalAttempts, 2);
  assert.equal(rec.totalActiveDurationMs, 1500);
  assert.deepEqual(rec.attemptedModels, ["claude-sonnet-5"]);
  // 100 reported + 0-from-unavailable; source degrades to the least reliable input.
  assert.equal(rec.tokensByModel["claude-sonnet-5"]!.inputTokens, 100);
  assert.equal(rec.tokensByModel["claude-sonnet-5"]!.source, "unavailable");
  assert.equal(rec.tokensByProvider["anthropic"]!.outputTokens, 20);
});

test("aggregateIssue separates list-price equivalent from unavailable billed cost", () => {
  const rec = aggregateIssue(1, [
    attempt({
      attemptId: "cost-1",
      selectedModelLabel: "model:gpt-5.4-mini",
      modelRequested: "gpt-5.4-mini",
      provider: "openai",
      tokens: tokens({
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cachedTokens: 0,
        source: "reported",
      }),
    }),
    attempt({
      attemptId: "cost-2",
      selectedModelLabel: "model:claude-opus-4.8",
      modelRequested: "claude-opus-4-8",
      frontierModelUsed: true,
      tokens: UNAVAILABLE_TOKENS,
    }),
  ]);
  assert.equal(rec.costTotals?.listPriceEquivalentUsd, null);
  assert.ok(rec.costTotals?.unavailableMeasures.includes("billed cost"));
  assert.ok(rec.costTotals?.unavailableMeasures.includes("list-price equivalent"));
  assert.deepEqual(rec.costTotals?.billed, {});
});

test("aggregateIssue: a PR alone is not success — merge + prod are required", () => {
  const attempts = [attempt({ terminalStatus: "pr_ready", prCreated: true })];
  // Ready/open PR only: not success.
  assert.equal(aggregateIssue(1, attempts).success, false);
  assert.equal(aggregateIssue(1, attempts).prStatus, "open");
  // Merged + deployed, no repair/regression: success.
  const done = aggregateIssue(1, attempts, {
    prStatus: "merged",
    mergeStatus: "merged",
    productionStatus: "deployed",
  });
  assert.equal(done.success, true);
  assert.equal(done.finalCompletingModel, "claude-sonnet-5");
  const frontierCompleted = aggregateIssue(1, attempts, {
    prStatus: "merged",
    mergeStatus: "merged",
    productionStatus: "deployed",
    finalCompletingModel: "claude-opus-4-8",
  });
  assert.equal(frontierCompleted.finalCompletingModel, "claude-opus-4-8");
  // Merged + deployed but a human had to repair it: NOT success.
  const repaired = aggregateIssue(1, attempts, {
    mergeStatus: "merged",
    productionStatus: "deployed",
    humanRepairRequired: true,
  });
  assert.equal(repaired.success, false);
});

test("aggregateIssue tracks multiple attempted models and the original", () => {
  const attempts = [
    attempt({ attemptId: "a1", startedAt: NOW, modelUsed: "claude-sonnet-5", terminalStatus: "failed", prCreated: false }),
    attempt({ attemptId: "a2", startedAt: NOW + 10, modelUsed: "gpt-5.5", provider: "openai", terminalStatus: "shipped", prCreated: true }),
  ];
  const rec = aggregateIssue(1, attempts);
  assert.equal(rec.originalModel, "claude-sonnet-5");
  assert.deepEqual(rec.attemptedModels, ["claude-sonnet-5", "gpt-5.5"]);
  assert.equal(rec.finalCompletingModel, "gpt-5.5");
});

test("learning datasets exclude manual overrides", () => {
  const overrideIssue = aggregateIssue(2, [attempt({ issueNumber: 2, manualOverride: true })]);
  const autoIssue = aggregateIssue(1, [attempt({ issueNumber: 1 })]);
  assert.equal(overrideIssue.manualOverrideInvolved, true);
  const learn = learningDataset([overrideIssue, autoIssue]);
  assert.deepEqual(learn.map((i) => i.issueNumber), [1]);

  const attempts = [attempt({ manualOverride: true }), attempt({ attemptId: "a2", manualOverride: false })];
  assert.equal(learningAttempts(attempts).length, 1);
});

test("TelemetryStore round-trips attempts and outcomes atomically", () => {
  const dir = mkdtempSync(join(tmpdir(), "telem-"));
  try {
    const store = TelemetryStore.open(dir);
    store.recordAttempt(attempt({ issueNumber: 5, attemptId: "x1", modelUsed: "gpt-5.5", provider: "openai" }));
    store.setIssueOutcome(5, { mergeStatus: "merged", productionStatus: "deployed" });

    // Reopen from disk — persistence survives.
    const reopened = TelemetryStore.open(dir);
    assert.equal(reopened.allAttempts().length, 1);
    assert.deepEqual(reopened.outcomeFor(5), { mergeStatus: "merged", productionStatus: "deployed" });
    const issues = reopened.aggregateAll(NOW);
    assert.equal(issues.length, 1);
    assert.equal(issues[0]!.issueNumber, 5);
    assert.equal(issues[0]!.success, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TelemetryStore idempotently ignores replayed finalization attempts", () => {
  const dir = mkdtempSync(join(tmpdir(), "telem-replay-"));
  try {
    const store = TelemetryStore.open(dir);
    const terminal = attempt({ issueNumber: 9, attemptId: "run#0@123" });
    store.recordAttempt(terminal);
    store.recordAttempt(terminal);
    assert.equal(store.allAttempts().length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Cost summary (#51 §7) ────────────────────────────────────────────────────────
//
// The three economic measures stay strictly separate and every one carries its
// provenance. A reader must be able to tell "this cost nothing" from "nobody reported
// what this cost" — reporting an unavailable measure as zero is the failure mode.

test("the cost summary names unavailable measures instead of showing zero", () => {
  const record = aggregateIssue(1, [attempt({ terminalStatus: "failed" })], {}, 0);
  const summary = renderCostSummary(record);
  assert.match(summary, /Billed cost: unavailable/);
  assert.match(summary, /List-price equivalent: unavailable/);
  assert.doesNotMatch(summary, /\$0\.0000/);
});

test("the summary explains that missing usage is not estimated from elapsed time", () => {
  const record = aggregateIssue(1, [attempt({ terminalStatus: "failed" })], {}, 0);
  assert.match(renderCostSummary(record), /not estimated from elapsed time/);
});

test("aggregation counts every attempt, including the failed ones before success", () => {
  const attempts = [
    attempt({ attemptId: "a#1", terminalStatus: "failed" }),
    attempt({ attemptId: "a#2", terminalStatus: "ci_failed" }),
    attempt({ attemptId: "a#3", terminalStatus: "shipped" }),
  ];
  const record = aggregateIssue(1, attempts, {}, 0);
  assert.equal(record.totalAttempts, 3);
  assert.equal(record.costTotals?.failedAttempts, 2);
  assert.match(renderCostSummary(record), /Attempts: 3 \(2 failed\)/);
});

test("a billed amount is only ever reported when a provider actually reported one", () => {
  const withBilling = attempt({
    attemptId: "a#1",
    terminalStatus: "shipped",
    cost: {
      priceSnapshot: null,
      billedCost: { amount: 1.25, currency: "USD", source: "provider-reported", confidence: "reported" },
      listPriceEquivalent: { amountUsd: null, source: "unavailable", confidence: "unavailable" },
      subscriptionConsumption: null,
      toolCharges: [],
    },
  });
  const record = aggregateIssue(1, [withBilling], {}, 0);
  assert.equal(record.costTotals?.billed["USD"], 1.25);
  assert.match(renderCostSummary(record), /Billed cost: 1\.2500 USD \(provider-reported\)/);
});
