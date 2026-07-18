import { test } from "node:test";
import assert from "node:assert/strict";
import { assessCapacity, type CapacityAssessment } from "../src/capacity.ts";
import { modelByLabel, type ModelEntry } from "../src/models.ts";
import {
  parseCharacteristics,
  deriveMinimumTier,
  routeIssue,
  planNextAttempt,
  DEFAULT_CHARACTERISTICS,
  ROUTING_RATIONALE,
  HUMAN_OVERRIDE_LABEL,
  type IssueCharacteristics,
} from "../src/routing.ts";

const NOW = 1_700_000_000_000;
const M = (label: string): ModelEntry => modelByLabel(label)!;

/** Build a pool→assessment map. `exhausted` pools get an active cooldown. */
function capacity(opts: { exhausted?: string[]; dormant?: string[]; busy?: string[] }): Map<string, CapacityAssessment> {
  const pools = ["claude-subscription", "codex-subscription", "gemini-free"];
  const map = new Map<string, CapacityAssessment>();
  for (const pool of pools) {
    if (opts.exhausted?.includes(pool)) {
      map.set(pool, assessCapacity(pool, NOW + 60_000, NOW));
    } else if (opts.busy?.includes(pool)) {
      map.set(pool, assessCapacity(pool, null, NOW, { lastActivityAt: NOW - 1000, activeRuns: 1 }));
    } else {
      // dormant/available by default
      map.set(pool, assessCapacity(pool, null, NOW));
    }
  }
  return map;
}

const chars = (over: Partial<IssueCharacteristics> = {}): IssueCharacteristics => ({
  ...DEFAULT_CHARACTERISTICS,
  ...over,
});

test("deriveMinimumTier: complexity is the primary driver", () => {
  assert.equal(deriveMinimumTier(chars({ complexity: "trivial" })), "fast");
  assert.equal(deriveMinimumTier(chars({ complexity: "simple" })), "fast");
  assert.equal(deriveMinimumTier(chars({ complexity: "moderate" })), "general");
  assert.equal(deriveMinimumTier(chars({ complexity: "complex" })), "complex");
});

test("deriveMinimumTier: risk and reasoning raise the floor; frontier is the ceiling", () => {
  assert.equal(deriveMinimumTier(chars({ complexity: "trivial", risk: "high" })), "complex");
  assert.equal(deriveMinimumTier(chars({ complexity: "simple", reasoningDepth: "deep" })), "complex");
  // frontier only when complex AND high-risk AND deep reasoning all coincide
  assert.equal(
    deriveMinimumTier(chars({ complexity: "complex", risk: "high", reasoningDepth: "deep" })),
    "frontier",
  );
  // any one short of the ceiling stays at complex
  assert.equal(deriveMinimumTier(chars({ complexity: "complex", risk: "high", reasoningDepth: "moderate" })), "complex");
});

test("deriveMinimumTier: requirements quality does NOT change the tier", () => {
  const base = deriveMinimumTier(chars({ complexity: "moderate", requirementsQuality: "good" }));
  const poor = deriveMinimumTier(chars({ complexity: "moderate", requirementsQuality: "poor" }));
  assert.equal(base, poor); // requirements feed confidence, not tier
});

test("parseCharacteristics reads labels and defaults the rest", () => {
  const c = parseCharacteristics(["complexity:complex", "risk:high", "task:refactor", "junk"]);
  assert.equal(c.complexity, "complex");
  assert.equal(c.risk, "high");
  assert.equal(c.taskType, "refactor");
  assert.equal(c.contextSize, DEFAULT_CHARACTERISTICS.contextSize); // unlabelled → default
  // an out-of-vocabulary value falls back to the default
  assert.equal(parseCharacteristics(["complexity:galactic"]).complexity, DEFAULT_CHARACTERISTICS.complexity);
});

test("routeIssue picks the minimum viable model", () => {
  const trivial = routeIssue(chars({ complexity: "trivial" }), capacity({}));
  assert.equal(trivial.selected!.modelLabel, "model:claude-haiku-4.5");
  assert.ok(trivial.rationaleLabels.includes(ROUTING_RATIONALE.minViable));

  const moderate = routeIssue(chars({ complexity: "moderate" }), capacity({}));
  assert.equal(moderate.selected!.modelLabel, "model:claude-sonnet-5");
});

test("routeIssue withholds frontier unless justified", () => {
  // complex work: min viable is complex tier — opus (frontier) stays withheld.
  const complex = routeIssue(chars({ complexity: "complex" }), capacity({}));
  assert.equal(complex.selected!.tier, "complex");
  assert.equal(complex.selected!.frontier, false);
  const opusAlt = complex.alternatives.find((a) => a.modelLabel === "model:claude-opus-4.8")!;
  assert.equal(opusAlt.eligible, false);
  assert.match(opusAlt.reason, /withheld/);

  // ceiling work: frontier is justified and selected.
  const frontier = routeIssue(
    chars({ complexity: "complex", risk: "high", reasoningDepth: "deep" }),
    capacity({}),
  );
  assert.equal(frontier.selected!.modelLabel, "model:claude-opus-4.8");
  assert.ok(frontier.rationaleLabels.includes(ROUTING_RATIONALE.frontierJustified));
});

