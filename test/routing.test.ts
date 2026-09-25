import { test } from "node:test";
import assert from "node:assert/strict";
import { assessCapacity, type CapacityAssessment } from "../src/capacity.ts";
import { modelByLabel, tierRank, type ModelEntry } from "../src/models.ts";
import {
  BASE_ROUTE_MATRIX,
  DEFAULT_CHARACTERISTICS,
  ROUTING_RATIONALE,
  deriveEffort,
  effortForRouteTier,
  deriveMinimumTier,
  hasRecoverabilityDiscount,
  parseCharacteristics,
  planNextAttempt,
  routeIssue,
  type IssueCharacteristics,
} from "../src/routing.ts";

const NOW = 1_700_000_000_000;
const M = (label: string): ModelEntry => modelByLabel(label)!;

function capacity(opts: {
  exhausted?: string[];
  headroom?: Partial<Record<string, number>>;
} = {}): Map<string, CapacityAssessment> {
  const pools = ["claude-subscription", "codex-subscription"];
  const map = new Map<string, CapacityAssessment>();
  for (const pool of pools) {
    if (opts.exhausted?.includes(pool)) {
      map.set(pool, assessCapacity(pool, NOW + 60_000, NOW));
    } else if (opts.headroom?.[pool] !== undefined) {
      map.set(
        pool,
        assessCapacity(pool, null, NOW, undefined, true, {
          pool,
          confidence: pool === "codex-subscription" ? "cli-reported" : "provider-reported",
          observedAt: NOW,
          windows: [
            {
              name: "constrained",
              usedPercent: 100 - opts.headroom[pool]!,
              resetAt: NOW + 60_000,
            },
          ],
          reason: "test capacity",
        }),
      );
    } else {
      map.set(pool, assessCapacity(pool, null, NOW));
    }
  }
  return map;
}

const chars = (over: Partial<IssueCharacteristics> = {}): IssueCharacteristics => ({
  ...DEFAULT_CHARACTERISTICS,
  ...over,
});

test("base type/risk matrix matches the issue contract", () => {
  assert.equal(BASE_ROUTE_MATRIX.docs["low-stakes"], "tiny");
  assert.equal(BASE_ROUTE_MATRIX.docs.normal, "cheap");
  assert.equal(BASE_ROUTE_MATRIX.docs.destructive, "standard");
  assert.equal(BASE_ROUTE_MATRIX.chore.destructive, "capable");
  assert.equal(BASE_ROUTE_MATRIX.bug.normal, "standard");
  assert.equal(BASE_ROUTE_MATRIX.enhancement.destructive, "capable");
  assert.equal(BASE_ROUTE_MATRIX.refactor.normal, "capable");
  assert.equal(BASE_ROUTE_MATRIX.ops.destructive, "hard");
  assert.equal(BASE_ROUTE_MATRIX.research.destructive, "hard");
});

test("parseCharacteristics reads new intake labels and tolerates legacy evidence", () => {
  const c = parseCharacteristics([
    "dispatch:ready",
    "type:bug",
    "priority:queue-jump",
    "risk:destructive",
    "complexity:complex",
    "verification:weak",
  ]);
  assert.equal(c.issueType, "bug");
  assert.equal(c.businessRisk, "destructive");
  assert.equal(c.complexity, "complex");
  assert.equal(c.verificationStrength, "weak");
});

test("priority does not change route or effort", () => {
  const normal = parseCharacteristics(["type:bug", "priority:normal", "risk:normal"]);
  const jump = parseCharacteristics(["type:bug", "priority:queue-jump", "risk:normal"]);
  assert.equal(deriveMinimumTier(normal), deriveMinimumTier(jump));
  assert.equal(deriveEffort(normal).effortLabel, deriveEffort(jump).effortLabel);
});

test("localized deterministic issues can down-route one level", () => {
  const c = chars({
    issueType: "bug",
    businessRisk: "normal",
    complexity: "trivial",
    contextSize: "small",
    ambiguity: "clear",
    requirementsQuality: "good",
    verificationStrength: "strong",
    recoverability: "high",
  });
  assert.equal(hasRecoverabilityDiscount(c), true);
  assert.equal(deriveMinimumTier(c), "cheap");
});

test("concrete workload evidence up-routes one non-frontier level", () => {
  assert.equal(
    deriveMinimumTier(chars({ issueType: "bug", businessRisk: "normal", contextSize: "large" })),
    "capable",
  );
});

