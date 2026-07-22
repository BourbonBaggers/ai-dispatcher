import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseMergeTreeConflictPaths,
  repairGeneratedFileConflicts,
} from "../src/generated-conflict-repair.ts";
import type { ExecFn, ExecResult } from "../src/exec.ts";

function ok(stdout = ""): ExecResult {
  return { ok: true, stdout, stderr: "", code: 0 };
}

function fail(stdout = "", stderr = "", code = 1): ExecResult {
  return { ok: false, stdout, stderr, code };
}

describe("parseMergeTreeConflictPaths", () => {
  it("extracts conflict paths from merge-tree --name-only output", () => {
    assert.deepEqual(
      parseMergeTreeConflictPaths(
        [
          "7751ef82d2f469b0c6efca0daa8e1918b0470bc9",
          "docs/memory.md",
          "docs/researcher.md",
          "",
        ].join("\n"),
      ),
      ["docs/memory.md", "docs/researcher.md"],
    );
  });
});

describe("repairGeneratedFileConflicts", () => {
  function request() {
    return {
      repoSlug: "o/r",
      pr: 42,
      baseRefName: "main",
      headRefName: "issue-4-x",
      allowlistedPaths: ["docs/memory.md", "docs/researcher.md"],
      regenerationCommand: "npm run docs:generate",
      maxAttempts: 1,
    };
  }

  it("rebuilds and pushes a generated-conflict repair branch", async () => {
    const calls: Array<{ file: string; args: string[]; stdin?: string }> = [];
    const exec: ExecFn = async (file, args, options) => {
      calls.push(options?.stdin === undefined ? { file, args } : { file, args, stdin: options.stdin });
      if (args.includes("merge-tree")) {
        return fail("abc123\n\ndocs/memory.md\n", "", 1);
      }
      if (args.includes("diff")) return ok("diff --git a/src/x.ts b/src/x.ts\n+export const x = 1;\n");
      if (args.includes("status")) return ok("M  src/x.ts\nM  docs/memory.md\n");
      if (args.includes("rev-parse")) return ok("cafebabe\n");
      return ok();
    };

    const result = await repairGeneratedFileConflicts(request(), exec);
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.commit, "cafebabe");

    const diff = calls.find((call) => call.args.includes("diff"));
    assert.ok(diff);
    assert.ok(diff.args.includes(":(exclude)docs/memory.md"));
    assert.ok(!diff.args.includes(":(exclude)src/x.ts"));

    assert.ok(calls.some((call) => call.file === "bash" && call.args.includes("npm run docs:generate")));
    assert.ok(
      calls.some(
        (call) =>
          call.args.includes("push") &&
          call.args.includes("--force-with-lease") &&
          call.args.includes("HEAD:issue-4-x"),
      ),
    );
  });

  it("refuses when a source file is also conflicted", async () => {
    const exec: ExecFn = async (_file, args) => {
      if (args.includes("merge-tree")) {
        return fail("abc123\n\ndocs/memory.md\nsrc/dispatcher.ts\n", "", 1);
      }
      return ok();
    };

    const result = await repairGeneratedFileConflicts(request(), exec);
    assert.equal(result.ok, false);
    assert.deepEqual(!result.ok && result.conflictPaths, ["docs/memory.md", "src/dispatcher.ts"]);
    assert.match(!result.ok ? result.reason : "", /not on the generated-file allowlist/);
  });
});