test("routeIssue drops exhausted capacity and flags capacity-constrained", () => {
  // Claude pool down: a moderate (general) issue can't use sonnet, so it rises to the
  // codex complex lane and is flagged capacity-constrained.
  const d = routeIssue(chars({ complexity: "moderate" }), capacity({ exhausted: ["claude-subscription"] }));
  assert.equal(d.selected!.modelLabel, "model:gpt-5.5");
  assert.ok(d.rationaleLabels.includes(ROUTING_RATIONALE.capacityConstrained));
});

test("routeIssue requires a large-context model for large-context work", () => {
  const d = routeIssue(chars({ complexity: "moderate", contextSize: "large" }), capacity({}));
  assert.equal(d.selected!.modelLabel, "model:claude-sonnet-5"); // the only large-context lane
  const gptAlt = d.alternatives.find((a) => a.modelLabel === "model:gpt-5.5")!;
  assert.match(gptAlt.reason, /large-context/);
});

test("routeIssue returns no selection when nothing capable is available", () => {
  const d = routeIssue(
    chars({ complexity: "moderate" }),
    capacity({ exhausted: ["claude-subscription", "codex-subscription"] }),
  );
  assert.equal(d.selected, null);
  assert.equal(d.confidence, "low");
  assert.match(d.reason, /non-frontier/);
});

test("routeIssue prefers dormant capacity in the rationale", () => {
  const d = routeIssue(chars({ complexity: "moderate" }), capacity({})); // claude dormant
  assert.ok(d.rationaleLabels.includes(ROUTING_RATIONALE.dormantCapacity));
  // when the chosen pool is busy, the dormant rationale is absent
  const busy = routeIssue(chars({ complexity: "moderate" }), capacity({ busy: ["claude-subscription"] }));
  assert.ok(!busy.rationaleLabels.includes(ROUTING_RATIONALE.dormantCapacity));
});

test("HUMAN_OVERRIDE_LABEL is a stable exported constant", () => {
  assert.equal(HUMAN_OVERRIDE_LABEL, "route:human-override");
});

// ── planNextAttempt ────────────────────────────────────────────────────────────

test("transient failure retries the same model when its pool is up", () => {
  const p = planNextAttempt("transient", M("model:gpt-5.5"), capacity({}));
  assert.equal(p.action, "retry-same");
  assert.equal(p.model!.modelLabel, "model:gpt-5.5");
  assert.equal(p.requiresHumanApproval, false);
});

test("usage-limit hands off to comparable capacity at another provider", () => {
  // Synthetic two-pool comparable set so the handoff branch is exercised directly.
  const a: ModelEntry = { ...M("model:gpt-5.5") };
  const b: ModelEntry = {
    ...M("model:gpt-5.5"),
    modelLabel: "model:other-complex",
    cliModel: "other-complex",
    capacityPool: "other-pool",
    fallbacks: [],
  };
  const cap = new Map<string, CapacityAssessment>([
    ["codex-subscription", assessCapacity("codex-subscription", NOW + 1000, NOW)], // a exhausted
    ["other-pool", assessCapacity("other-pool", null, NOW)], // b dormant
  ]);
  const p = planNextAttempt("usage-limit", a, cap, [a, b]);
  assert.equal(p.action, "handoff");
  assert.equal(p.model!.modelLabel, "model:other-complex");
});

test("implementation failure escalates exactly one tier", () => {
  const fromFast = planNextAttempt("implementation-failure", M("model:claude-haiku-4.5"), capacity({}));
  assert.equal(fromFast.action, "escalate-tier");
  assert.equal(fromFast.model!.tier, "general");

  const fromGeneral = planNextAttempt("test-failure", M("model:claude-sonnet-5"), capacity({}));
  assert.equal(fromGeneral.action, "escalate-tier");
  assert.equal(fromGeneral.model!.modelLabel, "model:gpt-5.5");
});

test("escalation to frontier requires human approval", () => {
  const p = planNextAttempt("implementation-failure", M("model:gpt-5.5"), capacity({}));
  assert.equal(p.action, "escalate-frontier");
  assert.equal(p.model!.modelLabel, "model:claude-opus-4.8");
  assert.equal(p.requiresHumanApproval, true);
});

test("context exhaustion hands off to large-context capacity", () => {
  const p = planNextAttempt("context-exhaustion", M("model:claude-haiku-4.5"), capacity({}));
  assert.equal(p.action, "handoff");
  assert.equal(p.model!.modelLabel, "model:claude-sonnet-5");
});

test("requirements block and human intervention hold for a human", () => {
  for (const cat of ["requirements-block", "human-intervention"] as const) {
    const p = planNextAttempt(cat, M("model:gpt-5.5"), capacity({}));
    assert.equal(p.action, "hold");
    assert.equal(p.model, null);
  }
});

test("a failure at the top tier hands off rather than inventing a stronger tier", () => {
  const p = planNextAttempt("implementation-failure", M("model:claude-opus-4.8"), capacity({}));
  assert.equal(p.action, "handoff");
  assert.equal(p.model!.modelLabel, "model:gpt-5.5"); // opus's fallback
});
