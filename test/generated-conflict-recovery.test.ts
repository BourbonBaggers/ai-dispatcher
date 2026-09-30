import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_GENERATED_CONFLICT_ALLOWLIST,
  DEFAULT_MAX_GENERATED_CONFLICT_RECOVERIES,
  decideGeneratedConflictRecovery,
  parseGeneratedConflictAllowlist,
} from "../src/generated-conflict-recovery.ts";

describe("parseGeneratedConflictAllowlist", () => {
  it("has no assumed generated files when unset", () => {
    assert.deepEqual(parseGeneratedConflictAllowlist(undefined), []);
    assert.deepEqual(DEFAULT_GENERATED_CONFLICT_ALLOWLIST, []);
  });

  it("normalizes, deduplicates, and rejects unsafe repo paths", () => {
    assert.deepEqual(
      parseGeneratedConflictAllowlist(" docs/./memory.md,src/x.ts,../secret,/abs/path,src/x.ts "),
      ["docs/memory.md", "src/x.ts"],
    );
  });
});

describe("decideGeneratedConflictRecovery", () => {
  const policy = {
    allowlistedPaths: DEFAULT_GENERATED_CONFLICT_ALLOWLIST,
    maxAttempts: DEFAULT_MAX_GENERATED_CONFLICT_RECOVERIES,
  };

  it("allows conflicts only when explicitly configured", () => {
    const decision = decideGeneratedConflictRecovery(
      ["docs/researcher.md", "docs/memory.md"],
      { ...policy, allowlistedPaths: ["docs/researcher.md", "docs/memory.md"] },
      0,
    );
    assert.equal(decision.recoverable, true);
    assert.deepEqual(decision.recoverablePaths, ["docs/memory.md", "docs/researcher.md"]);
    assert.deepEqual(decision.refusedPaths, []);
  });

  it("refuses mixed generated and source-code conflicts", () => {
    const decision = decideGeneratedConflictRecovery(
      ["docs/memory.md", "src/dispatcher.ts"],
      { ...policy, allowlistedPaths: ["docs/memory.md"] },
      0,
    );
    assert.equal(decision.recoverable, false);
    assert.deepEqual(decision.recoverablePaths, ["docs/memory.md"]);
    assert.deepEqual(decision.refusedPaths, ["src/dispatcher.ts"]);
  });

  it("refuses when no conflict paths are available", () => {
    const decision = decideGeneratedConflictRecovery([], policy, 0);
    assert.equal(decision.recoverable, false);
    assert.match(decision.reason, /no merge-conflict paths/);
  });

  it("refuses after the bounded recovery attempt is spent", () => {
    const decision = decideGeneratedConflictRecovery(["docs/memory.md"], policy, 1);
    assert.equal(decision.recoverable, false);
    assert.deepEqual(decision.refusedPaths, ["docs/memory.md"]);
    assert.match(decision.reason, /attempt limit/);
  });
});
