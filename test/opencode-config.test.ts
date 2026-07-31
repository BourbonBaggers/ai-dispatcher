import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isOpenCodeFallbackUsable,
  shouldRefreshBalance,
  updateBalance,
  validateOpenCodeConfig,
  type OpenCodeZenConfig,
} from "../src/opencode-config.ts";
import type { OpenCodeZenBalance } from "../src/exhaustion-state.ts";

describe("opencode-config", () => {
  describe("validateOpenCodeConfig", () => {
    it("validates config with API key and fallback enabled", () => {
      const env = {
        OPENCODE_API_KEY: "test-api-key-xyz",
        OPENCODE_FALLBACK_ENABLED: "true",
      };

      const result = validateOpenCodeConfig(env);

      assert(result.ok);
      assert.equal(result.value.apiKey, "test-api-key-xyz");
      assert.equal(result.value.fallbackEnabled, true);
    });

    it("rejects fallback enabled without API key", () => {
      const env = {
        OPENCODE_FALLBACK_ENABLED: "true",
      };

      const result = validateOpenCodeConfig(env);

      assert(!result.ok);
      assert.match(result.reason, /OPENCODE_API_KEY/);
    });

    it("allows fallback disabled without API key", () => {
      const env = {
        OPENCODE_FALLBACK_ENABLED: "false",
      };

      const result = validateOpenCodeConfig(env);

      assert(result.ok);
      assert.equal(result.value.apiKey, null);
      assert.equal(result.value.fallbackEnabled, false);
    });

    it("defaults to fallback disabled", () => {
      const env = {};

      const result = validateOpenCodeConfig(env);

      assert(result.ok);
      assert.equal(result.value.fallbackEnabled, false);
    });

    it("accepts variant spellings of enabled", () => {
      const result1 = validateOpenCodeConfig({
        OPENCODE_API_KEY: "key",
        OPENCODE_FALLBACK_ENABLED: "1",
      });
      assert(result1.ok && result1.value.fallbackEnabled);

      const result2 = validateOpenCodeConfig({
        OPENCODE_API_KEY: "key",
        OPENCODE_FALLBACK_ENABLED: "TRUE",
      });
      assert(result2.ok && result2.value.fallbackEnabled);
    });

    it("trims whitespace from environment variables", () => {
      const env = {
        OPENCODE_API_KEY: "  test-key  ",
        OPENCODE_FALLBACK_ENABLED: "  true  ",
      };

      const result = validateOpenCodeConfig(env);

      assert(result.ok);
      assert.equal(result.value.apiKey, "test-key");
      assert.equal(result.value.fallbackEnabled, true);
    });
  });

  describe("updateBalance", () => {
    it("updates balance information and refresh timestamp", () => {
      const now = new Date("2026-07-31T12:00:00Z");
      let config: OpenCodeZenConfig;

      const result = validateOpenCodeConfig({
        OPENCODE_API_KEY: "key",
        OPENCODE_FALLBACK_ENABLED: "true",
      });
      assert(result.ok);
      config = result.value;

      const newBalance: OpenCodeZenBalance = {
        paidBalance: 1000,
        freeMonthlyBalance: 100,
        monthlyResetAt: now.getTime() + 24 * 60 * 60 * 1000,
        source: "api-queried",
      };

      const updated = updateBalance(config, newBalance, now);

      assert.equal(updated.balance.paidBalance, 1000);
      assert.equal(updated.balanceRefreshedAt, now.getTime());
    });
  });

  describe("isOpenCodeFallbackUsable", () => {
    it("requires fallback enabled", () => {
      const config: OpenCodeZenConfig = {
        apiKey: "key",
        fallbackEnabled: false,
        maxFallbackAttemptsPerWindow: 3,
        balance: { paidBalance: 100, freeMonthlyBalance: 50, monthlyResetAt: null, source: "cached-config" },
        balanceRefreshedAt: null,
      };

      assert.equal(isOpenCodeFallbackUsable(config), false);
    });

    it("requires API key", () => {
      const config: OpenCodeZenConfig = {
        apiKey: null,
        fallbackEnabled: true,
        maxFallbackAttemptsPerWindow: 3,
        balance: { paidBalance: 100, freeMonthlyBalance: 50, monthlyResetAt: null, source: "cached-config" },
        balanceRefreshedAt: null,
      };

      assert.equal(isOpenCodeFallbackUsable(config), false);
    });

    it("is usable with fallback enabled and API key", () => {
      const config: OpenCodeZenConfig = {
        apiKey: "key",
        fallbackEnabled: true,
        maxFallbackAttemptsPerWindow: 3,
        balance: { paidBalance: 100, freeMonthlyBalance: 50, monthlyResetAt: null, source: "cached-config" },
        balanceRefreshedAt: null,
      };

      assert.equal(isOpenCodeFallbackUsable(config), true);
    });
  });

  describe("shouldRefreshBalance", () => {
    it("requires refresh when balance was never fetched", () => {
      const config: OpenCodeZenConfig = {
        apiKey: "key",
        fallbackEnabled: true,
        maxFallbackAttemptsPerWindow: 3,
        balance: { paidBalance: null, freeMonthlyBalance: null, monthlyResetAt: null, source: "unavailable" },
        balanceRefreshedAt: null,
      };

      assert.equal(shouldRefreshBalance(config), true);
    });

    it("does not refresh when recently fetched", () => {
      const now = new Date("2026-07-31T12:00:00Z");
      const recently = new Date(now.getTime() - 1 * 60 * 1000); // 1 minute ago

      const config: OpenCodeZenConfig = {
        apiKey: "key",
        fallbackEnabled: true,
        maxFallbackAttemptsPerWindow: 3,
        balance: { paidBalance: 100, freeMonthlyBalance: 50, monthlyResetAt: null, source: "api-queried" },
        balanceRefreshedAt: recently.getTime(),
      };

      assert.equal(shouldRefreshBalance(config, now), false);
    });

    it("requires refresh when balance is stale (>5 minutes)", () => {
      const now = new Date("2026-07-31T12:00:00Z");
      const old = new Date(now.getTime() - 6 * 60 * 1000); // 6 minutes ago

      const config: OpenCodeZenConfig = {
        apiKey: "key",
        fallbackEnabled: true,
        maxFallbackAttemptsPerWindow: 3,
        balance: { paidBalance: 100, freeMonthlyBalance: 50, monthlyResetAt: null, source: "api-queried" },
        balanceRefreshedAt: old.getTime(),
      };

      assert.equal(shouldRefreshBalance(config, now), true);
    });

    it("does not refresh without API key", () => {
      const config: OpenCodeZenConfig = {
        apiKey: null,
        fallbackEnabled: true,
        maxFallbackAttemptsPerWindow: 3,
        balance: { paidBalance: null, freeMonthlyBalance: null, monthlyResetAt: null, source: "unavailable" },
        balanceRefreshedAt: null,
      };

      assert.equal(shouldRefreshBalance(config), false);
    });

    it("respects custom maxAgeMs parameter", () => {
      const now = new Date("2026-07-31T12:00:00Z");
      const twoMinutesAgo = new Date(now.getTime() - 2 * 60 * 1000);

      const config: OpenCodeZenConfig = {
        apiKey: "key",
        fallbackEnabled: true,
        maxFallbackAttemptsPerWindow: 3,
        balance: { paidBalance: 100, freeMonthlyBalance: 50, monthlyResetAt: null, source: "api-queried" },
        balanceRefreshedAt: twoMinutesAgo.getTime(),
      };

      // 5 minute default: no refresh
      assert.equal(shouldRefreshBalance(config, now), false);

      // 1 minute max age: needs refresh
      assert.equal(shouldRefreshBalance(config, now, 1 * 60 * 1000), true);
    });
  });
});
