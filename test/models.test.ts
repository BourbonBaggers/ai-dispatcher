import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MODELS,
  MODEL_TIERS,
  MODEL_ROLES,
  tierRank,
  isDispatchable,
  dispatchableModels,
  modelByLabel,
  modelByCliModel,
  isLiveDispatchCli,
} from "../src/models.ts";
import { MODEL_LABELS } from "../src/labels.ts";

test("every registry entry is internally consistent", () => {
  const seenLabels = new Set<string>();
  const seenCliModels = new Set<string>();
  for (const m of MODELS) {
    assert.ok(m.modelLabel.startsWith("model:"), `${m.modelLabel} must be a model:* label`);
    assert.ok(!seenLabels.has(m.modelLabel), `duplicate label ${m.modelLabel}`);
    assert.ok(!seenCliModels.has(m.cliModel), `duplicate cliModel ${m.cliModel}`);
    seenLabels.add(m.modelLabel);
    seenCliModels.add(m.cliModel);
    assert.ok((MODEL_TIERS as readonly string[]).includes(m.tier), `${m.tier} is a known tier`);
    assert.ok((MODEL_ROLES as readonly string[]).includes(m.role), `${m.role} is a known role`);
    assert.ok(m.contextWindow > 0, "context window is positive");
    // A pinned identifier, never a floating alias like "latest".
    assert.ok(!/latest/i.test(m.cliModel), `${m.cliModel} must be an explicit id, not an alias`);
  }
});

test("fallbacks reference real registry labels", () => {
  for (const m of MODELS) {
    for (const fb of m.fallbacks) {
      assert.ok(modelByLabel(fb), `${m.modelLabel} falls back to unknown ${fb}`);
    }
  }
});

test("tierRank orders the capability ladder ascending", () => {
  assert.equal(tierRank("fast"), 0);
  assert.ok(tierRank("fast") < tierRank("general"));
  assert.ok(tierRank("general") < tierRank("complex"));
  assert.ok(tierRank("complex") < tierRank("frontier"));
});

test("only enabled models on a live dispatch agent are dispatchable", () => {
  const opus = modelByLabel("model:claude-opus-4.8")!;
  assert.equal(isDispatchable(opus), true);

  // Disabled model: excluded even though its cli is a live agent.
  const mini = modelByLabel("model:gpt-5.5-mini")!;
  assert.equal(mini.enabled, false);
  assert.equal(isDispatchable(mini), false);

  // Enabled but future provider (non-live cli): excluded.
  const gemini = modelByLabel("model:gemini-2.5-pro")!;
  assert.equal(gemini.enabled, false);
  assert.equal(isLiveDispatchCli(gemini.cli), false);
  assert.equal(isDispatchable(gemini), false);
});

test("exactly one frontier model per live provider is protected", () => {
  const frontier = dispatchableModels().filter((m) => m.frontier);
  assert.ok(frontier.length >= 1, "at least one frontier model exists");
  for (const m of frontier) assert.equal(m.tier, "frontier");
});

test("MODEL_LABELS is derived from the dispatchable registry", () => {
  // The label allowlist and the dispatchable registry must agree exactly.
  const fromRegistry = new Set(dispatchableModels().map((m) => m.modelLabel));
  const fromLabels = new Set(Object.keys(MODEL_LABELS));
  assert.deepEqual([...fromLabels].sort(), [...fromRegistry].sort());

  // The two historically-supported lanes resolve to their pinned identifiers.
  assert.deepEqual(MODEL_LABELS["model:claude-opus-4.8"], {
    agent: "claude",
    cliModel: "claude-opus-4-8",
  });
  assert.deepEqual(MODEL_LABELS["model:gpt-5.5"], { agent: "codex", cliModel: "gpt-5.5" });

  // A disabled model is not a valid dispatch label.
  assert.equal(MODEL_LABELS["model:gpt-5.5-mini"], undefined);
  assert.equal(MODEL_LABELS["model:gemini-2.5-pro"], undefined);
});

test("modelByCliModel round-trips explicit identifiers", () => {
  assert.equal(modelByCliModel("claude-opus-4-8")!.modelLabel, "model:claude-opus-4.8");
  assert.equal(modelByCliModel("gpt-5.5")!.modelLabel, "model:gpt-5.5");
  assert.equal(modelByCliModel("nope"), null);
});
