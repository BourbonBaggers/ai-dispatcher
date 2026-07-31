import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type {
  OpenCodeAttemptTelemetry,
  ExhaustionRecoveryEvent,
} from "../src/opencode-telemetry.ts";

describe("opencode-telemetry", () => {
  describe("OpenCodeAttemptTelemetry", () => {
    it("can be constructed with paid attempt details", () => {
      const now = Date.now();
      const telemetry: OpenCodeAttemptTelemetry = {
        providerLane: "opencode-zen",
        selectedModel: "model:opencode-glm-5.2",
        routeTier: "capable",
        effortLabel: "effort:medium",
        fallbackTriggerWindow: "5-hour",
        primaryProvidersExhaustedFor: {
          provider1: "anthropic",
          provider2: "openai",
          window: "5-hour",
          bothConfirmed: true,
        },
        isPaidAttempt: true,
        priceSnapshot: {
          inputUsdPerMillion: 2,
          outputUsdPerMillion: 10,
          source: "opencode-zen-glm",
          effectiveFrom: "2026-01-01",
        },
        zenBalanceAtAttempt: {
          paidBalance: 500,
          freeMonthlyBalance: 100,
          source: "cached-config",
        },
        providerReportedUsage: {
          tokensUsed: 125_000,
          creditsCost: 0.25,
          source: "provider-api",
        },
        billedAmount: {
          amount: 0.25,
          currency: "USD",
        },
      };

      assert.equal(telemetry.providerLane, "opencode-zen");
      assert.equal(telemetry.selectedModel, "model:opencode-glm-5.2");
      assert.equal(telemetry.routeTier, "capable");
      assert.equal(telemetry.isPaidAttempt, true);
      assert(telemetry.primaryProvidersExhaustedFor.bothConfirmed);
    });

    it("can be constructed with free-model last-resort details", () => {
      const telemetry: OpenCodeAttemptTelemetry = {
        providerLane: "opencode-zen",
        selectedModel: "model:opencode-deepseek-v4-flash-free",
        routeTier: "standard",
        effortLabel: "effort:medium",
        fallbackTriggerWindow: "monthly",
        primaryProvidersExhaustedFor: {
          provider1: "anthropic",
          provider2: "openai",
          window: "monthly",
          bothConfirmed: true,
        },
        isPaidAttempt: false,
        freeModelLastResort: "model:opencode-deepseek-v4-flash-free",
        priceSnapshot: null,
        zenBalanceAtAttempt: {
          paidBalance: 0,
          freeMonthlyBalance: 50,
          source: "cached-config",
        },
        providerReportedUsage: null,
        billedAmount: null,
      };

      assert.equal(telemetry.isPaidAttempt, false);
      assert.equal(telemetry.freeModelLastResort, "model:opencode-deepseek-v4-flash-free");
      assert.equal(telemetry.priceSnapshot, null);
    });
  });

  describe("ExhaustionRecoveryEvent", () => {
    it("records when exhaustion fallback is activated", () => {
      const now = Date.now();
      const event: ExhaustionRecoveryEvent = {
        issueNumber: 42,
        timestamp: now,
        exhaustionWindow: "5-hour",
        primaryProviders: ["anthropic", "openai"],
        fallbackProvider: "opencode",
        selectedModel: "model:opencode-glm-5.2",
        isPaidAttempt: true,
        detailedReason:
          "both Codex and Claude exhausted for 5-hour window; Zen balance available",
      };

      assert.equal(event.issueNumber, 42);
      assert.equal(event.fallbackProvider, "opencode");
      assert.equal(event.primaryProviders.length, 2);
      assert(event.primaryProviders.includes("anthropic"));
      assert(event.primaryProviders.includes("openai"));
    });
  });
});
