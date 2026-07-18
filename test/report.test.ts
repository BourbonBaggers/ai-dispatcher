import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRoutingReport } from "../src/report.ts";
import {
  aggregateIssue,
  UNAVAILABLE_TOKENS,
  type AttemptRecord,
  type IssueRecord,
} from "../src/telemetry.ts";

const NOW = 1_700_000_000_000;

function attempt(over: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    issueNumber: 1,
    attemptId: "a1",
    provider: "anthropic",
    modelRequested: "claude-sonnet-5",
    modelUsed: "claude-sonnet-5",
    selectedModelLabel: "model:claude-sonnet-5",
    issueCharacteristicLabels: ["task:feature"],
    routingRationaleLabels: [],
    routingConfidence: "high",
    capacityStateAtAssignment: "unknown",
    startedAt: NOW,
    endedAt: NOW + 1000,
    activeDurationMs: 60_000,
    tokens: UNAVAILABLE_TOKENS,
    cliExitCode: 0,
    retryReason: null,
    testsRun: true,
    testsPassed: true,
    prCreated: true,
    humanInterventionRequired: false,
    frontierModelUsed: false,
    manualOverride: false,
    terminalStatus: "succeeded",
    ...over,
  };
}

test("empty telemetry renders a clear no-data report", () => {
  const md = buildRoutingReport([], []);
  assert.match(md, /# AI dispatcher routing report/);
  assert.match(md, /No telemetry recorded yet/);
});

test("report tabulates completed features, honest tokens, and separates overrides", () => {
  const a1 = attempt({ issueNumber: 1, issueCharacteristicLabels: ["task:feature"] });
  const a2 = attempt({
    issueNumber: 2,
    modelRequested: "gpt-5.5",
    modelUsed: "gpt-5.5",
    provider: "openai",
    selectedModelLabel: "model:gpt-5.5",
    issueCharacteristicLabels: ["task:bugfix"],
    manualOverride: true,
  });
  const attempts = [a1, a2];

  const issue1 = aggregateIssue(1, attempts, { mergeStatus: "merged", productionStatus: "deployed" });
  const issue2 = aggregateIssue(2, attempts, { mergeStatus: "merged", productionStatus: "deployed" });
  const issues: IssueRecord[] = [issue1, issue2];

  const md = buildRoutingReport(attempts, issues);

  // Overview counts split learnable vs override.
  assert.match(md, /Learnable issues \(auto-routed\): 1/);
  assert.match(md, /Human-override issues[^\n]*: 1/);
  // Completed features table lists the auto-routed success only.
  assert.match(md, /\| anthropic \| claude-sonnet-5 \| 1 \|/);
  assert.doesNotMatch(md, /\| openai \| gpt-5.5 \| 1 \|/); // override excluded from learning tables
  // Token honesty.
  assert.match(md, /unavailable — the launcher control protocol emits no token counts/);
  // Overrides tracked in their own section.
  assert.match(md, /## Human overrides/);
  assert.match(md, /Override issues: 1/);
});

test("report reflects first-attempt success and frontier utilization", () => {
  const frontier = attempt({
    issueNumber: 3,
    modelRequested: "claude-opus-4-8",
    modelUsed: "claude-opus-4-8",
    selectedModelLabel: "model:claude-opus-4.8",
    frontierModelUsed: true,
    issueCharacteristicLabels: ["task:complex"],
  });
  const issue = aggregateIssue(3, [frontier], { mergeStatus: "merged", productionStatus: "deployed" });
  const md = buildRoutingReport([frontier], [issue]);
  assert.match(md, /First-attempt success rate: 100% \(1\/1\)/);
  assert.match(md, /Attempts on frontier models: 100% \(1\/1\)/);
  assert.match(md, /completed by a frontier model: 1/);
});

test("recommendations stay silent below the sample threshold", () => {
  const issue = aggregateIssue(1, [attempt()], { mergeStatus: "merged", productionStatus: "deployed" });
  const md = buildRoutingReport([attempt()], [issue]);
  assert.match(md, /Not enough comparable data yet/);
});
