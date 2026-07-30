import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assessCapacity,
  assessPools,
  capacityHeadroomForModel,
  isModelCapacityExhausted,
  isPoolExhausted,
  DORMANCY_IDLE_MS,
  poolScarcityMultiplier,
} from "../src/capacity.ts";

const NOW = 1_700_000_000_000;

test("an active cooldown reports exhausted with persisted-limit confidence", () => {
  const a = assessCapacity("claude-subscription", NOW + 60_000, NOW);
  assert.equal(a.state, "exhausted");
  assert.equal(a.confidence, "persisted-limit");
  assert.equal(a.resetAt, NOW + 60_000);
  assert.equal(a.dormant, false);
  assert.equal(a.lastActivityAt, null);
  assert.equal(isPoolExhausted(a), true);
});

test("a past cooldown is no longer exhausting", () => {
  const a = assessCapacity("claude-subscription", NOW - 60_000, NOW);
  assert.notEqual(a.state, "exhausted");
  assert.equal(isPoolExhausted(a), false);
});

test("no signal at all is honestly unknown but dormant", () => {
  const a = assessCapacity("codex-subscription", null, NOW);
  assert.equal(a.state, "unknown");
  assert.equal(a.confidence, "unknown");
  assert.equal(a.resetAt, null);
  assert.equal(a.lastActivityAt, null);
  // Absence of a cooldown is a routing preference (dormant) but never a fabricated
  // "available" — the state stays unknown.
  assert.equal(a.dormant, true);
});

test("usage observation raises confidence to estimated and drives dormancy", () => {
  // Active runs → not dormant.
  const busy = assessCapacity("claude-subscription", null, NOW, {
    lastActivityAt: NOW - 1000,
    activeRuns: 1,
  });
  assert.equal(busy.confidence, "estimated");
  assert.equal(busy.dormant, false);
  assert.equal(busy.lastActivityAt, NOW - 1000);

  // Recently used, no active runs → still active, not dormant.
  const recent = assessCapacity("claude-subscription", null, NOW, {
    lastActivityAt: NOW - (DORMANCY_IDLE_MS - 60_000),
    activeRuns: 0,
  });
  assert.equal(recent.dormant, false);

  // Idle beyond the threshold → dormant.
  const idle = assessCapacity("claude-subscription", null, NOW, {
    lastActivityAt: NOW - (DORMANCY_IDLE_MS + 60_000),
    activeRuns: 0,
  });
  assert.equal(idle.confidence, "estimated");
  assert.equal(idle.dormant, true);
  assert.equal(idle.lastActivityAt, NOW - (DORMANCY_IDLE_MS + 60_000));

  // Never used → dormant.
  const never = assessCapacity("claude-subscription", null, NOW, {
    lastActivityAt: null,
    activeRuns: 0,
  });
  assert.equal(never.dormant, true);
});

test("an active cooldown overrides usage — exhausted wins", () => {
  const a = assessCapacity("claude-subscription", NOW + 5000, NOW, {
    lastActivityAt: NOW - DORMANCY_IDLE_MS * 2,
    activeRuns: 0,
  });
  assert.equal(a.state, "exhausted");
  assert.equal(a.confidence, "persisted-limit");
});

test("assessPools builds a per-pool lookup", () => {
  const pools = ["claude-subscription", "codex-subscription"];
  const cooldowns = new Map<string, number | null>([["claude-subscription", NOW + 1000]]);
  const usage = new Map([["codex-subscription", { lastActivityAt: null, activeRuns: 0 }]]);
  const map = assessPools(pools, cooldowns, usage, NOW);
  assert.equal(map.get("claude-subscription")!.state, "exhausted");
  assert.equal(map.get("codex-subscription")!.confidence, "estimated");
  assert.equal(map.get("codex-subscription")!.dormant, true);
});

// ── unconfirmed cooldowns (#32) ─────────────────────────────────────────────────
// An unconfirmed, self-revalidating capacity signal must never be reported at the same
// confidence as a provider-reported reset — that would read as proven exhaustion.

test("an unconfirmed cooldown is exhausted but reported at unconfirmed-limit, not persisted-limit", () => {
  const a = assessCapacity("codex-subscription", NOW + 60_000, NOW, undefined, false);
  assert.equal(a.state, "exhausted");
  assert.equal(a.confidence, "unconfirmed-limit");
  assert.match(a.reason, /unconfirmed/);
  assert.equal(isPoolExhausted(a), true);
});

