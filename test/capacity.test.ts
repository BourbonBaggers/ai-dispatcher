import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assessCapacity,
  assessPools,
  isPoolExhausted,
  DORMANCY_IDLE_MS,
} from "../src/capacity.ts";

const NOW = 1_700_000_000_000;

test("an active cooldown reports exhausted with persisted-limit confidence", () => {
  const a = assessCapacity("claude-subscription", NOW + 60_000, NOW);
  assert.equal(a.state, "exhausted");
  assert.equal(a.confidence, "persisted-limit");
  assert.equal(a.resetAt, NOW + 60_000);
  assert.equal(a.dormant, false);
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