test("poor requirements produce needs-input instead of expensive-model escalation", () => {
  const decision = routeIssue(
    chars({ issueType: "enhancement", businessRisk: "normal", requirementsQuality: "poor" }),
    capacity(),
  );
  assert.equal(decision.selected, null);
  assert.equal(decision.needsInput, true);
  assert.match(decision.reason, /needs-input/);
});

test("effort follows route economics", () => {
  assert.equal(deriveEffort(chars({ issueType: "docs", businessRisk: "low-stakes" })).effortLabel, "effort:low");
  assert.equal(deriveEffort(chars({ issueType: "bug", businessRisk: "normal" })).effortLabel, "effort:medium");
  assert.equal(deriveEffort(chars({ issueType: "ops", businessRisk: "destructive" })).effortLabel, "effort:high");
});

test("routeIssue uses lowest expected cost among adequate candidates", () => {
  const cheap = routeIssue(chars({ issueType: "docs", businessRisk: "normal" }), capacity());
  assert.equal(cheap.selected!.modelLabel, "model:gpt-6-luna");

  const standard = routeIssue(chars({ issueType: "bug", businessRisk: "normal" }), capacity());
  assert.equal(standard.selected!.modelLabel, "model:gpt-6-luna");

  const hard = routeIssue(chars({ issueType: "ops", businessRisk: "destructive" }), capacity());
  assert.equal(hard.selected!.modelLabel, "model:gpt-6-sol");
});

test("capacity is an availability constraint and close-cost tie-breaker", () => {
  const codexOnly = routeIssue(
    chars({ issueType: "docs", businessRisk: "normal" }),
    capacity({ exhausted: ["claude-subscription"] }),
  );
  assert.equal(codexOnly.selected!.modelLabel, "model:gpt-6-luna");
  assert.ok(codexOnly.rationaleLabels.includes(ROUTING_RATIONALE.minViable));
});

test("frontier and ultra-frontier are not normal defaults", () => {
  const destructive = routeIssue(chars({ issueType: "ops", businessRisk: "destructive" }), capacity());
  assert.notEqual(destructive.selected!.tier, "frontier");
  assert.equal(
    destructive.alternatives.find((alt) => alt.modelLabel === "model:claude-fable-5")!.eligible,
    false,
  );
});

test("transient recovery retries same model when capacity remains", () => {
  const p = planNextAttempt("transient", M("model:gpt-5.4-mini"), capacity());
  assert.equal(p.action, "retry-same");
  assert.equal(p.model!.modelLabel, "model:gpt-5.4-mini");
});

test("usage-limit recovery hands off laterally before frontier", () => {
  const p = planNextAttempt(
    "usage-limit",
    M("model:gpt-5.6-terra"),
    capacity({ exhausted: ["codex-subscription"] }),
  );
  assert.equal(p.action, "handoff");
  assert.equal(p.model!.modelLabel, "model:claude-sonnet-5");
});

test("implementation failure escalates one route and frontier failure holds", () => {
  const p = planNextAttempt("implementation-failure", M("model:gpt-5.6-luna"), capacity());
  assert.equal(p.action, "escalate-tier");
  assert.equal(p.model!.tier, "capable");

  const exhausted = planNextAttempt("test-failure", M("model:claude-opus-4.8"), capacity());
  assert.equal(exhausted.action, "hold");
});

test("implementation recovery climbs through the cheapest capable and frontier lanes", () => {
  const first = planNextAttempt("implementation-failure", M("model:claude-haiku-4.5"), capacity(), undefined, {
    routeTier: "standard",
  });
  assert.equal(first.model?.modelLabel, "model:gpt-6-sol");
  assert.equal(first.action, "escalate-tier");

  const second = planNextAttempt("implementation-failure", M("model:gpt-6-sol"), capacity(), undefined, {
    routeTier: "standard",
  });
  assert.equal(second.model?.modelLabel, "model:gpt-6-astra");
  assert.equal(second.action, "escalate-frontier");
});

