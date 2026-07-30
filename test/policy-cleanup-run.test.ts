import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  runPolicyCleanup,
  type PolicyCleanupDeps,
  type PolicyCleanupGithub,
} from "../src/policy-cleanup.ts";
import type { ExecFn, ExecResult } from "../src/exec.ts";
import type { ModelEntry } from "../src/models.ts";

function ok(stdout = ""): ExecResult {
  return { ok: true, stdout, stderr: "", code: 0 };
}
function fail(stderr = "boom", code = 1): ExecResult {
  return { ok: false, stdout: "", stderr, code };
}

const model: ModelEntry = {
  modelLabel: "model:claude-opus-4.8",
  provider: "anthropic",
  cli: "claude",
  cliModel: "claude-opus-4-8",
  role: "frontier-reserve",
  tier: "frontier",
  frontier: true,
  taskClasses: [],
  contextWindow: 200_000,
  largeContext: false,
  capacityPool: "claude-subscription",
  fallbacks: [],
  listPrice: {
    standardContext: [
      {
        inputUsdPerMillion: 5,
        outputUsdPerMillion: 25,
        source: "test",
        effectiveFrom: "2026-01-01",
      },
    ],
  },
  enabled: true,
};

function harness(opts: {
  execScript?: (file: string, args: string[]) => ExecResult;
  modelStdout?: string;
  modelOk?: boolean;
  createPrResult?: number | null;
  files?: Record<string, string>;
}): {
  deps: PolicyCleanupDeps;
  execCalls: Array<{ file: string; args: string[] }>;
  createPrCalls: Array<{ base: string; head: string; title: string; body: string }>;
  writes: Record<string, string>;
} {
  const execCalls: Array<{ file: string; args: string[] }> = [];
  const writes: Record<string, string> = {};
  const files = opts.files ?? {};

  const exec: ExecFn = async (file, args) => {
    execCalls.push({ file, args });
    if (opts.execScript) return opts.execScript(file, args);
    if (args.includes("clone")) return ok();
    if (args.includes("rev-parse")) return ok("main\n");
    if (args.includes("status")) {
      const changed = Object.keys(writes)
        .map((path) => `M  ${path}`)
        .join("\n");
      return ok(changed ? `${changed}\n` : "");
    }
    return ok();
  };

  const createPrCalls: Array<{ base: string; head: string; title: string; body: string }> = [];
  const github: PolicyCleanupGithub = {
    createPullRequest: async (request) => {
      createPrCalls.push(request);
      return opts.createPrResult === undefined ? 99 : opts.createPrResult;
    },
  };

  const deps: PolicyCleanupDeps = {
    github,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    repoSlug: "acme/widgets",
    config: { model, cliEffort: "high" },
    exec,
    runModel: async () =>
      opts.modelOk === false ? fail("model exited nonzero") : ok(opts.modelStdout ?? ""),
    readCheckoutFile: async (_checkout, path) => files[path] ?? null,
    writeCheckoutFile: async (_checkout, path, content) => {
      writes[path] = content;
    },
  };

  return { deps, execCalls, createPrCalls, writes };
}

