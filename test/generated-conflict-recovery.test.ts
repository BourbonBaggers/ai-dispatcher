import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_GENERATED_CONFLICT_ALLOWLIST,
  DEFAULT_MAX_GENERATED_CONFLICT_RECOVERIES,
  decideGeneratedConflictRecovery,
  parseGeneratedConflictAllowlist,
} from "../src/generated-conflict-recovery.ts";

describe("parseGeneratedConflictAllowlist", () => {
  it("uses the default generated bookkeeping files when unset", () => {
    assert.deepEqual(parseGeneratedConflictAllowlist(undefined), [
      "docs/memory.md",
      "docs/researcher.md",
    ]);
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

  it("allows conflicts that are entirely generated files", () => {
    const decision = decideGeneratedConflictRecovery(
      ["docs/researcher.md", "docs/memory.md"],
      policy,
      0,
    );
    assert.equal(decision.recoverable, true);
    assert.deepEqual(decision.recoverablePaths, ["docs/memory.md", "docs/researcher.md"]);
    assert.deepEqual(decision.refusedPaths, []);
  });

  it("refuses mixed generated and source-code conflicts", () => {
    const decision = decideGeneratedConflictRecovery(
      ["docs/memory.md", "src/dispatcher.ts"],
      policy,
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