test("implementation recovery climbs the Codex ladder when Claude capacity is unavailable", () => {
  const codexOnly = capacity({ exhausted: ["claude-subscription"] });
  const first = planNextAttempt("implementation-failure", M("model:gpt-5.4-mini"), codexOnly, undefined, {
    routeTier: "cheap",
  });
  assert.equal(first.model?.modelLabel, "model:gpt-6-luna");

  const second = planNextAttempt("implementation-failure", M("model:gpt-6-luna"), codexOnly, undefined, {
    routeTier: "cheap",
  });
  assert.equal(second.model?.modelLabel, "model:gpt-6-sol");

  const frontier = planNextAttempt("implementation-failure", M("model:gpt-6-sol"), codexOnly, undefined, {
    routeTier: "cheap",
  });
  assert.equal(frontier.model?.modelLabel, "model:gpt-6-astra");
  assert.equal(frontier.action, "escalate-frontier");
});

// ── Truthful rationale labels (#51 follow-up) ────────────────────────────────────
//
// These labels are the learning dataset's ground truth. Claiming that capacity or
// portfolio balance drove a plain cheapest-first pick poisons every later cost comparison,
// so each label must describe what actually decided the route.

function pool(usedPercent: number): CapacityAssessment {
  return {
    pool: "",
    state: "available",
    confidence: "provider-reported",
    resetAt: null,
    dormant: false,
    lastActivityAt: NOW,
    observedAt: NOW,
    windows: [{ name: "five-hour", usedPercent, resetAt: null }],
    headroomPercent: 100 - usedPercent,
    reason: "test",
  };
}

function pools(claudeUsed: number, codexUsed: number): Map<string, CapacityAssessment> {
  return new Map([
    ["claude-subscription", { ...pool(claudeUsed), pool: "claude-subscription" }],
    ["codex-subscription", { ...pool(codexUsed), pool: "codex-subscription" }],
  ]);
}

test("a healthy fleet routes cheapest-first and claims no capacity rationale", () => {
  const c = parseCharacteristics(["type:bug", "risk:normal"]);
  const d = routeIssue(c, pools(20, 20));
  assert.equal(d.capacitySelection, "lowest-burn");
  assert.ok(!d.rationaleLabels.includes(ROUTING_RATIONALE.portfolioBalance));
  assert.ok(!d.rationaleLabels.includes(ROUTING_RATIONALE.capacityConstrained));
});

test("a nearly-spent pool moves the pick and is labelled as portfolio balance", () => {
  const c = parseCharacteristics(["type:bug", "risk:normal"]);
  const healthy = routeIssue(c, pools(20, 20)).selected!;
  const strained = routeIssue(c, pools(20, 99));
  assert.notEqual(strained.selected!.modelLabel, healthy.modelLabel);
  assert.equal(strained.selected!.capacityPool, "claude-subscription");
  assert.equal(strained.capacitySelection, "scarcity-weighted");
  assert.ok(strained.rationaleLabels.includes(ROUTING_RATIONALE.portfolioBalance));
});

test("capacity-constrained is claimed only when a cheaper model was actually blocked", () => {
  const c = parseCharacteristics(["type:docs", "risk:normal"]);
  const open = routeIssue(c, capacity());
  assert.ok(!open.rationaleLabels.includes(ROUTING_RATIONALE.capacityConstrained));
  const blocked = routeIssue(c, capacity({ exhausted: ["codex-subscription"] }));
  assert.equal(blocked.selected!.capacityPool, "claude-subscription");
  assert.ok(blocked.rationaleLabels.includes(ROUTING_RATIONALE.capacityConstrained));
});

// Every base-matrix cell must resolve to a model. Before the tier ladder was filled,
// `cheap` and `hard` routes silently fell through to a neighbouring tier.
test("every base-matrix cell routes to a model that serves that exact tier", () => {
  for (const type of Object.keys(BASE_ROUTE_MATRIX) as (keyof typeof BASE_ROUTE_MATRIX)[]) {
    for (const risk of ["low-stakes", "normal", "destructive"] as const) {
      const c = parseCharacteristics([`type:${type}`, `risk:${risk}`]);
      const d = routeIssue(c, capacity());
      assert.ok(d.selected, `${type}/${risk} routed to nothing`);
      assert.ok(
        d.selected!.routeTiers.includes(d.minimumTier),
        `${type}/${risk}: ${d.selected!.modelLabel} does not serve ${d.minimumTier}`,
      );
    }
  }
});

