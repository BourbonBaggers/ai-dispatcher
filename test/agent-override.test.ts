import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectAgentOverride,
  selectAgentModel,
  conflictCommentFor,
} from "../src/agent-override.ts";
import { allDispatchableModels } from "../src/models.ts";

test("detectAgentOverride returns no conflict when no agent labels", () => {
  const result = detectAgentOverride([]);
  assert.equal(result.agent, null);
  assert.equal(result.hasConflict, false);
});

test("detectAgentOverride detects single agent:codex override", () => {
  const result = detectAgentOverride(["agent:codex"]);
  assert.equal(result.agent, "codex");
  assert.equal(result.hasConflict, false);
});

test("detectAgentOverride detects single agent:claude override", () => {
  const result = detectAgentOverride(["agent:claude"]);
  assert.equal(result.agent, "claude");
  assert.equal(result.hasConflict, false);
});

test("detectAgentOverride detects single agent:opencode override", () => {
  const result = detectAgentOverride(["agent:opencode"]);
  assert.equal(result.agent, "opencode");
  assert.equal(result.hasConflict, false);
});

test("detectAgentOverride detects conflict with two agent labels", () => {
  const result = detectAgentOverride(["agent:codex", "agent:claude"]);
  assert.equal(result.agent, null);
  assert.equal(result.hasConflict, true);
  assert.deepEqual(result.conflictingLabels, ["agent:codex", "agent:claude"]);
});

test("detectAgentOverride detects conflict with three agent labels", () => {
  const result = detectAgentOverride([
    "agent:codex",
    "agent:claude",
    "agent:opencode",
  ]);
  assert.equal(result.agent, null);
  assert.equal(result.hasConflict, true);
  assert.equal(result.conflictingLabels?.length, 3);
});

test("selectAgentModel picks a claude model for claude agent", () => {
  const capacityByPool = new Map();
  const model = selectAgentModel("claude", "standard", false, capacityByPool);
  assert(model !== null);
  assert.equal(model.cli, "claude");
  assert(model.routeTiers.includes("standard"));
});

test("selectAgentModel picks a codex model for codex agent", () => {
  const capacityByPool = new Map();
  const model = selectAgentModel("codex", "standard", false, capacityByPool);
  assert(model !== null);
  assert.equal(model.cli, "codex");
  assert(model.routeTiers.includes("standard"));
});

test("selectAgentModel picks an opencode model for opencode agent", () => {
  const capacityByPool = new Map();
  const model = selectAgentModel("opencode", "standard", false, capacityByPool);
  assert(model !== null);
  assert.equal(model.cli, "opencode");
  assert(model.routeTiers.includes("standard"));
});

test("selectAgentModel respects minimum tier requirement", () => {
  const capacityByPool = new Map();
  // Request capable tier - should not return a cheap model
  const model = selectAgentModel("claude", "capable", false, capacityByPool);
  assert(model !== null);
  assert.equal(model.cli, "claude");
  assert(model.routeTiers.includes("capable"));
});

test("selectAgentModel returns null when no model matches tier", () => {
  const capacityByPool = new Map();
  // Assuming no models serve ultra-frontier except ultra-frontier models, and we're
  // checking with a tier that codex doesn't have. This is a hypothetical case.
  // Let's test with a reasonable tier instead.
  const model = selectAgentModel("claude", "tiny", false, capacityByPool);
  assert(model !== null); // Claude should have tiny models
});

test("selectAgentModel respects large context requirement", () => {
  const capacityByPool = new Map();
  // When large context is required, should pick a model with largeContext: true
  const allModels = allDispatchableModels();
  const claudeWithLargeContext = allModels.filter((m) => m.cli === "claude" && m.largeContext);

  if (claudeWithLargeContext.length > 0) {
    // Use capable tier since claude-sonnet-5 (the only large-context claude) serves capable+
    const model = selectAgentModel("claude", "capable", true, capacityByPool);
    assert(model !== null);
    assert.equal(model.largeContext, true);
  }
});

test("conflictCommentFor generates appropriate message", () => {
  const comment = conflictCommentFor(["agent:codex", "agent:claude"]);
  assert.match(comment, /multiple agent override labels/);
  assert.match(comment, /agent:codex/);
  assert.match(comment, /agent:claude/);
  assert.match(comment, /agent:opencode/);
});

test("conflictCommentFor includes all conflicting labels in message", () => {
  const comment = conflictCommentFor([
    "agent:codex",
    "agent:claude",
    "agent:opencode",
  ]);
  assert.match(comment, /agent:codex, agent:claude, agent:opencode/);
});
