import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectClaudeTokenExhaustion,
  detectCodexTokenExhaustion,
  detectProviderTokenExhaustion,
  computeCapacityDecision,
  resolveCapacitySuppression,
  isProviderSuppressed,
  suppressesPool,
  CLAUDE_ROLLING_WINDOW_FALLBACK_MS,
  UNCONFIRMED_QUOTA_REVALIDATION_MS,
  THROTTLE_REVALIDATION_MS,
  BILLING_REVALIDATION_MS,
} from "../src/token-exhaustion.ts";

// ── detection ─────────────────────────────────────────────────────────────────

test("canonical |<epoch> form is detected on any stream and classified authoritative", () => {
  const epochSec = 2_000_000_000;
  const sig = detectClaudeTokenExhaustion(`Claude AI usage limit reached|${epochSec}`, "stdout");
  assert.ok(sig);
  assert.equal(sig!.resetAt, epochSec * 1000);
});

test("the real subscription banner is detected on plain stdout", () => {
  const sig = detectClaudeTokenExhaustion(
    "You've hit your session limit · resets 4am (UTC)",
    "stdout",
  );
  assert.ok(sig);
  assert.equal(sig!.resetLabel, "4am (UTC)");
  assert.ok(sig!.wallClock);
  assert.equal(sig!.wallClock!.hour, 4);
  assert.equal(sig!.kind, "unconfirmed-quota");
});

test("banner surfaces via an assistant stream-json event", () => {
  const event = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: "You've reached your weekly limit, resets 11pm CST" }] },
  });
  const sig = detectClaudeTokenExhaustion(event, "stdout");
  assert.ok(sig);
  assert.equal(sig!.resetLabel, "11pm CST");
});

test("issue text echoed as a tool_result never trips detection", () => {
  // The issue body says "usage limit reached" / "out of tokens" — the agent echoes it
  // when it runs `gh issue view`. That lands in a user/tool_result event, never scanned.
  const echoed = JSON.stringify({
    type: "user",
    message: {
      content: [
        { type: "tool_result", content: "The issue says: out of tokens, usage limit reached." },
      ],
    },
  });
  assert.equal(detectClaudeTokenExhaustion(echoed, "stdout"), null);
  // and the same prose as a plain assistant sentence (broad phrase, not the banner) is safe
  const assistantProse = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: "The issue mentions being out of tokens." }] },
  });
  assert.equal(detectClaudeTokenExhaustion(assistantProse, "stdout"), null);
  // ...and the same holds for the new categories (billing/throttling/context prose)
  const billingProse = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: "The issue is about insufficient credits handling." }] },
  });
  assert.equal(detectClaudeTokenExhaustion(billingProse, "stdout"), null);
  const canonicalLookingToolResult = JSON.stringify({
    type: "user",
    message: {
      content: [{ type: "tool_result", content: "Claude AI usage limit reached|2000000000" }],
    },
  });
  assert.equal(detectClaudeTokenExhaustion(canonicalLookingToolResult, "stdout"), null);
});

test("broad exhaustion phrase is trusted on stderr and in is_error results", () => {
  assert.ok(detectClaudeTokenExhaustion("Error: you are out of tokens", "stderr"));
  const errResult = JSON.stringify({
    type: "result",
    is_error: true,
    result: "insufficient quota",
  });
  assert.ok(detectClaudeTokenExhaustion(errResult, "stdout"));
});

test("ordinary output is not detected", () => {
  assert.equal(detectClaudeTokenExhaustion("running npm test now", "stdout"), null);
  assert.equal(detectCodexTokenExhaustion("compiling sources", "stdout"), null);
});

test("codex quota error via a structured error event is detected, prose is not", () => {
  const err = JSON.stringify({ type: "error", message: "usage limit reached for this account" });
  assert.ok(detectCodexTokenExhaustion(err, "stdout"));
  const prose = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: "out of tokens is what the issue mentions" }] },
  });
  assert.equal(detectCodexTokenExhaustion(prose, "stdout"), null);
  const failedTurn = JSON.stringify({
    type: "turn.failed",
    error: { message: "usage limit reached for this account" },
  });
  const signal = detectCodexTokenExhaustion(failedTurn, "stdout");
  assert.equal(signal?.source, "structured-error");
});

