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
  effectiveModelPrice,
  modelExpectedCostScore,
  modelsForRoute,
  buildModelLadder,
  nextModelInLadder,
  ladderPosition,
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
  assert.equal(tierRank("tiny"), 0);
  assert.ok(tierRank("tiny") < tierRank("cheap"));
  assert.ok(tierRank("cheap") < tierRank("standard"));
  assert.ok(tierRank("standard") < tierRank("capable"));
  assert.ok(tierRank("capable") < tierRank("hard"));
  assert.ok(tierRank("hard") < tierRank("frontier"));
  assert.ok(tierRank("frontier") < tierRank("ultra-frontier"));
});

test("only enabled models on a live dispatch agent are dispatchable", () => {
  const opus = modelByLabel("model:claude-opus-4.8")!;
  assert.equal(isDispatchable(opus), true);

  // Enabled but future provider (non-live cli): excluded.
  const gemini = modelByLabel("model:gemini-2.5-pro")!;
  assert.equal(gemini.enabled, false);
  assert.equal(isLiveDispatchCli(gemini.cli), false);
  assert.equal(isDispatchable(gemini), false);
});

test("frontier and ultra-frontier live models are protected tiers", () => {
  const frontier = dispatchableModels().filter((m) => m.frontier);
  assert.ok(frontier.length >= 1, "at least one frontier model exists");
  for (const m of frontier) {
    assert.ok(m.tier === "frontier" || m.tier === "ultra-frontier");
  }
});

test("MODEL_LABELS is derived from the dispatchable registry", () => {
  // The label allowlist and the dispatchable registry must agree exactly.
  const fromRegistry = new Set(dispatchableModels().map((m) => m.modelLabel));
  const fromLabels = new Set(Object.keys(MODEL_LABELS));
  assert.deepEqual([...fromLabels].sort(), [...fromRegistry].sort());

  // Representative lanes resolve to their pinned identifiers.
  assert.deepEqual(MODEL_LABELS["model:claude-opus-4.8"], {
    agent: "claude",
    cliModel: "claude-opus-4-8",
  });
  assert.deepEqual(MODEL_LABELS["model:gpt-5.5"], { agent: "codex", cliModel: "gpt-5.5" });
  assert.deepEqual(MODEL_LABELS["model:gpt-5.4-mini"], {
    agent: "codex",
    cliModel: "gpt-5.4-mini",
  });
  assert.deepEqual(MODEL_LABELS["model:claude-fable-5"], {
    agent: "claude",
    cliModel: "claude-fable-5",
  });

  assert.equal(MODEL_LABELS["model:gemini-2.5-pro"], undefined);
});

test("modelByCliModel round-trips explicit identifiers", () => {
  assert.equal(modelByCliModel("claude-opus-4-8")!.modelLabel, "model:claude-opus-4.8");
  assert.equal(modelByCliModel("gpt-5.5")!.modelLabel, "model:gpt-5.5");
  assert.equal(modelByCliModel("nope"), null);
});

test("sonnet promotional and standard prices are date-effective", () => {
  const sonnet = modelByLabel("model:claude-sonnet-5")!;
  assert.equal(effectiveModelPrice(sonnet, new Date("2026-08-31T12:00:00Z")).inputUsdPerMillion, 2);
  assert.equal(effectiveModelPrice(sonnet, new Date("2026-09-01T00:00:00Z")).inputUsdPerMillion, 3);
});

// The route ladder had holes before #51's follow-up: no model declared the `cheap` or
// `hard` tier, so six of the twenty-one base-matrix cells resolved to a tier nothing
// served, and routing patched around it with hardcoded model labels.
test("every route tier has at least one dispatchable model", () => {
  for (const tier of MODEL_TIERS) {
    assert.ok(
      modelsForRoute(tier).length > 0,
      `no dispatchable model serves the ${tier} route`,
    );
  }
});

test("a model's home tier is always one of the routes it serves", () => {
  for (const model of MODELS) {
    assert.ok(
      model.routeTiers.includes(model.tier),
      `${model.modelLabel} has tier ${model.tier} outside routeTiers`,
    );
  }
});

test("route spans are contiguous on the tier ladder", () => {
  for (const model of MODELS) {
    const ranks = model.routeTiers.map(tierRank).sort((a, b) => a - b);
    for (let i = 1; i < ranks.length; i += 1) {
      assert.equal(ranks[i], ranks[i - 1]! + 1, `${model.modelLabel} has a gap in routeTiers`);
    }
  }
});

test("only the explicit reserve serves ultra-frontier on the Claude side", () => {
  const claude = modelsForRoute("ultra-frontier").filter((m) => m.provider === "anthropic");
  assert.deepEqual(claude.map((m) => m.modelLabel), ["model:claude-fable-5"]);
});

