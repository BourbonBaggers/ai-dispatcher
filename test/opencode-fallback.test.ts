import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  planOpenCodeFallback,
  OPENCODE_MODEL_SELECTION_TABLE,
  OPENCODE_FREE_MODEL_LAST_RESORT_ORDER,
} from "../src/opencode-fallback.ts";
import {
  type ExhaustionState,
  type OpenCodeZenBalance,
  recordExhaustion,
} from "../src/exhaustion-state.ts";
import { allDispatchableModels } from "../src/models.ts";

describe("opencode-fallback", () => {
  const now = new Date("2026-07-31T12:00:00Z");
  const emptyCapacity = new Map();

  describe("OPENCODE_MODEL_SELECTION_TABLE", () => {
    it("has deterministic model order for each route tier", () => {
      assert(OPENCODE_MODEL_SELECTION_TABLE.tiny.length >= 2);
      assert(OPENCODE_MODEL_SELECTION_TABLE.cheap.length >= 2);
      assert(OPENCODE_MODEL_SELECTION_TABLE.standard.length >= 2);
      assert(OPENCODE_MODEL_SELECTION_TABLE.capable.length >= 2);
      assert(OPENCODE_MODEL_SELECTION_TABLE.hard.length >= 2);
      assert(OPENCODE_MODEL_SELECTION_TABLE.frontier.length >= 2);
      assert(OPENCODE_MODEL_SELECTION_TABLE["ultra-frontier"].length >= 2);
    });

    it("prefers DeepSeek V4 Flash for tiny/cheap", () => {
      assert.equal(
        OPENCODE_MODEL_SELECTION_TABLE.tiny[0],
        "model:opencode-deepseek-v4-flash",
      );
      assert.equal(
        OPENCODE_MODEL_SELECTION_TABLE.cheap[0],
        "model:opencode-deepseek-v4-flash",
      );
    });

    it("prefers MiniMax M3 for standard", () => {
      assert.equal(OPENCODE_MODEL_SELECTION_TABLE.standard[0], "model:opencode-minimax-m3");
    });

    it("prefers GLM 5.2 for capable/hard", () => {
      assert.equal(OPENCODE_MODEL_SELECTION_TABLE.capable[0], "model:opencode-glm-5.2");
      assert.equal(OPENCODE_MODEL_SELECTION_TABLE.hard[0], "model:opencode-glm-5.2");
    });

    it("prefers DeepSeek V4 Pro for frontier", () => {
      assert.equal(
        OPENCODE_MODEL_SELECTION_TABLE.frontier[0],
        "model:opencode-deepseek-v4-pro",
      );
    });

    it("prefers Kimi K3 for ultra-frontier", () => {
      assert.equal(
        OPENCODE_MODEL_SELECTION_TABLE["ultra-frontier"][0],
        "model:opencode-kimi-k3",
      );
    });
  });

  describe("OPENCODE_FREE_MODEL_LAST_RESORT_ORDER", () => {
    it("has deterministic free model order", () => {
      assert.equal(OPENCODE_FREE_MODEL_LAST_RESORT_ORDER.length, 3);
      assert.equal(OPENCODE_FREE_MODEL_LAST_RESORT_ORDER[0], "model:opencode-deepseek-v4-flash-free");
      assert.equal(OPENCODE_FREE_MODEL_LAST_RESORT_ORDER[1], "model:opencode-mimo-v2.5-free");
      assert.equal(OPENCODE_FREE_MODEL_LAST_RESORT_ORDER[2], "model:opencode-north-mini-code-free");
    });
  });

  describe("planOpenCodeFallback", () => {
    it("returns null when neither provider is exhausted", () => {
      const exhaustionState: ExhaustionState = {};
      const zenBalance: OpenCodeZenBalance = {
        paidBalance: 100,
        freeMonthlyBalance: 50,
        monthlyResetAt: now.getTime() + 24 * 60 * 60 * 1000,
        source: "cached-config",
      };

      const result = planOpenCodeFallback(
        exhaustionState,
        zenBalance,
        "standard",
        emptyCapacity,
        allDispatchableModels(),
        { now },
      );

      assert.equal(result, null);
    });

    it("returns null when only one provider is exhausted", () => {
      let exhaustionState: ExhaustionState = {};
      exhaustionState = recordExhaustion(exhaustionState, "anthropic", "5-hour", null, now);

      const zenBalance: OpenCodeZenBalance = {
        paidBalance: 100,
        freeMonthlyBalance: 50,
        monthlyResetAt: now.getTime() + 24 * 60 * 60 * 1000,
        source: "cached-config",
      };

      const result = planOpenCodeFallback(
        exhaustionState,
        zenBalance,
        "standard",
        emptyCapacity,
        allDispatchableModels(),
        { now },
      );

      assert.equal(result, null);
    });

    it("selects paid OpenCode model when both exhausted and paid balance available", () => {
      let exhaustionState: ExhaustionState = {};
      exhaustionState = recordExhaustion(exhaustionState, "anthropic", "5-hour", null, now);
      exhaustionState = recordExhaustion(exhaustionState, "openai", "5-hour", null, now);

      const zenBalance: OpenCodeZenBalance = {
        paidBalance: 100,
        freeMonthlyBalance: 50,
        monthlyResetAt: now.getTime() + 24 * 60 * 60 * 1000,
        source: "cached-config",
      };

      const result = planOpenCodeFallback(
        exhaustionState,
        zenBalance,
        "standard",
        emptyCapacity,
        allDispatchableModels(),
        { now },
      );

      assert(result);
      assert(result.selected);
      assert.equal(result.selected.modelLabel, "model:opencode-minimax-m3");
      assert.equal(result.triggerWindow, "5-hour");
      assert.equal(result.isPaidAttempt, true);
    });

    it("uses weekly exhaustion when 5-hour is not met but weekly is", () => {
      let exhaustionState: ExhaustionState = {};
      exhaustionState = recordExhaustion(exhaustionState, "anthropic", "weekly", null, now);
      exhaustionState = recordExhaustion(exhaustionState, "openai", "weekly", null, now);

      const zenBalance: OpenCodeZenBalance = {
        paidBalance: 100,
        freeMonthlyBalance: 50,
        monthlyResetAt: now.getTime() + 24 * 60 * 60 * 1000,
        source: "cached-config",
      };

      const result = planOpenCodeFallback(
        exhaustionState,
        zenBalance,
        "capable",
        emptyCapacity,
        allDispatchableModels(),
        { now },
      );

      assert(result);
      assert(result.selected);
      assert.equal(result.triggerWindow, "weekly");
    });

    it("uses monthly exhaustion when earlier windows are not met", () => {
      let exhaustionState: ExhaustionState = {};
      exhaustionState = recordExhaustion(exhaustionState, "anthropic", "monthly", null, now);
      exhaustionState = recordExhaustion(exhaustionState, "openai", "monthly", null, now);

      const zenBalance: OpenCodeZenBalance = {
        paidBalance: 100,
        freeMonthlyBalance: 50,
        monthlyResetAt: now.getTime() + 24 * 60 * 60 * 1000,
        source: "cached-config",
      };

      const result = planOpenCodeFallback(
        exhaustionState,
        zenBalance,
        "frontier",
        emptyCapacity,
        allDispatchableModels(),
        { now },
      );

      assert(result);
      assert(result.selected);
      assert.equal(result.triggerWindow, "monthly");
    });

    it("respects paid Zen balance exhaustion", () => {
      let exhaustionState: ExhaustionState = {};
      exhaustionState = recordExhaustion(exhaustionState, "anthropic", "monthly", null, now);
      exhaustionState = recordExhaustion(exhaustionState, "openai", "monthly", null, now);

      const zenBalance: OpenCodeZenBalance = {
        paidBalance: 0,
        freeMonthlyBalance: 50,
        monthlyResetAt: now.getTime() + 24 * 60 * 60 * 1000,
        source: "cached-config",
      };

      const result = planOpenCodeFallback(
        exhaustionState,
        zenBalance,
        "standard",
        emptyCapacity,
        allDispatchableModels(),
        { now },
      );

      assert(result);
      // Should select free model last resort, not paid fallback
      assert.equal(result.isPaidAttempt, false);
    });

    it("filters out failed models from fallback sequence", () => {
      let exhaustionState: ExhaustionState = {};
      exhaustionState = recordExhaustion(exhaustionState, "anthropic", "5-hour", null, now);
      exhaustionState = recordExhaustion(exhaustionState, "openai", "5-hour", null, now);

      const zenBalance: OpenCodeZenBalance = {
        paidBalance: 100,
        freeMonthlyBalance: 50,
        monthlyResetAt: now.getTime() + 24 * 60 * 60 * 1000,
        source: "cached-config",
      };

      const failed = new Set(["model:opencode-minimax-m3"]);

      const result = planOpenCodeFallback(
        exhaustionState,
        zenBalance,
        "standard",
        emptyCapacity,
        allDispatchableModels(),
        { failedModelsInSequence: failed, now },
      );

      assert(result);
      assert(result.selected);
      // Should select second choice (Grok Build 0.1) since MiniMax M3 failed
      assert.equal(result.selected.modelLabel, "model:opencode-grok-build-0.1");
    });

    it("selects free-model last resort when conditions are met", () => {
      let exhaustionState: ExhaustionState = {};
      exhaustionState = recordExhaustion(exhaustionState, "anthropic", "monthly", null, now);
      exhaustionState = recordExhaustion(exhaustionState, "openai", "monthly", null, now);

      const zenBalance: OpenCodeZenBalance = {
        paidBalance: 0,
        freeMonthlyBalance: 50,
        monthlyResetAt: now.getTime() + 24 * 60 * 60 * 1000,
        source: "cached-config",
      };

      const result = planOpenCodeFallback(
        exhaustionState,
        zenBalance,
        "standard",
        emptyCapacity,
        allDispatchableModels(),
        { now },
      );

      assert(result);
      assert(result.selected);
      assert.equal(result.selected.modelLabel, "model:opencode-deepseek-v4-flash-free");
      assert.equal(result.isPaidAttempt, false);
    });

    it("does not attempt free models without full monthly exhaustion", () => {
      let exhaustionState: ExhaustionState = {};
      exhaustionState = recordExhaustion(exhaustionState, "anthropic", "5-hour", null, now);
      exhaustionState = recordExhaustion(exhaustionState, "openai", "5-hour", null, now);

      const zenBalance: OpenCodeZenBalance = {
        paidBalance: 0,
        freeMonthlyBalance: 50,
        monthlyResetAt: now.getTime() + 24 * 60 * 60 * 1000,
        source: "cached-config",
      };

      const result = planOpenCodeFallback(
        exhaustionState,
        zenBalance,
        "standard",
        emptyCapacity,
        allDispatchableModels(),
        { now },
      );

      // Should return null since paid balance is exhausted and monthly is not exhausted
      assert.equal(result, null);
    });

    it("respects route-specific model preferences", () => {
      let exhaustionState: ExhaustionState = {};
      exhaustionState = recordExhaustion(exhaustionState, "anthropic", "5-hour", null, now);
      exhaustionState = recordExhaustion(exhaustionState, "openai", "5-hour", null, now);

      const zenBalance: OpenCodeZenBalance = {
        paidBalance: 100,
        freeMonthlyBalance: 50,
        monthlyResetAt: now.getTime() + 24 * 60 * 60 * 1000,
        source: "cached-config",
      };

      const resultTiny = planOpenCodeFallback(
        exhaustionState,
        zenBalance,
        "tiny",
        emptyCapacity,
        allDispatchableModels(),
        { now },
      );

      const resultCapable = planOpenCodeFallback(
        exhaustionState,
        zenBalance,
        "capable",
        emptyCapacity,
        allDispatchableModels(),
        { now },
      );

      assert(resultTiny?.selected);
      assert(resultCapable?.selected);
      assert.notEqual(resultTiny.selected.modelLabel, resultCapable.selected.modelLabel);
      // Tiny prefers DeepSeek Flash, capable prefers GLM
      assert.equal(resultTiny.selected.modelLabel, "model:opencode-deepseek-v4-flash");
      assert.equal(resultCapable.selected.modelLabel, "model:opencode-glm-5.2");
    });
  });
});