test("Codex repository output on stderr or in JSONL item events cannot manufacture capacity", () => {
  // Incident #38: Codex printed a source fixture containing this exact line on stderr.
  assert.equal(
    detectCodexTokenExhaustion('  excerpt: "usage limit reached",', "stderr"),
    null,
  );
  assert.equal(
    detectCodexTokenExhaustion(
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "command_execution",
          aggregated_output: 'fixture = { excerpt: "usage limit reached" }',
        },
      }),
      "stdout",
    ),
    null,
  );
});

test("detectProviderTokenExhaustion routes by agent", () => {
  assert.ok(detectProviderTokenExhaustion("claude", "hit your usage limit", "stdout"));
  assert.ok(
    detectProviderTokenExhaustion(
      "codex",
      JSON.stringify({ type: "error", message: "out of credits" }),
      "stdout",
    ),
  );
});

// ── kind classification ──────────────────────────────────────────────────────

test("throttling/rate-limit phrases classify as throttling, not a quota exhaustion", () => {
  const sig = detectCodexTokenExhaustion(
    JSON.stringify({ type: "error", message: "rate limited: too many requests, please slow down" }),
    "stdout",
  );
  assert.ok(sig);
  assert.equal(sig!.kind, "throttling");
});

test("context/request-size phrases classify as context-exhaustion", () => {
  const sig = detectClaudeTokenExhaustion("Error: maximum context length exceeded for this request", "stderr");
  assert.ok(sig);
  assert.equal(sig!.kind, "context-exhaustion");
});

test("billing/credit phrases classify as billing, not a generic quota error", () => {
  const sig = detectCodexTokenExhaustion(
    JSON.stringify({ type: "error", message: "insufficient credits — please add a payment method" }),
    "stdout",
  );
  assert.ok(sig);
  assert.equal(sig!.kind, "billing");
});

test("an unrecognized-but-quota-like error still detects, classified unconfirmed-quota", () => {
  const sig = detectClaudeTokenExhaustion("Error: token budget exceeded for this session", "stderr");
  assert.ok(sig);
  assert.equal(sig!.kind, "unconfirmed-quota");
});

test("suppressesPool excludes only context-exhaustion", () => {
  assert.equal(suppressesPool("context-exhaustion"), false);
  for (const kind of ["authoritative-exhaustion", "unconfirmed-quota", "throttling", "billing", "unknown"] as const) {
    assert.equal(suppressesPool(kind), true, kind);
  }
});

// ── suppression policy ───────────────────────────────────────────────────────

test("a reported future epoch is authoritative regardless of which phrase matched", () => {
  const now = 1_000_000_000_000;
  const future = now + 3_600_000;
  const decision = computeCapacityDecision("codex", { kind: "unconfirmed-quota", resetAt: future, resetLabel: null, excerpt: "" }, now);
  assert.equal(decision.authoritative, true);
  assert.equal(decision.kind, "authoritative-exhaustion");
  assert.equal(decision.until.getTime(), future);
});

test("a reported wall-clock reset resolves to a future instant and is authoritative", () => {
  const now = Date.UTC(2026, 0, 15, 6, 0, 0); // 06:00 UTC
  const decision = computeCapacityDecision(
    "claude",
    { kind: "unconfirmed-quota", resetAt: null, wallClock: { hour: 4, minute: 0, timeZone: "UTC" }, resetLabel: "4am (UTC)", excerpt: "" },
    now,
  );
  // 4am UTC already passed today → next day 4am UTC
  assert.equal(decision.authoritative, true);
  assert.equal(decision.until.getTime(), Date.UTC(2026, 0, 16, 4, 0, 0));
});

test("Codex, no reset: bounded near-term revalidation, NOT the Claude rolling-window fallback", () => {
  const now = 1_000_000_000_000;
  const decision = computeCapacityDecision(
    "codex",
    { kind: "unconfirmed-quota", resetAt: null, wallClock: null, resetLabel: null, excerpt: "usage limit reached" },
    now,
  );
  assert.equal(decision.authoritative, false);
  assert.equal(decision.until.getTime(), now + UNCONFIRMED_QUOTA_REVALIDATION_MS);
  assert.notEqual(decision.until.getTime(), now + CLAUDE_ROLLING_WINDOW_FALLBACK_MS);
});

test("Claude, no reset: the documented rolling-window fallback still applies (Claude-only)", () => {
  const now = 1_000_000_000_000;
  const decision = computeCapacityDecision(
    "claude",
    { kind: "unconfirmed-quota", resetAt: null, wallClock: null, resetLabel: null, excerpt: "usage limit reached" },
    now,
  );
  assert.equal(decision.authoritative, false);
  assert.equal(decision.until.getTime(), now + CLAUDE_ROLLING_WINDOW_FALLBACK_MS);
});

