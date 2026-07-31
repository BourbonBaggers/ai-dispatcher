import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyAgentFailure,
  classifyCiFailure,
  classifyMergeFailure,
  classifyDeploymentFailure,
  type FailureCategory,
} from "../src/failure-classification.ts";

test("agent failure: transient interrupted before result", () => {
  const classification = classifyAgentFailure({
    exitCode: 143,
    sawResult: false,
  });
  assert.equal(classification.category, "transient");
  assert(classification.reason.includes("interrupted"));
});

test("agent failure: context exhaustion", () => {
  const classification = classifyAgentFailure({
    exitCode: 1,
    sawResult: true,
    providerCapacitySignal: { kind: "context-exhaustion" },
  });
  assert.equal(classification.category, "context-exhaustion");
});

test("agent failure: usage limit exhaustion", () => {
  const classification = classifyAgentFailure({
    exitCode: 1,
    sawResult: true,
    providerCapacitySignal: { kind: "quota-exhaustion" },
  });
  assert.equal(classification.category, "usage-limit");
});

test("agent failure: implementation failure (clean exit, no commits)", () => {
  const classification = classifyAgentFailure({
    exitCode: 0,
    sawResult: true,
  });
  assert.equal(classification.category, "implementation-failure");
  assert(classification.reason.includes("no commits"));
});

test("agent failure: network error detected", () => {
  const classification = classifyAgentFailure({
    exitCode: 1,
    sawResult: true,
    outputContains: ["Error: network timeout", "ECONNREFUSED"],
  });
  assert.equal(classification.category, "transient");
  assert(classification.reason.includes("Network"));
});

test("agent failure: dependency error detected", () => {
  const classification = classifyAgentFailure({
    exitCode: 1,
    sawResult: true,
    outputContains: ["dependency resolution error", "package missing"],
  });
  assert.equal(classification.category, "transient");
  assert(classification.reason.toLowerCase().includes("dependency"));
});

test("agent failure: generic implementation failure", () => {
  const classification = classifyAgentFailure({
    exitCode: 1,
    sawResult: true,
  });
  assert.equal(classification.category, "implementation-failure");
});

test("ci failure: pending checks", () => {
  const classification = classifyCiFailure({
    ciState: "pending",
  });
  assert.equal(classification.category, "unknown");
  assert(classification.reason.includes("still running"));
});

test("ci failure: passing ci", () => {
  const classification = classifyCiFailure({
    ciState: "pass",
  });
  assert.equal(classification.category, "unknown");
  assert(classification.reason.includes("No CI failure"));
});

test("ci failure: timeout", () => {
  const classification = classifyCiFailure({
    ciState: "fail",
    checkConclusionDetails: "Job exceeded timeout",
  });
  assert.equal(classification.category, "transient");
  assert(classification.reason.toLowerCase().includes("time"));
});

test("ci failure: flaky check", () => {
  const classification = classifyCiFailure({
    ciState: "fail",
    failedChecks: [{ name: "Flaky test suite", conclusion: "failure" }],
  });
  assert.equal(classification.category, "transient");
  assert(classification.reason.includes("Flaky"));
});

test("ci failure: infrastructure setup failed", () => {
  const classification = classifyCiFailure({
    ciState: "fail",
    checkConclusionDetails: "Runner setup failed",
  });
  assert.equal(classification.category, "transient");
  assert(classification.reason.includes("infrastructure"));
});

test("ci failure: deterministic test failure", () => {
  const classification = classifyCiFailure({
    ciState: "fail",
    failedChecks: [{ name: "Unit tests", conclusion: "failure", summary: "2 tests failed" }],
  });
  assert.equal(classification.category, "test-failure");
  assert(classification.reason.includes("Deterministic"));
});

test("merge failure: clean merge", () => {
  const classification = classifyMergeFailure({
    mergeStatus: "clean",
    hasConflicts: false,
  });
  assert.equal(classification.category, "unknown");
  assert(classification.reason.includes("No merge failure"));
});

test("merge failure: manual conflict resolution needed", () => {
  const classification = classifyMergeFailure({
    mergeStatus: "conflicted",
    hasConflicts: true,
    conflictDetails: "Conflicts require manual resolution in src/main.ts",
  });
  assert.equal(classification.category, "human-intervention");
  assert(classification.reason.toLowerCase().includes("manual"));
});

test("merge failure: auto-resolvable conflict", () => {
  const classification = classifyMergeFailure({
    mergeStatus: "conflicted",
    hasConflicts: true,
  });
  assert.equal(classification.category, "test-failure");
  assert(classification.reason.includes("conflict"));
});

test("deployment failure: successful deploy", () => {
  const classification = classifyDeploymentFailure({
    exitCode: 0,
  });
  assert.equal(classification.category, "unknown");
  assert(classification.reason.includes("No deployment failure"));
});

test("deployment failure: health check timeout", () => {
  const classification = classifyDeploymentFailure({
    exitCode: 1,
    deployPhase: "health-check",
    commandOutput: "Health check timeout after 30s",
  });
  assert.equal(classification.category, "transient");
  assert(classification.reason.includes("health"));
});

test("deployment failure: connection refused", () => {
  const classification = classifyDeploymentFailure({
    exitCode: 1,
    commandOutput: "Error: Cannot connect to deployment target, connection refused",
  });
  assert.equal(classification.category, "transient");
  assert(classification.reason.includes("infrastructure"));
});

test("deployment failure: pre-deployment validation", () => {
  const classification = classifyDeploymentFailure({
    exitCode: 1,
    deployPhase: "pre-deploy",
    commandOutput: "Validation failed: image not found",
  });
  assert.equal(classification.category, "test-failure");
  assert(classification.reason.includes("validation"));
});

test("deployment failure: generic failure defaults to transient", () => {
  const classification = classifyDeploymentFailure({
    exitCode: 1,
    deployPhase: "deploy",
  });
  assert.equal(classification.category, "transient");
});
