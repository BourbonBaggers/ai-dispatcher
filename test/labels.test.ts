import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveAssignment,
  resolvePriorityTier,
  branchNameFor,
} from "../src/labels.ts";

test("resolveAssignment maps a valid claude pair to CLI values", () => {
  const r = resolveAssignment(["agent:claude", "model:claude-opus-4.8"]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.ok && r.value, {
    agent: "claude",
    modelLabel: "model:claude-opus-4.8",
    cliModel: "claude-opus-4-8",
    effortLabel: "effort:medium", // default when no effort label
    cliEffort: "medium",
  });
});

test("resolveAssignment maps a valid codex pair", () => {
  const r = resolveAssignment(["agent:codex", "model:gpt-5.5", "effort:high"]);
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.value.cliModel, "gpt-5.5");
  assert.equal(r.ok && r.value.cliEffort, "high");
});

test("effort:max caps codex at high but gives claude xhigh", () => {
  const codex = resolveAssignment(["agent:codex", "model:gpt-5.5", "effort:max"]);
  assert.equal(codex.ok && codex.value.cliEffort, "high");
  const claude = resolveAssignment(["agent:claude", "model:claude-opus-4.8", "effort:max"]);
  assert.equal(claude.ok && claude.value.cliEffort, "xhigh");
});

test("resolveAssignment rejects missing / conflicting / cross-agent labels", () => {
  assert.equal(resolveAssignment([]).ok, false);
  assert.equal(resolveAssignment(["model:gpt-5.5"]).ok, false); // no agent
  assert.equal(resolveAssignment(["agent:codex"]).ok, false); // no model
  assert.equal(resolveAssignment(["agent:codex", "agent:claude", "model:gpt-5.5"]).ok, false);
  assert.equal(
    resolveAssignment(["agent:codex", "model:gpt-5.5", "model:claude-opus-4.8"]).ok,
    false,
  );
  // a claude model on a codex issue
  const cross = resolveAssignment(["agent:codex", "model:claude-opus-4.8"]);
  assert.equal(cross.ok, false);
  assert.match(cross.ok === false ? cross.reason : "", /claude model but the issue is labeled/);
});

test("resolveAssignment rejects unknown model and conflicting effort labels", () => {
  assert.equal(resolveAssignment(["agent:codex", "model:gpt-9"]).ok, false);
  assert.equal(
    resolveAssignment(["agent:codex", "model:gpt-5.5", "effort:low", "effort:high"]).ok,
    false,
  );
  assert.equal(resolveAssignment(["agent:codex", "model:gpt-5.5", "effort:turbo"]).ok, false);
});

test("resolvePriorityTier honours queue jump then technical debt then regular", () => {
  assert.equal(resolvePriorityTier(["queue jump"]), "queue-jump");
  assert.equal(resolvePriorityTier(["technical debt"]), "technical-debt");
  assert.equal(resolvePriorityTier([]), "regular");
  // queue jump wins over technical debt
  assert.equal(resolvePriorityTier(["queue jump", "technical debt"]), "queue-jump");
});

test("branchNameFor produces a safe, stable ref from an untrusted title", () => {
  assert.equal(
    branchNameFor(42, "Add the Frobnicator! (v2)"),
    "issue-42-add-the-frobnicator-v2",
  );
  // a title of only punctuation collapses to just the issue number
  assert.equal(branchNameFor(7, "!!!"), "issue-7");
  // long titles are truncated to a bounded slug
  const long = branchNameFor(9, "x".repeat(200));
  assert.ok(long.length <= "issue-9-".length + 50);
  assert.match(long, /^issue-9-x+$/);
});