// The assigned route floors the climb: a phase never repairs *below* the tier the issue
// was admitted at, even when its current rung happens to sit lower. The route is the
// record of what the issue was admitted as, not of what has already been tried, so it
// cannot also be the ceiling — see `phaseReachedFrontier` for where exhaustion is decided.
//
// The companion invariant — that a frontier model borrowed to repair one phase must not
// make the NEXT phase's ordinary repairs frontier attempts — is enforced by the caller
// passing each phase's own recorded rung. It is covered in test/dispatcher.test.ts by
// "a frontier rung in one phase leaves the next phase's repairs on the assigned model".
test("the assigned route floors the climb when the current rung sits below it", () => {
  const plan = planNextAttempt("test-failure", M("model:claude-haiku-4.5"), capacity(), undefined, {
    routeTier: "capable",
  });
  assert.ok(plan.model, "expected a next attempt");
  // Floored at the capable route, not one tier up from the rung's own tiny home tier —
  // an unfloored climb would have landed on standard.
  assert.ok(
    tierRank(plan.model!.tier) >= tierRank("capable"),
    `expected at least capable, got ${plan.model!.tier}`,
  );
  assert.ok(tierRank(plan.model!.tier) > tierRank("tiny"));
});

// A ladder that never terminates is worse than one that never climbs: the dispatcher
// would cycle between frontier models forever, spending the most expensive capacity it
// has and never reaching the exhaustion that pages a human. Deriving the climb from
// routeTier alone caused exactly that, because the route never advances.
test("the climb terminates at frontier instead of cycling between frontier models", () => {
  const seen: string[] = [];
  let current = M("model:claude-haiku-4.5");
  for (let i = 0; i < 12; i += 1) {
    const plan = planNextAttempt("implementation-failure", current, capacity(), undefined, {
      routeTier: "standard",
    });
    if (plan.action === "hold") break;
    assert.ok(plan.model, "a non-hold plan must name a model");
    assert.ok(
      tierRank(plan.model!.tier) > tierRank(current.tier),
      `rung ${i} went from ${current.tier} to ${plan.model!.tier} — the climb must be strictly upward`,
    );
    assert.ok(!seen.includes(plan.model!.cliModel), `revisited ${plan.model!.cliModel}`);
    seen.push(plan.model!.cliModel);
    current = plan.model!;
  }
  assert.equal(current.frontier, true, "the ladder must end on a frontier model");
  assert.equal(
    planNextAttempt("implementation-failure", current, capacity(), undefined, { routeTier: "standard" }).action,
    "hold",
    "a failed frontier rung exhausts automation",
  );
});

test("a frontier model that was assigned a frontier route still exhausts automation", () => {
  const plan = planNextAttempt("test-failure", M("model:claude-opus-4.8"), capacity(), undefined, {
    routeTier: "frontier",
  });
  assert.equal(plan.action, "hold");
  assert.equal(plan.model, null);
});

test("recovery prefers comparable capacity on the route, not a stronger tier", () => {
  const plan = planNextAttempt("usage-limit", M("model:claude-haiku-4.5"), capacity(), undefined, {
    routeTier: "standard",
  });
  assert.equal(plan.action, "handoff");
  assert.equal(plan.model!.capacityPool, "codex-subscription");
  assert.ok(plan.model!.routeTiers.includes("standard"));
});

test("effort follows the route tier for both pickup and recovery", () => {
  assert.equal(effortForRouteTier("tiny").effortLabel, "effort:low");
  assert.equal(effortForRouteTier("cheap").effortLabel, "effort:low");
  assert.equal(effortForRouteTier("standard").effortLabel, "effort:medium");
  assert.equal(effortForRouteTier("hard").effortLabel, "effort:high");
  assert.equal(effortForRouteTier("frontier").effortLabel, "effort:xhigh");
});

// Two dimensions share the `risk:` prefix during migration. Matching on the prefix alone
// made the result depend on label order and read a legacy risk:high issue as `normal`.
test("legacy risk:high does not masquerade as business risk normal", () => {
  const c = parseCharacteristics(["type:bug", "risk:high"]);
  assert.equal(c.risk, "high");
  assert.equal(c.businessRisk, "normal");
  const both = parseCharacteristics(["type:bug", "risk:high", "risk:destructive"]);
  assert.equal(both.businessRisk, "destructive");
  assert.equal(both.risk, "high");
  const reordered = parseCharacteristics(["type:bug", "risk:destructive", "risk:high"]);
  assert.equal(reordered.businessRisk, "destructive");
  assert.equal(reordered.risk, "high");
});
