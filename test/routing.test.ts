import { test } from "node:test";
import assert from "node:assert/strict";
import { assessCapacity, type CapacityAssessment } from "../src/capacity.ts";
import { modelByLabel, type ModelEntry } from "../src/models.ts";
import {
  BASE_ROUTE_MATRIX,
  DEFAULT_CHARACTERISTICS,
  ROUTING_RATIONALE,
  deriveEffort,
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
  assert.equal(cheap.selected!.modelLabel, "model:gpt-5.4-mini");

  const standard = routeIssue(chars({ issueType: "bug", businessRisk: "normal" }), capacity());
  assert.equal(standard.selected!.modelLabel, "model:claude-haiku-4.5");

  const hard = routeIssue(chars({ issueType: "ops", businessRisk: "destructive" }), capacity());
  assert.equal(hard.selected!.modelLabel, "model:claude-sonnet-5");
});

test("capacity is an availability constraint and close-cost tie-breaker", () => {
  const codexOnly = routeIssue(
    chars({ issueType: "docs", businessRisk: "normal" }),
    capacity({ exhausted: ["claude-subscription"] }),
  );
  assert.equal(codexOnly.selected!.modelLabel, "model:gpt-5.4-mini");
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
