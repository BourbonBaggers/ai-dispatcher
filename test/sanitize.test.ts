import { test } from "node:test";
import assert from "node:assert/strict";
import { redact, toTerminalLines, parseControlLine } from "../src/sanitize.ts";

// ── control-line parsing ──────────────────────────────────────────────────────

test("::pid:: parses a positive integer and rejects garbage", () => {
  assert.deepEqual(parseControlLine("::pid:: 4321"), { kind: "pid", pid: 4321 });
  assert.equal(parseControlLine("::pid:: notanumber"), null);
  assert.equal(parseControlLine("::pid:: -5"), null);
});

test("::event:: keeps the message, dropping the leading ISO timestamp token", () => {
  const parsed = parseControlLine("::event:: 2026-07-17T00:00:00Z branch created off origin/main");
  assert.equal(parsed?.kind, "event");
  assert.equal(parsed?.message, "branch created off origin/main");
});

test("::result:: parses all fields, defaulting a missing/invalid ci to none", () => {
  const parsed = parseControlLine(
    "::result:: exit=0 pr=https://x/pull/9 commit=abc123 plan=docs/plans/p.md commits=3 ci=pass",
  );
  assert.equal(parsed?.kind, "result");
  assert.deepEqual(parsed?.result, {
    exit: 0,
    pr: "https://x/pull/9",
    commit: "abc123",
    plan: "docs/plans/p.md",
    commits: 3,
    ci: "pass",
  });
});

test("::result:: with an unknown ci token falls back to none, not a crash", () => {
  const parsed = parseControlLine("::result:: exit=1 pr= commit= plan= commits=0 ci=weird");
  assert.equal(parsed?.result?.ci, "none");
  assert.equal(parsed?.result?.exit, 1);
});

test("ordinary output is not mistaken for a control line", () => {
  assert.equal(parseControlLine("just some agent output"), null);
  assert.equal(parseControlLine("::not-a-real:: prefix"), null);
});

// ── redaction ─────────────────────────────────────────────────────────────────

test("redact scrubs common credential shapes an agent might echo", () => {
  assert.match(redact("token ghp_0123456789abcdef0123456789abcdef0123"), /REDACTED:github-token/);
  assert.match(redact("key sk-ant-0123456789abcdef0123456789"), /REDACTED:anthropic-key/);
  assert.match(
    redact("Authorization: Bearer abcdefghijklmnop0123456789"),
    /REDACTED:auth-header/,
  );
  assert.match(
    redact("postgres://user:supersecret@db:5432/app"),
    /postgres:\/\/user:\[REDACTED\]@/,
  );
});

test("redact leaves ordinary text untouched", () => {
  const text = "milestone(7): agent runner and capture net";
  assert.equal(redact(text), text);
});

// ── stream-json → terminal lines ──────────────────────────────────────────────

test("codex output passes through verbatim", () => {
  assert.deepEqual(toTerminalLines("plain codex line", "codex"), ["plain codex line"]);
});

test("a non-JSON claude line passes through unchanged", () => {
  assert.deepEqual(toTerminalLines("not json", "claude"), ["not json"]);
});

test("a claude system init event renders a session banner", () => {
  const line = JSON.stringify({ type: "system", subtype: "init", model: "claude-opus-4-8" });
  const out = toTerminalLines(line, "claude");
  assert.equal(out.length, 1);
  assert.match(out[0]!, /session started/);
  assert.match(out[0]!, /claude-opus-4-8/);
});

test("a claude assistant event renders text and tool-use lines", () => {
  const line = JSON.stringify({
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "Working on it" },
        { type: "tool_use", name: "Bash", input: { command: "npm test" } },
      ],
    },
  });
  const out = toTerminalLines(line, "claude");
  assert.deepEqual(out, ["Working on it", "● Bash: npm test"]);
});
