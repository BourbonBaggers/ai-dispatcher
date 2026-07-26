import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  POLICY_CLEANUP_INSTRUCTION_FILES,
  parsePolicyCleanupVerdict,
  policyCleanupPrompt,
  resolvePolicyCleanupConfig,
} from "../src/policy-cleanup.ts";

describe("resolvePolicyCleanupConfig", () => {
  it("accepts a known dispatchable model, including a frontier model", () => {
    const result = resolvePolicyCleanupConfig("claude-opus-4-8");
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.value.model.cliModel, "claude-opus-4-8");
  });

  it("rejects an unknown model", () => {
    const result = resolvePolicyCleanupConfig("not-a-real-model");
    assert.equal(result.ok, false);
  });
});

describe("policyCleanupPrompt", () => {
  it("includes the canonical policy and reports a missing file as absent", () => {
    const prompt = policyCleanupPrompt({
      canonicalPolicy: "CANONICAL TEXT",
      files: [
        { path: "AGENTS.md", content: "some agents content" },
        { path: "CLAUDE.md", content: null },
      ],
    });
    assert.match(prompt, /CANONICAL TEXT/);
    assert.match(prompt, /"path":"AGENTS\.md"/);
    assert.match(prompt, /"exists":true/);
    assert.match(prompt, /"exists":false/);
  });
});

describe("parsePolicyCleanupVerdict", () => {
  const allowed = [...POLICY_CLEANUP_INSTRUCTION_FILES];

  it("accepts a clean verdict with no conflicts", () => {
    const result = parsePolicyCleanupVerdict(
      JSON.stringify({ conflicts: false, summary: "no conflicts found", files: [] }),
      allowed,
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.verdict.conflicts, false);
      assert.deepEqual(result.verdict.files, []);
    }
  });

  it("accepts a conflicting verdict with rewritten file content", () => {
    const result = parsePolicyCleanupVerdict(
      JSON.stringify({
        conflicts: true,
        summary: "AGENTS.md told agents to merge their own PRs",
        files: [{ path: "AGENTS.md", content: "# Agents\n\nRewritten." }],
      }),
      allowed,
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.verdict.files.length, 1);
      assert.equal(result.verdict.files[0]!.path, "AGENTS.md");
    }
  });

  it("rejects invalid JSON", () => {
    const result = parsePolicyCleanupVerdict("not json", allowed);
    assert.equal(result.ok, false);
  });

  it("rejects a missing conflicts field", () => {
    const result = parsePolicyCleanupVerdict(JSON.stringify({ summary: "x", files: [] }), allowed);
    assert.equal(result.ok, false);
  });

  it("rejects a missing or blank summary", () => {
    const result = parsePolicyCleanupVerdict(
      JSON.stringify({ conflicts: false, summary: "  ", files: [] }),
      allowed,
    );
    assert.equal(result.ok, false);
  });

  it("rejects an out-of-scope path", () => {
    const result = parsePolicyCleanupVerdict(
      JSON.stringify({
        conflicts: true,
        summary: "x",
        files: [{ path: "README.md", content: "rewritten" }],
      }),
      allowed,
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /out-of-scope/);
  });

  it("rejects a duplicate path", () => {
    const result = parsePolicyCleanupVerdict(
      JSON.stringify({
        conflicts: true,
        summary: "x",
        files: [
          { path: "AGENTS.md", content: "one" },
          { path: "AGENTS.md", content: "two" },
        ],
      }),
      allowed,
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /more than once/);
  });

  it("rejects empty content for a changed file", () => {
    const result = parsePolicyCleanupVerdict(
      JSON.stringify({ conflicts: true, summary: "x", files: [{ path: "AGENTS.md", content: "  " }] }),
      allowed,
    );
    assert.equal(result.ok, false);
  });

  it("rejects conflicts:true with no proposed files", () => {
    const result = parsePolicyCleanupVerdict(
      JSON.stringify({ conflicts: true, summary: "x", files: [] }),
      allowed,
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /proposed no file changes/);
  });

  it("rejects conflicts:false with proposed files", () => {
    const result = parsePolicyCleanupVerdict(
      JSON.stringify({
        conflicts: false,
        summary: "x",
        files: [{ path: "AGENTS.md", content: "y" }],
      }),
      allowed,
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /without reporting conflicts/);
  });
});
