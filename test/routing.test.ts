import { test } from "node:test";
import assert from "node:assert/strict";
import { assessCapacity, type CapacityAssessment } from "../src/capacity.ts";
import { modelByLabel, type ModelEntry } from "../src/models.ts";
import {
  parseCharacteristics,
  deriveMinimumTier,
  deriveEffort,
  hasRecoverabilityDiscount,
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
function capacity(opts: {
  exhausted?: string[];
  busy?: string[];
  lastActivityAt?: Partial<Record<string, number | null>>;
  headroom?: Partial<Record<string, number>>;
}): Map<string, CapacityAssessment> {
  const pools = ["claude-subscription", "codex-subscription", "gemini-free"];
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
    } else if (opts.busy?.includes(pool)) {
      map.set(pool, assessCapacity(pool, null, NOW, { lastActivityAt: NOW - 1000, activeRuns: 1 }));
    } else if (Object.hasOwn(opts.lastActivityAt ?? {}, pool)) {
      map.set(
        pool,
        assessCapacity(pool, null, NOW, {
          lastActivityAt: opts.lastActivityAt?.[pool] ?? null,
          activeRuns: 0,
        }),
      );
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

test("deriveMinimumTier: general is the default and fast requires a complete execution package", () => {
  assert.equal(deriveMinimumTier(chars({ complexity: "trivial" })), "general");
  assert.equal(deriveMinimumTier(chars({ complexity: "simple" })), "general");
  assert.equal(deriveMinimumTier(chars({ complexity: "moderate" })), "general");
  assert.equal(deriveMinimumTier(chars({ complexity: "complex" })), "complex");
  assert.equal(
    deriveMinimumTier(
      chars({
        complexity: "simple",
        risk: "low",
        ambiguity: "clear",
        requirementsQuality: "good",
        reasoningDepth: "shallow",
        verificationStrength: "strong",
      }),
    ),
    "fast",
  );
});

test("deriveMinimumTier: residual uncertainty raises the floor", () => {
  assert.equal(deriveMinimumTier(chars({ complexity: "trivial", risk: "high" })), "complex");
  assert.equal(deriveMinimumTier(chars({ complexity: "simple", reasoningDepth: "deep" })), "complex");
  assert.equal(deriveMinimumTier(chars({ ambiguity: "high" })), "complex");
  assert.equal(deriveMinimumTier(chars({ requirementsQuality: "poor" })), "complex");
});

test("deriveMinimumTier: frontier requires severe uncertainty and weak safeguards", () => {
  assert.equal(
    deriveMinimumTier(
      chars({
        complexity: "complex",
        risk: "high",
        reasoningDepth: "deep",
        ambiguity: "high",
        verificationStrength: "weak",
      }),
    ),
    "frontier",
  );
  assert.equal(
    deriveMinimumTier(
      chars({
        complexity: "complex",
        risk: "high",
        reasoningDepth: "deep",
        ambiguity: "clear",
        requirementsQuality: "good",
        verificationStrength: "strong",
        recoverability: "high",
      }),
    ),
    "complex",
  );
});

test("deriveMinimumTier: poor requirements raise residual uncertainty instead of buying a stronger default", () => {
  const base = deriveMinimumTier(chars({ complexity: "moderate", requirementsQuality: "adequate" }));
  const poor = deriveMinimumTier(chars({ complexity: "moderate", requirementsQuality: "poor" }));
  assert.equal(base, "general");
  assert.equal(poor, "complex");
});

test("deriveMinimumTier discounts one tier only when verification and recovery are strong", () => {
  const recoverable = chars({
    complexity: "complex",
    requirementsQuality: "good",
    ambiguity: "some",
    verificationStrength: "strong",
    recoverability: "high",
  });
  assert.equal(hasRecoverabilityDiscount(recoverable), true);
  assert.equal(deriveMinimumTier(recoverable), "general");

  assert.equal(
    deriveMinimumTier({ ...recoverable, verificationStrength: "standard" }),
    "complex",
  );
  assert.equal(
    deriveMinimumTier({ ...recoverable, recoverability: "medium" }),
    "complex",
  );
  assert.equal(
    deriveMinimumTier({ ...recoverable, ambiguity: "high" }),
    "complex",
  );
});

test("deriveMinimumTier protects frontier when a failed first attempt is costly", () => {
  const ceiling = chars({
    complexity: "complex",
    risk: "high",
    reasoningDepth: "deep",
    ambiguity: "high",
    verificationStrength: "weak",
    recoverability: "low",
  });
  assert.equal(deriveMinimumTier(ceiling), "frontier");
  assert.equal(
    deriveMinimumTier({
      ...ceiling,
      requirementsQuality: "good",
      ambiguity: "some",
      reasoningDepth: "moderate",
      risk: "medium",
      verificationStrength: "strong",
      recoverability: "high",
    }),
    "general",
  );
});

test("deriveEffort is provider-neutral and independent from capacity", () => {
  assert.equal(
    deriveEffort(
      chars({
        complexity: "simple",
        contextSize: "small",
        risk: "low",
        ambiguity: "clear",
        requirementsQuality: "good",
        reasoningDepth: "shallow",
        verificationStrength: "strong",
      }),
    ).effortLabel,
    "effort:low",
  );
  assert.equal(deriveEffort(chars()).effortLabel, "effort:medium");
  assert.equal(
    deriveEffort(chars({ complexity: "complex", contextSize: "large" })).effortLabel,
    "effort:high",
  );
  assert.equal(
    deriveEffort(
      chars({
        complexity: "complex",
        risk: "high",
        ambiguity: "high",
        reasoningDepth: "deep",
        verificationStrength: "weak",
        recoverability: "low",
      }),
    ).effortLabel,
    "effort:max",
  );
});

test("parseCharacteristics reads labels and defaults the rest", () => {
  const c = parseCharacteristics([
    "complexity:complex",
    "risk:high",
    "task:refactor",
    "verification:strong",
    "recoverability:high",
    "junk",
  ]);
  assert.equal(c.complexity, "complex");
  assert.equal(c.risk, "high");
  assert.equal(c.taskType, "refactor");
  assert.equal(c.verificationStrength, "strong");
  assert.equal(c.recoverability, "high");
  assert.equal(c.contextSize, DEFAULT_CHARACTERISTICS.contextSize); // unlabelled → default
  // an out-of-vocabulary value falls back to the default
  assert.equal(parseCharacteristics(["complexity:galactic"]).complexity, DEFAULT_CHARACTERISTICS.complexity);
});

test("routeIssue picks the minimum viable model", () => {
  const trivial = routeIssue(
    chars({
      complexity: "trivial",
      risk: "low",
      ambiguity: "clear",
      requirementsQuality: "good",
      reasoningDepth: "shallow",
      verificationStrength: "strong",
    }),
    capacity({}),
  );
  assert.equal(trivial.selected!.modelLabel, "model:claude-haiku-4.5");
  assert.ok(trivial.rationaleLabels.includes(ROUTING_RATIONALE.minViable));

  const moderate = routeIssue(chars({ complexity: "moderate" }), capacity({}));
  assert.equal(moderate.selected!.modelLabel, "model:claude-sonnet-5");
});

test("routeIssue starts a recoverable complex issue on the general lane", () => {
  const d = routeIssue(
    chars({
      complexity: "complex",
      requirementsQuality: "good",
      verificationStrength: "strong",
      recoverability: "high",
    }),
    capacity({}),
  );
  assert.equal(d.selected!.modelLabel, "model:claude-sonnet-5");
  assert.ok(d.rationaleLabels.includes(ROUTING_RATIONALE.recoverabilityDiscount));
  assert.ok(d.determiningFactors.some((factor) => /complex → general/.test(factor)));
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
    chars({
      complexity: "complex",
      risk: "high",
      reasoningDepth: "deep",
      ambiguity: "high",
      verificationStrength: "weak",
    }),
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

test("routeIssue balances general work using constrained live headroom", () => {
  const codexTurn = routeIssue(
    chars({ complexity: "moderate" }),
    capacity({
      headroom: {
        "claude-subscription": 20,
        "codex-subscription": 70,
      },
    }),
  );
  assert.equal(codexTurn.selected!.modelLabel, "model:gpt-5.5");
  assert.equal(codexTurn.capacitySelection, "live-headroom");
  assert.ok(!codexTurn.rationaleLabels.includes(ROUTING_RATIONALE.capacityConstrained));

  const claudeTurn = routeIssue(
    chars({ complexity: "moderate" }),
    capacity({
      headroom: {
        "claude-subscription": 80,
        "codex-subscription": 25,
      },
    }),
  );
  assert.equal(claudeTurn.selected!.modelLabel, "model:claude-sonnet-5");
});

test("routeIssue rotates deterministically when headroom is close or incomparable", () => {
  const close = capacity({
    headroom: {
      "claude-subscription": 55,
      "codex-subscription": 50,
    },
  });
  const codex = routeIssue(chars(), close, undefined, {
    rotationCursor: "claude-subscription",
  });
  assert.equal(codex.selected!.modelLabel, "model:gpt-5.5");
  assert.equal(codex.capacitySelection, "rotation");

  const claude = routeIssue(chars(), capacity({}), undefined, {
    rotationCursor: "codex-subscription",
  });
  assert.equal(claude.selected!.modelLabel, "model:claude-sonnet-5");
  assert.equal(claude.capacitySelection, "rotation");
});

test("routeIssue does not send fast work two tiers up merely to rotate pools", () => {
  const d = routeIssue(
    chars({
      complexity: "simple",
      risk: "low",
      ambiguity: "clear",
      requirementsQuality: "good",
      reasoningDepth: "shallow",
      verificationStrength: "strong",
    }),
    capacity({
      lastActivityAt: {
        "claude-subscription": NOW - 1_000,
        "codex-subscription": null,
      },
    }),
  );
  assert.equal(d.selected!.modelLabel, "model:claude-haiku-4.5");
  assert.match(
    d.alternatives.find((alt) => alt.modelLabel === "model:gpt-5.5")!.reason,
    /more than one tier/,
  );
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

test("routeIssue records portfolio balance when deterministic rotation chooses a pool", () => {
  const rotated = routeIssue(chars(), capacity({}), undefined, {
    rotationCursor: "claude-subscription",
  });
  assert.equal(rotated.selected!.modelLabel, "model:gpt-5.5");
  assert.ok(rotated.rationaleLabels.includes(ROUTING_RATIONALE.portfolioBalance));
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

test("escalation to frontier is the final automatic attempt", () => {
  const p = planNextAttempt("implementation-failure", M("model:gpt-5.5"), capacity({}));
  assert.equal(p.action, "escalate-frontier");
  assert.equal(p.model!.modelLabel, "model:claude-opus-4.8");
  assert.equal(p.requiresHumanApproval, false);
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

test("a failure at the frontier holds because automation is exhausted", () => {
  const p = planNextAttempt("implementation-failure", M("model:claude-opus-4.8"), capacity({}));
  assert.equal(p.action, "hold");
  assert.equal(p.model, null);
  assert.match(p.rationale, /automation exhausted/);
});