test("omitting authoritative defaults to true (proven), preserving prior behavior", () => {
  const a = assessCapacity("codex-subscription", NOW + 60_000, NOW);
  assert.equal(a.confidence, "persisted-limit");
});

test("assessPools threads per-pool authoritative flags", () => {
  const pools = ["claude-subscription", "codex-subscription"];
  const cooldowns = new Map<string, number | null>([
    ["claude-subscription", NOW + 1000],
    ["codex-subscription", NOW + 1000],
  ]);
  const authoritative = new Map([["codex-subscription", false]]);
  const map = assessPools(pools, cooldowns, new Map(), NOW, authoritative);
  assert.equal(map.get("claude-subscription")!.confidence, "persisted-limit");
  assert.equal(map.get("codex-subscription")!.confidence, "unconfirmed-limit");
});

test("fresh affirmative live evidence supersedes a stale unconfirmed cooldown", () => {
  const assessment = assessCapacity(
    "codex-subscription",
    NOW + 5 * 60 * 60 * 1000,
    NOW,
    undefined,
    false,
    {
      pool: "codex-subscription",
      confidence: "cli-reported",
      observedAt: NOW,
      windows: [{ name: "five-hour", usedPercent: 20, resetAt: NOW + 60_000 }],
      reason: "Codex reported current limits",
    },
  );
  assert.equal(assessment.state, "available");
  assert.equal(assessment.confidence, "cli-reported");
  assert.equal(assessment.headroomPercent, 80);
});

test("model-specific windows constrain only their matching model", () => {
  const assessment = assessCapacity("claude-subscription", null, NOW, undefined, true, {
    pool: "claude-subscription",
    confidence: "provider-reported",
    observedAt: NOW,
    windows: [
      { name: "five-hour", usedPercent: 30, resetAt: NOW + 60_000 },
      {
        name: "opus-week",
        usedPercent: 100,
        resetAt: NOW + 120_000,
        modelLabels: ["model:claude-opus-4.8"],
      },
    ],
    reason: "Anthropic reported current limits",
  });
  assert.equal(capacityHeadroomForModel(assessment, "model:claude-sonnet-5"), 70);
  assert.equal(capacityHeadroomForModel(assessment, "model:claude-opus-4.8"), 0);
  assert.equal(isModelCapacityExhausted(assessment, "model:claude-sonnet-5"), false);
  assert.equal(isModelCapacityExhausted(assessment, "model:claude-opus-4.8"), true);
});

// ── Scarcity weighting (#51 follow-up) ───────────────────────────────────────────
//
// Exhausting a provider window can remove the pool for days, so scarcity has to be able
// to override a modest price difference — but only near the limit. Routine consumption
// must not perturb routing, or the dispatcher chases quota jitter instead of picking the
// cheapest adequate model.

function poolAt(usedPercent: number, dormant = false) {
  return {
    pool: "p",
    state: "available" as const,
    confidence: "provider-reported" as const,
    resetAt: null,
    dormant,
    lastActivityAt: NOW,
    observedAt: NOW,
    windows: [{ name: "five-hour", usedPercent, resetAt: null }],
    headroomPercent: 100 - usedPercent,
    reason: "test",
  };
}

test("scarcity stays neutral through routine consumption", () => {
  for (const used of [0, 25, 50]) {
    const m = poolScarcityMultiplier(poolAt(used), "model:x");
    assert.ok(m < 1.2, `${used}% spent produced x${m}, which would perturb routing`);
  }
});

test("scarcity climbs steeply once a window is nearly spent", () => {
  assert.ok(poolScarcityMultiplier(poolAt(80), "model:x") > 3);
  assert.ok(poolScarcityMultiplier(poolAt(95), "model:x") > 8);
});

test("scarcity is monotonic in consumption", () => {
  let previous = 0;
  for (const used of [0, 10, 30, 50, 70, 90, 100]) {
    const m = poolScarcityMultiplier(poolAt(used), "model:x");
    assert.ok(m >= previous, `x${m} at ${used}% is below the previous rung`);
    previous = m;
  }
});

// An unknown reading must never be optimistic, and must never be a fabricated estimate.
test("an absent capacity assessment is neutral, not free", () => {
  assert.equal(poolScarcityMultiplier(undefined, "model:x"), 1);
});

test("dormancy is only a tie-break, never a quota estimate", () => {
  const noReading = { ...poolAt(0), windows: [], headroomPercent: null, dormant: true };
  const m = poolScarcityMultiplier(noReading, "model:x");
  assert.ok(m > 0.9 && m < 1, `dormant tie-break x${m} is too strong to be a tie-break`);
});