// Sonnet's promotional price expires 2026-08-31. The capable lane must follow the price
// schedule rather than a hardcoded winner.
test("the effective price schedule flips the cheapest capable model on the documented date", () => {
  const sonnet = modelByLabel("model:claude-sonnet-5")!;
  const promo = effectiveModelPrice(sonnet, new Date("2026-08-31T12:00:00Z"));
  const standard = effectiveModelPrice(sonnet, new Date("2026-09-01T12:00:00Z"));
  assert.equal(promo.inputUsdPerMillion, 2);
  assert.equal(standard.inputUsdPerMillion, 3);
  const terra = modelByLabel("model:gpt-5.6-terra")!;
  const before = new Date("2026-08-31T12:00:00Z");
  const after = new Date("2026-09-01T12:00:00Z");
  assert.ok(
    modelExpectedCostScore(sonnet, "effort:medium", before) <
      modelExpectedCostScore(terra, "effort:medium", before),
  );
  assert.ok(
    modelExpectedCostScore(sonnet, "effort:medium", after) >
      modelExpectedCostScore(terra, "effort:medium", after),
  );
});

test("buildModelLadder constructs a recovery ladder for Claude models", () => {
  const haiku = modelByLabel("model:claude-haiku-4.5")!;
  const ladder = buildModelLadder(haiku);
  assert.ok(ladder.length >= 2, "Claude ladder should have multiple rungs");
  assert.equal(ladder[0]!.modelLabel, "model:claude-haiku-4.5");
  const modelLabels = ladder.map((m) => m.modelLabel);
  assert.ok(modelLabels.includes("model:claude-sonnet-5"), "ladder should include sonnet");
  assert.ok(!modelLabels.includes("model:claude-opus-4.8"), "ladder should exclude frontier opus");
  assert.ok(!modelLabels.some((l) => modelByLabel(l)!.frontier), "ladder should not include frontier models");
});

test("buildModelLadder constructs a recovery ladder for OpenAI models", () => {
  const mini = modelByLabel("model:gpt-5.4-mini")!;
  const ladder = buildModelLadder(mini);
  assert.ok(ladder.length >= 2, "OpenAI ladder should have multiple rungs");
  assert.equal(ladder[0]!.modelLabel, "model:gpt-5.4-mini");
  const modelLabels = ladder.map((m) => m.modelLabel);
  assert.ok(modelLabels.includes("model:gpt-5.6-luna"), "ladder should include luna");
  assert.ok(modelLabels.includes("model:gpt-5.6-terra"), "ladder should include terra");
  assert.ok(!modelLabels.includes("model:gpt-5.6-sol"), "ladder should exclude frontier sol");
});

test("buildModelLadder returns rungs from the starting model onwards", () => {
  const sonnet = modelByLabel("model:claude-sonnet-5")!;
  const ladder = buildModelLadder(sonnet);
  // When starting from sonnet, we should only get sonnet and anything higher, not haiku
  const haiku = modelByLabel("model:claude-haiku-4.5")!;
  const modelLabels = ladder.map((m) => m.modelLabel);
  assert.ok(!modelLabels.includes(haiku.modelLabel), "ladder from sonnet should not include haiku");
  assert.ok(modelLabels.includes("model:claude-sonnet-5"), "ladder should include starting model");
});

test("nextModelInLadder climbs to the next rung", () => {
  const haiku = modelByLabel("model:claude-haiku-4.5")!;
  const sonnet = modelByLabel("model:claude-sonnet-5")!;
  const ladder = buildModelLadder(haiku);

  const next = nextModelInLadder(haiku, ladder);
  assert.equal(next?.modelLabel, "model:claude-sonnet-5", "next after haiku should be sonnet");

  const nextAfterSonnet = nextModelInLadder(sonnet, ladder);
  assert.equal(
    nextAfterSonnet,
    null,
    "sonnet is the top non-frontier rung, so next should be null",
  );
});

test("nextModelInLadder returns null at the top of the ladder", () => {
  const sonnet = modelByLabel("model:claude-sonnet-5")!;
  const ladder = buildModelLadder(sonnet);
  // When ladder starts at sonnet, sonnet is the only/top rung
  const next = nextModelInLadder(sonnet, ladder);
  assert.equal(next, null, "next at top of ladder should be null");
});

test("ladderPosition tracks position in the ladder", () => {
  const haiku = modelByLabel("model:claude-haiku-4.5")!;
  const sonnet = modelByLabel("model:claude-sonnet-5")!;
  const ladder = buildModelLadder(haiku);

  const haikuPos = ladderPosition(haiku, ladder);
  assert.equal(haikuPos.current, 0, "haiku at position 0");
  assert.equal(haikuPos.total, ladder.length);
  assert.equal(haikuPos.nextModel?.modelLabel, "model:claude-sonnet-5");

  const sonnetPos = ladderPosition(sonnet, ladder);
  assert.equal(sonnetPos.current, 1, "sonnet at position 1");
  assert.equal(sonnetPos.total, ladder.length);
  assert.equal(sonnetPos.nextModel, null, "no next after sonnet");
});