test("throttling gets its own short backoff regardless of provider", () => {
  const now = 1_000_000_000_000;
  for (const agent of ["claude", "codex"] as const) {
    const decision = computeCapacityDecision(agent, { kind: "throttling", resetAt: null, resetLabel: null, excerpt: "" }, now);
    assert.equal(decision.until.getTime(), now + THROTTLE_REVALIDATION_MS, agent);
    assert.equal(decision.authoritative, false);
  }
});

test("billing gets its own distinct window, not the rolling-window number or the short quota window", () => {
  const now = 1_000_000_000_000;
  const decision = computeCapacityDecision("claude", { kind: "billing", resetAt: null, resetLabel: null, excerpt: "" }, now);
  assert.equal(decision.until.getTime(), now + BILLING_REVALIDATION_MS);
  assert.notEqual(BILLING_REVALIDATION_MS, CLAUDE_ROLLING_WINDOW_FALLBACK_MS);
  assert.notEqual(BILLING_REVALIDATION_MS, UNCONFIRMED_QUOTA_REVALIDATION_MS);
});

test("isProviderSuppressed compares against the deadline", () => {
  const now = 1_000;
  assert.equal(isProviderSuppressed(new Date(2_000), now), true);
  assert.equal(isProviderSuppressed(new Date(500), now), false);
  assert.equal(isProviderSuppressed(null, now), false);
});

// ── resolution: reconciliation with run/artifact evidence ───────────────────

test("resolveCapacitySuppression keeps token_exhausted when the run has no complete evidence", () => {
  const now = 1_000_000_000_000;
  const resolution = resolveCapacitySuppression(
    "codex",
    { kind: "unconfirmed-quota", resetAt: null, resetLabel: null, excerpt: "usage limit reached" },
    { resultCommits: 0, resultCi: "none", prNumber: null },
    now,
  );
  assert.equal(resolution.status, "token_exhausted");
  assert.match(resolution.summary, /Codex/);
  assert.match(resolution.summary, /unconfirmed/);
  assert.equal(resolution.evidence.authoritative, false);
  assert.equal(resolution.evidence.until, now + UNCONFIRMED_QUOTA_REVALIDATION_MS);
});

test("resolveCapacitySuppression reconciles to pr_ready when commits + PR + green CI already exist", () => {
  const now = 1_000_000_000_000;
  const resolution = resolveCapacitySuppression(
    "codex",
    { kind: "unconfirmed-quota", resetAt: null, resetLabel: null, excerpt: "usage limit reached" },
    { resultCommits: 5, resultCi: "pass", prNumber: 31 },
    now,
  );
  assert.equal(resolution.status, "pr_ready");
  assert.match(resolution.summary, /already complete/);
  // The suppression evidence is still produced — capacity state stays separate from
  // whether THIS run's own artifact is complete.
  assert.equal(resolution.evidence.until, now + UNCONFIRMED_QUOTA_REVALIDATION_MS);
});

test("resolveCapacitySuppression does NOT reconcile on green CI alone — commits and a PR are required too", () => {
  const now = 1_000_000_000_000;
  const noCommits = resolveCapacitySuppression(
    "codex",
    { kind: "unconfirmed-quota", resetAt: null, resetLabel: null, excerpt: "" },
    { resultCommits: 0, resultCi: "pass", prNumber: 31 },
    now,
  );
  assert.equal(noCommits.status, "token_exhausted");

  const noPr = resolveCapacitySuppression(
    "codex",
    { kind: "unconfirmed-quota", resetAt: null, resetLabel: null, excerpt: "" },
    { resultCommits: 2, resultCi: "pass", prNumber: null },
    now,
  );
  assert.equal(noPr.status, "token_exhausted");
});

test("resolveCapacitySuppression with an authoritative reset reports it, not the safety fallback wording", () => {
  const now = 1_000_000_000_000;
  const resetAt = now + 3_600_000;
  const resolution = resolveCapacitySuppression(
    "claude",
    { kind: "unconfirmed-quota", resetAt, resetLabel: "4am (UTC)", excerpt: "" },
    { resultCommits: 0, resultCi: "none", prNumber: null },
    now,
  );
  assert.equal(resolution.evidence.until, resetAt);
  assert.equal(resolution.evidence.authoritative, true);
  assert.match(resolution.summary, /Claude/);
  assert.match(resolution.summary, /4am \(UTC\)/);
  assert.doesNotMatch(resolution.summary, /unconfirmed/);
});
