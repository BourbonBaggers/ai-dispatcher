import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectClaudeTokenExhaustion,
  detectCodexTokenExhaustion,
  detectProviderTokenExhaustion,
  computeSuppressUntil,
  isProviderSuppressed,
  FALLBACK_SUPPRESSION_MS,
} from "../src/token-exhaustion.ts";

test("canonical |<epoch> form is detected on any stream", () => {
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
  // #245's own body says "usage limit reached" / "out of tokens" — the agent echoes it
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

test("computeSuppressUntil uses a reported future epoch verbatim", () => {
  const now = 1_000_000_000_000;
  const future = now + 3_600_000;
  const w = computeSuppressUntil({ resetAt: future, resetLabel: null }, now);
  assert.equal(w.parseFailed, false);
  assert.equal(w.until.getTime(), future);
});

test("computeSuppressUntil falls back to the safety window when nothing parses", () => {
  const now = 1_000_000_000_000;
  const w = computeSuppressUntil({ resetAt: null, wallClock: null, resetLabel: null }, now);
  assert.equal(w.parseFailed, true);
  assert.equal(w.until.getTime(), now + FALLBACK_SUPPRESSION_MS);
});

test("computeSuppressUntil resolves a wall-clock banner to a future instant", () => {
  const now = Date.UTC(2026, 0, 15, 6, 0, 0); // 06:00 UTC
  const w = computeSuppressUntil(
    { resetAt: null, wallClock: { hour: 4, minute: 0, timeZone: "UTC" }, resetLabel: "4am (UTC)" },
    now,
  );
  // 4am UTC already passed today → next day 4am UTC
  assert.equal(w.parseFailed, false);
  assert.equal(w.until.getTime(), Date.UTC(2026, 0, 16, 4, 0, 0));
});

test("isProviderSuppressed compares against the deadline", () => {
  const now = 1_000;
  assert.equal(isProviderSuppressed(new Date(2_000), now), true);
  assert.equal(isProviderSuppressed(new Date(500), now), false);
  assert.equal(isProviderSuppressed(null, now), false);
});
