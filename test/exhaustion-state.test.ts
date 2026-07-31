import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  type ExhaustionState,
  type OpenCodeZenBalance,
  areBothPrimaryProvidersExhausted,
  canAttemptFreeModelLastResort,
  clearExhaustion,
  exhaustionKey,
  hasAvailablePrimaryProvider,
  hasOpenCodePaidBalance,
  recordExhaustion,
} from "../src/exhaustion-state.ts";

describe("exhaustion-state", () => {
  describe("exhaustionKey", () => {
    it("creates a state key for a provider+window pair", () => {
      assert.equal(exhaustionKey("anthropic", "5-hour"), "anthropic:5-hour");
      assert.equal(exhaustionKey("openai", "weekly"), "openai:weekly");
    });
  });

  describe("recordExhaustion", () => {
    it("records exhaustion for a provider in a specific window", () => {
      const now = new Date("2026-07-31T12:00:00Z");
      const state: ExhaustionState = {};
      const signal = {
        kind: "authoritative-exhaustion" as const,
        resetAt: now.getTime() + 5 * 60 * 60 * 1000,
        excerpt: "usage limit reached",
      };
      const updated = recordExhaustion(state, "anthropic", "5-hour", signal, now);

      assert(updated["anthropic:5-hour"]);
      assert.equal(updated["anthropic:5-hour"]!.exhausted, true);
      assert.equal(updated["anthropic:5-hour"]!.resetAt, signal.resetAt);
    });

    it("does not overwrite existing exhaustion without a signal", () => {
      const firstTime = new Date("2026-07-31T10:00:00Z");
      const secondTime = new Date("2026-07-31T12:00:00Z");
      const signal = {
        kind: "unconfirmed-quota" as const,
        resetAt: null,
        excerpt: "quota exhausted",
      };

      let state: ExhaustionState = {};
      state = recordExhaustion(state, "anthropic", "5-hour", signal, firstTime);

      const unchanged = state["anthropic:5-hour"]!.detectedAt;
      state = recordExhaustion(state, "anthropic", "5-hour", null, secondTime);

      assert.equal(state["anthropic:5-hour"]!.detectedAt, unchanged);
    });
  });

  describe("clearExhaustion", () => {
    it("removes exhaustion record for a provider+window", () => {
      const now = new Date("2026-07-31T12:00:00Z");
      let state: ExhaustionState = {};
      state = recordExhaustion(state, "anthropic", "5-hour", null, now);
      state = recordExhaustion(state, "openai", "weekly", null, now);

      state = clearExhaustion(state, "anthropic", "5-hour");

      assert(!state["anthropic:5-hour"]);
      assert(state["openai:weekly"]);
    });
  });

  describe("areBothPrimaryProvidersExhausted", () => {
    it("returns true only when both Codex and Claude are exhausted for the same window", () => {
      const now = new Date("2026-07-31T12:00:00Z");
      let state: ExhaustionState = {};

      // Only Claude exhausted
      state = recordExhaustion(state, "anthropic", "5-hour", null, now);
      assert.equal(areBothPrimaryProvidersExhausted(state, "5-hour", now), false);

      // Both exhausted
      state = recordExhaustion(state, "openai", "5-hour", null, now);
      assert.equal(areBothPrimaryProvidersExhausted(state, "5-hour", now), true);

      // Only one exhausted for weekly
      assert.equal(areBothPrimaryProvidersExhausted(state, "weekly", now), false);
    });

    it("returns false if a reset time is in the past", () => {
      const now = new Date("2026-07-31T12:00:00Z");
      const pastReset = now.getTime() - 1000; // 1 second ago
      const futureReset = now.getTime() + 5 * 60 * 60 * 1000; // 5 hours in future

      let state: ExhaustionState = {};
      state = recordExhaustion(
        state,
        "anthropic",
        "5-hour",
        {
          kind: "authoritative-exhaustion",
          resetAt: pastReset,
          excerpt: "usage limit reached",
        },
        now,
      );
      state = recordExhaustion(
        state,
        "openai",
        "5-hour",
        {
          kind: "authoritative-exhaustion",
          resetAt: futureReset,
          excerpt: "usage limit reached",
        },
        now,
      );

      assert.equal(areBothPrimaryProvidersExhausted(state, "5-hour", now), false);
    });
  });

  describe("hasAvailablePrimaryProvider", () => {
    it("returns true if at least one primary provider has capacity", () => {
      const now = new Date("2026-07-31T12:00:00Z");
      let state: ExhaustionState = {};
      state = recordExhaustion(state, "anthropic", "5-hour", null, now);

      assert.equal(hasAvailablePrimaryProvider(state, "5-hour", now), true);
    });

    it("returns false only when both are exhausted", () => {
      const now = new Date("2026-07-31T12:00:00Z");
      let state: ExhaustionState = {};
      state = recordExhaustion(state, "anthropic", "5-hour", null, now);
      state = recordExhaustion(state, "openai", "5-hour", null, now);

      assert.equal(hasAvailablePrimaryProvider(state, "5-hour", now), false);
    });
  });

  describe("hasOpenCodePaidBalance", () => {
    it("returns true only when paid balance is positive and available", () => {
      const balance1: OpenCodeZenBalance = {
        paidBalance: 100,
        freeMonthlyBalance: 0,
        monthlyResetAt: null,
        source: "cached-config",
      };
      assert.equal(hasOpenCodePaidBalance(balance1), true);

      const now = new Date("2026-07-31T12:00:00Z");
      const balance2: OpenCodeZenBalance = {
        paidBalance: 0,
        freeMonthlyBalance: 50,
        monthlyResetAt: now.getTime() + 24 * 60 * 60 * 1000,
        source: "cached-config",
      };
      assert.equal(hasOpenCodePaidBalance(balance2), false);

      const balance3: OpenCodeZenBalance = {
        paidBalance: null,
        freeMonthlyBalance: 50,
        monthlyResetAt: now.getTime() + 24 * 60 * 60 * 1000,
        source: "unavailable",
      };
      assert.equal(hasOpenCodePaidBalance(balance3), false);
    });
  });

  describe("canAttemptFreeModelLastResort", () => {
    it("requires both providers exhausted for monthly window", () => {
      const now = new Date("2026-07-31T12:00:00Z");
      const goodBalance: OpenCodeZenBalance = {
        paidBalance: 0,
        freeMonthlyBalance: 50,
        monthlyResetAt: now.getTime() + 24 * 60 * 60 * 1000,
        source: "cached-config",
      };

      // Not both exhausted
      assert.equal(canAttemptFreeModelLastResort(goodBalance, false, now), false);

      // Both exhausted
      assert.equal(canAttemptFreeModelLastResort(goodBalance, true, now), true);
    });

    it("requires paid balance to be actually exhausted, not unavailable", () => {
      const now = new Date("2026-07-31T12:00:00Z");
      const unavailableBalance: OpenCodeZenBalance = {
        paidBalance: null,
        freeMonthlyBalance: 50,
        monthlyResetAt: now.getTime() + 24 * 60 * 60 * 1000,
        source: "unavailable",
      };

      assert.equal(canAttemptFreeModelLastResort(unavailableBalance, true, now), false);
    });

    it("requires free monthly balance to be positive and not reset", () => {
      const now = new Date("2026-07-31T12:00:00Z");
      const expiredBalance: OpenCodeZenBalance = {
        paidBalance: 0,
        freeMonthlyBalance: 50,
        monthlyResetAt: now.getTime() - 1000, // Already reset
        source: "cached-config",
      };

      assert.equal(canAttemptFreeModelLastResort(expiredBalance, true, now), false);

      const noFreeBalance: OpenCodeZenBalance = {
        paidBalance: 0,
        freeMonthlyBalance: 0,
        monthlyResetAt: now.getTime() + 24 * 60 * 60 * 1000,
        source: "cached-config",
      };

      assert.equal(canAttemptFreeModelLastResort(noFreeBalance, true, now), false);
    });

    it("allows free-model last resort only when all conditions are met", () => {
      const now = new Date("2026-07-31T12:00:00Z");
      const goodBalance: OpenCodeZenBalance = {
        paidBalance: 0,
        freeMonthlyBalance: 50,
        monthlyResetAt: now.getTime() + 24 * 60 * 60 * 1000,
        source: "cached-config",
      };
      assert.equal(canAttemptFreeModelLastResort(goodBalance, true, now), true);
    });
  });
});