describe("runPolicyCleanup", () => {
  it("reports clean when the model finds no conflicts and creates no branch or PR", async () => {
    const { deps, execCalls, createPrCalls } = harness({
      modelStdout: JSON.stringify({ conflicts: false, summary: "no conflicts", files: [] }),
    });
    const result = await runPolicyCleanup(deps, { dryRun: false });
    assert.deepEqual(result, { action: "clean", summary: "no conflicts" });
    assert.equal(createPrCalls.length, 0);
    assert.ok(!execCalls.some((call) => call.args.includes("push")));
  });

  it("dry-run reports conflicts without writing, committing, or opening a PR", async () => {
    const { deps, createPrCalls, writes } = harness({
      modelStdout: JSON.stringify({
        conflicts: true,
        summary: "AGENTS.md instructed self-merge",
        files: [{ path: "AGENTS.md", content: "# rewritten" }],
      }),
    });
    const result = await runPolicyCleanup(deps, { dryRun: true });
    assert.deepEqual(result, {
      action: "dry_run",
      summary: "AGENTS.md instructed self-merge",
      paths: ["AGENTS.md"],
    });
    assert.equal(createPrCalls.length, 0);
    assert.deepEqual(writes, {});
  });

  it("writes, commits, pushes, and opens a PR when conflicts are found on a real run", async () => {
    const { deps, execCalls, createPrCalls, writes } = harness({
      modelStdout: JSON.stringify({
        conflicts: true,
        summary: "AGENTS.md instructed self-merge",
        files: [{ path: "AGENTS.md", content: "# rewritten AGENTS.md" }],
      }),
    });
    const result = await runPolicyCleanup(deps, { dryRun: false });
    assert.equal(result.action, "opened");
    if (result.action === "opened") {
      assert.equal(result.pr, 99);
      assert.deepEqual(result.paths, ["AGENTS.md"]);
    }
    assert.equal(writes["AGENTS.md"], "# rewritten AGENTS.md");
    assert.equal(createPrCalls.length, 1);
    assert.equal(createPrCalls[0]!.base, "main");
    assert.match(createPrCalls[0]!.head, /^dispatcher\/policy-cleanup-\d+$/);
    assert.ok(!/closes|fixes|resolves/i.test(createPrCalls[0]!.body));
    assert.ok(execCalls.some((call) => call.args.includes("push")));
    assert.ok(execCalls.some((call) => call.args.includes("commit")));
  });

  it("fails without publishing when the clone fails", async () => {
    const { deps, createPrCalls } = harness({
      execScript: (_file, args) => (args.includes("clone") ? fail("network error") : ok()),
    });
    const result = await runPolicyCleanup(deps, { dryRun: false });
    assert.equal(result.action, "failed");
    assert.equal(createPrCalls.length, 0);
  });

  it("fails when the model exits non-zero", async () => {
    const { deps } = harness({ modelOk: false });
    const result = await runPolicyCleanup(deps, { dryRun: false });
    assert.equal(result.action, "failed");
  });

  it("fails closed when the model verdict is invalid JSON", async () => {
    const { deps } = harness({ modelStdout: "not json" });
    const result = await runPolicyCleanup(deps, { dryRun: false });
    assert.equal(result.action, "failed");
  });

  it("aborts without publishing when the working tree shows out-of-scope changes", async () => {
    const { deps, createPrCalls } = harness({
      modelStdout: JSON.stringify({
        conflicts: true,
        summary: "x",
        files: [{ path: "AGENTS.md", content: "y" }],
      }),
      execScript: (_file, args) => {
        if (args.includes("clone") || args.includes("checkout")) return ok();
        if (args.includes("rev-parse")) return ok("main\n");
        if (args.includes("status")) return ok("M  AGENTS.md\nM  src/dispatcher.ts\n");
        return ok();
      },
    });
    const result = await runPolicyCleanup(deps, { dryRun: false });
    assert.equal(result.action, "failed");
    if (result.action === "failed") assert.match(result.reason, /out-of-scope/);
    assert.equal(createPrCalls.length, 0);
  });

  it("fails when push fails", async () => {
    const { deps } = harness({
      modelStdout: JSON.stringify({
        conflicts: true,
        summary: "x",
        files: [{ path: "AGENTS.md", content: "y" }],
      }),
      execScript: (_file, args) => {
        if (args.includes("push")) return fail("remote rejected");
        if (args.includes("rev-parse")) return ok("main\n");
        if (args.includes("status")) return ok("M  AGENTS.md\n");
        return ok();
      },
    });
    const result = await runPolicyCleanup(deps, { dryRun: false });
    assert.equal(result.action, "failed");
    if (result.action === "failed") assert.match(result.reason, /push failed/);
  });

  it("fails when PR creation fails", async () => {
    const { deps } = harness({
      modelStdout: JSON.stringify({
        conflicts: true,
        summary: "x",
        files: [{ path: "AGENTS.md", content: "y" }],
      }),
      createPrResult: null,
    });
    const result = await runPolicyCleanup(deps, { dryRun: false });
    assert.equal(result.action, "failed");
  });
});
