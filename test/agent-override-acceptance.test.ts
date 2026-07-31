/**
 * Acceptance tests for agent-level pickup overrides (issue #58).
 *
 * These tests verify that single agent labels constrain pickup to that agent,
 * and that multiple agent labels are blocked with appropriate feedback.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { detectAgentOverride, selectAgentModel, conflictCommentFor } from "../src/agent-override.ts";
import { assignmentForModel } from "../src/labels.ts";
import { parseCharacteristics, deriveMinimumTier } from "../src/routing.ts";
import { allDispatchableModels } from "../src/models.ts";
import type { CapacityAssessment } from "../src/capacity.ts";

// ── Single-agent overrides ─────────────────────────────────────────────────

test("agent:codex override selects a codex model", () => {
  const labels = ["agent:codex", "dispatch:ready"];
  const override = detectAgentOverride(labels);
  assert.equal(override.agent, "codex");
  assert.equal(override.hasConflict, false);

  const capacityByPool = new Map<string, CapacityAssessment>();
  const characteristics = parseCharacteristics(labels);
  const minimumTier = deriveMinimumTier(characteristics);
  const model = selectAgentModel("codex", minimumTier, false, capacityByPool);

  assert(model !== null);
  assert.equal(model.cli, "codex");
});

test("agent:claude override selects a claude model", () => {
  const labels = ["agent:claude", "dispatch:ready"];
  const override = detectAgentOverride(labels);
  assert.equal(override.agent, "claude");
  assert.equal(override.hasConflict, false);

  const capacityByPool = new Map<string, CapacityAssessment>();
  const characteristics = parseCharacteristics(labels);
  const minimumTier = deriveMinimumTier(characteristics);
  const model = selectAgentModel("claude", minimumTier, false, capacityByPool);

  assert(model !== null);
  assert.equal(model.cli, "claude");
});

test("agent:opencode override selects an opencode model (fallback-only)", () => {
  const labels = ["agent:opencode", "dispatch:ready"];
  const override = detectAgentOverride(labels);
  assert.equal(override.agent, "opencode");
  assert.equal(override.hasConflict, false);

  const capacityByPool = new Map<string, CapacityAssessment>();
  const characteristics = parseCharacteristics(labels);
  const minimumTier = deriveMinimumTier(characteristics);
  const model = selectAgentModel("opencode", minimumTier, false, capacityByPool);

  assert(model !== null);
  assert.equal(model.cli, "opencode");
  // Verify it's a fallback-only model
  assert.equal(model.fallbackOnly, true);
});

test("agent override can be combined with effort labels", () => {
  const labels = ["agent:claude", "effort:high", "dispatch:ready"];
  const override = detectAgentOverride(labels);
  assert.equal(override.agent, "claude");

  const capacityByPool = new Map<string, CapacityAssessment>();
  const characteristics = parseCharacteristics(labels);
  const minimumTier = deriveMinimumTier(characteristics);
  const model = selectAgentModel("claude", minimumTier, false, capacityByPool);

  assert(model !== null);
  const assignment = assignmentForModel(model, "effort:high");
  assert.equal(assignment.ok, true);
  assert.equal(assignment.ok && assignment.value.cliEffort, "high");
});

// ── No override ────────────────────────────────────────────────────────────

test("no agent label means no override", () => {
  const labels = ["dispatch:ready", "type:bug"];
  const override = detectAgentOverride(labels);
  assert.equal(override.agent, null);
  assert.equal(override.hasConflict, false);
});

// ── Conflict detection ─────────────────────────────────────────────────────

test("two agent labels create a conflict", () => {
  const labels = ["agent:codex", "agent:claude"];
  const override = detectAgentOverride(labels);
  assert.equal(override.agent, null);
  assert.equal(override.hasConflict, true);
  assert.deepEqual(override.conflictingLabels, ["agent:codex", "agent:claude"]);
});

test("three agent labels create a conflict", () => {
  const labels = ["agent:codex", "agent:claude", "agent:opencode"];
  const override = detectAgentOverride(labels);
  assert.equal(override.agent, null);
  assert.equal(override.hasConflict, true);
  assert.equal(override.conflictingLabels?.length, 3);
});

test("conflict detection ignores other labels", () => {
  const labels = [
    "dispatch:ready",
    "type:bug",
    "priority:normal",
    "agent:codex",
    "agent:claude",
    "effort:high",
  ];
  const override = detectAgentOverride(labels);
  assert.equal(override.hasConflict, true);
  assert.equal(override.conflictingLabels?.length, 2);
});

// ── Conflict messages ──────────────────────────────────────────────────────

test("conflict comment explains the issue clearly", () => {
  const comment = conflictCommentFor(["agent:codex", "agent:claude"]);
  assert.match(comment, /multiple agent override labels/);
  assert.match(comment, /Cannot dispatch/);
  assert.match(comment, /agent:codex/);
  assert.match(comment, /agent:claude/);
  assert.match(comment, /agent:opencode/);
  assert.match(comment, /exactly one/);
});

test("conflict comment includes all conflicting labels", () => {
  const comment = conflictCommentFor([
    "agent:codex",
    "agent:claude",
    "agent:opencode",
  ]);
  assert.match(comment, /agent:codex, agent:claude, agent:opencode/);
});

// ── Model selection within agent ───────────────────────────────────────────

test("agent override picks lowest-cost available model for agent", () => {
  const labels = ["agent:claude"];
  const capacityByPool = new Map<string, CapacityAssessment>();
  const characteristics = parseCharacteristics(labels);
  const minimumTier = deriveMinimumTier(characteristics);
  const model1 = selectAgentModel("claude", minimumTier, false, capacityByPool);

  assert(model1 !== null);
  assert.equal(model1.cli, "claude");

  // Verify it picked a cheap/standard tier model (not frontier)
  assert(["tiny", "cheap", "standard", "capable"].includes(model1.tier));
});

test("codex agent override respects tier requirements", () => {
  const labels = ["agent:codex", "complexity:complex"];
  const capacityByPool = new Map<string, CapacityAssessment>();
  const characteristics = parseCharacteristics(labels);
  const minimumTier = deriveMinimumTier(characteristics);

  // Complex issues get routed to at least 'capable' tier
  assert(minimumTier === "capable" || minimumTier === "hard" || minimumTier === "frontier");

  const model = selectAgentModel("codex", minimumTier, false, capacityByPool);
  assert(model !== null);
  assert(model.routeTiers.includes(minimumTier));
});

test("opencode agent override selects from available opencode models", () => {
  const labels = ["agent:opencode"];
  const capacityByPool = new Map<string, CapacityAssessment>();
  const characteristics = parseCharacteristics(labels);
  const minimumTier = deriveMinimumTier(characteristics);
  const model = selectAgentModel("opencode", minimumTier, false, capacityByPool);

  assert(model !== null);
  assert.equal(model.cli, "opencode");
  // All opencode models should be fallback-only
  assert.equal(model.fallbackOnly, true);
});

// ── Backward compatibility ────────────────────────────────────────────────

test("agent override is independent from model: label overrides", () => {
  // Agent override should work without model: labels
  const labels = ["agent:claude"];
  const override = detectAgentOverride(labels);
  assert.equal(override.agent, "claude");

  const capacityByPool = new Map<string, CapacityAssessment>();
  const characteristics = parseCharacteristics(labels);
  const minimumTier = deriveMinimumTier(characteristics);
  const model = selectAgentModel("claude", minimumTier, false, capacityByPool);

  assert(model !== null);
  // Should select any available claude model
  assert.equal(model.cli, "claude");
});

test("existing agent:* output labels work correctly", () => {
  // Existing code might apply agent:* as OUTPUT labels (assignment metadata)
  // Agent override detection should not be broken by this
  const labels = ["agent:claude", "dispatch:ready"];
  const override = detectAgentOverride(labels);
  assert.equal(override.agent, "claude");
  assert.equal(override.hasConflict, false);
});

// ── Edge cases ─────────────────────────────────────────────────────────────

test("agent override with empty labels still works", () => {
  const override = detectAgentOverride([]);
  assert.equal(override.agent, null);
  assert.equal(override.hasConflict, false);
});

test("agent override is case-sensitive", () => {
  // "Agent:Claude" should not match "agent:claude"
  const override = detectAgentOverride(["Agent:Claude"]);
  assert.equal(override.agent, null);
  assert.equal(override.hasConflict, false);
});

test("partial agent labels don't match", () => {
  // "agent:" alone should not match
  const override = detectAgentOverride(["agent:"]);
  assert.equal(override.agent, null);
  assert.equal(override.hasConflict, false);
});

test("agent override works with empty capacity pool map", () => {
  // Even with no capacity information, agent override should select a model
  const capacityByPool = new Map<string, CapacityAssessment>();
  const model = selectAgentModel("claude", "tiny", false, capacityByPool);
  // Should return a model since no capacity info means no exhaustion known
  assert(model !== null);
  assert.equal(model.cli, "claude");
});
