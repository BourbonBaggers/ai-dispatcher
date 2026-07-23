import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { autoshipRun, AUTOSHIP_HELD_LABEL, type AutoshipDeps } from "../src/autoship.ts";
import type { ExecResult } from "../src/exec.ts";
import type { RunRecord } from "../src/state.ts";
import type { GeneratedConflictRepairResult } from "../src/generated-conflict-repair.ts";

const ok: ExecResult = { ok: true, stdout: "", stderr: "", code: 0 };

function succeededRun(over: Partial<RunRecord> = {}): RunRecord {
  return {
    status: "succeeded",
    prNumber: 42,
    prUrl: "https://github.com/o/r/pull/42",
    branch: "issue-1-x",
    issueNumber: 1,
    issueTitle: "t",
    ...over,
  } as unknown as RunRecord;
}

interface Harness {
  deps: AutoshipDeps;
  shipped: { command: string; env: Record<string, string>; cwd: string | undefined }[];
  comments: string[];
  labels: string[];
  pushes: { title: string; priority: number }[];
  repairs: number;
}

function harness(opts: {
  autoshipCmd?: string | null;
  ci?: "pass" | "pending" | "fail";
  waitedCi?: "pass" | "pending" | "fail";
  mergeStateStatus?: string;
  isDraft?: boolean;
  reviewDecision?: string | null;
  diff?: string | null;
  shipResult?: ExecResult;
  repairResult?: GeneratedConflictRepairResult;
}): Harness {
  const shipped: Harness["shipped"] = [];
  const comments: string[] = [];
  const labels: string[] = [];
  const pushes: Harness["pushes"] = [];
  let repairs = 0;
  const deps: AutoshipDeps = {
    autoshipCmd: opts.autoshipCmd === undefined ? "ship.sh" : opts.autoshipCmd,
    repoSlug: "o/r",
    autoshipDeploymentCheckout: "/deploy/o-r",
    generatedConflictAllowlist: ["docs/memory.md", "docs/researcher.md"],
    generatedConflictRegenCmd: null,
    generatedConflictMaxAttempts: 1,
    generatedConflictCiWaitSeconds: 900,
    github: {
      prChecksState: async () => opts.ci ?? "pass",
      waitForPrChecks: async () => opts.waitedCi ?? "pass",
      prMergeInfo: async () => ({
        baseRefName: "main",
        baseRefOid: "base123",
        headRefName: "issue-1-x",
        headRefOid: "head456",
        isDraft: opts.isDraft ?? false,
        mergeStateStatus: opts.mergeStateStatus ?? "CLEAN",
        reviewDecision: opts.reviewDecision ?? null,
      }),
      prDiff: async () => (opts.diff === undefined ? "" : opts.diff),
      comment: async (_i, b) => { comments.push(b); return true; },
      addLabel: async (_i, l) => { labels.push(l); return true; },
    },
    repairGeneratedConflicts: async () => {
      repairs += 1;
      return opts.repairResult ?? {
        ok: true,
        conflictPaths: ["docs/memory.md"],
        discardedPaths: ["docs/memory.md"],
        commit: "cafebabe",
      };
    },
    ship: async (command, env, options) => { shipped.push({ command, env, cwd: options?.cwd }); return opts.shipResult ?? ok; },
    notifier: { send: async (title, _b, priority = 3) => { pushes.push({ title, priority }); } },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  };
  return {
    deps,
    shipped,
    comments,
    labels,
    pushes,
    get repairs() {
      return repairs;
    },
  };
}

describe("autoshipRun — gating", () => {
  it("skips when autoship is not configured", async () => {
    const h = harness({ autoshipCmd: null });
    const r = await autoshipRun(h.deps, succeededRun());
    assert.equal(r.action, "skipped");
    assert.equal(h.shipped.length, 0);
  });

  it("skips a non-success run", async () => {
    const h = harness({});
    const r = await autoshipRun(h.deps, succeededRun({ status: "failed" } as Partial<RunRecord>));
    assert.equal(r.action, "skipped");
  });

  it("skips a success with no PR", async () => {
    const h = harness({});
    const r = await autoshipRun(h.deps, succeededRun({ prNumber: null } as Partial<RunRecord>));
    assert.equal(r.action, "skipped");
  });

  it("does not ship when CI is pending", async () => {
    const h = harness({ ci: "pending" });
    const r = await autoshipRun(h.deps, succeededRun());
    assert.deepEqual(r, { action: "ci_not_green", state: "pending" });
    assert.equal(h.shipped.length, 0);
  });

  it("does not ship when CI has failed", async () => {
    const h = harness({ ci: "fail" });
    const r = await autoshipRun(h.deps, succeededRun());
    assert.equal(r.action, "ci_not_green");
    assert.equal(h.shipped.length, 0);
  });
});

describe("autoshipRun — data-loss gate", () => {
  const destructiveDiff = [
    "diff --git a/prisma/migrations/x/migration.sql b/prisma/migrations/x/migration.sql",
    "+++ b/prisma/migrations/x/migration.sql",
    '+DROP TABLE "Retailer";',
  ].join("\n");

  it("holds a destructive PR: labels, comments, ntfy, no ship", async () => {
    const h = harness({ diff: destructiveDiff });
    const r = await autoshipRun(h.deps, succeededRun());
    assert.equal(r.action, "held");
    assert.equal(h.shipped.length, 0, "must not ship a held PR");
    assert.ok(h.labels.includes(AUTOSHIP_HELD_LABEL));
    assert.match(h.comments[0]!, /data-loss/i);
    assert.ok(h.pushes.some((p) => /HELD/.test(p.title) && p.priority === 4));
  });

  it("holds (fails safe) when the diff cannot be read", async () => {
    const h = harness({ diff: null });
    const r = await autoshipRun(h.deps, succeededRun());
    assert.equal(r.action, "held");
    assert.equal(h.shipped.length, 0);
  });

  it("ships a clean additive PR", async () => {
    const cleanDiff = [
      "diff --git a/src/x.ts b/src/x.ts",
      "+++ b/src/x.ts",
      "+export const x = 1;",
    ].join("\n");
    const h = harness({ diff: cleanDiff });
    const r = await autoshipRun(h.deps, succeededRun());
    assert.equal(r.action, "shipped");
    assert.equal(h.shipped.length, 1);
  });
});

describe("autoshipRun — generated conflict recovery", () => {
  it("does not repair draft PRs even when GitHub reports conflicts", async () => {
    const h = harness({ mergeStateStatus: "DIRTY", isDraft: true });
    const r = await autoshipRun(h.deps, succeededRun());
    assert.deepEqual(r, { action: "merge_blocked", reason: "PR is still a draft" });
    assert.equal(h.repairs, 0);
    assert.equal(h.shipped.length, 0);
  });

  it("does not repair PRs that still require review", async () => {
    const h = harness({ mergeStateStatus: "DIRTY", reviewDecision: "REVIEW_REQUIRED" });
    const r = await autoshipRun(h.deps, succeededRun());
    assert.deepEqual(r, { action: "merge_blocked", reason: "PR requires review approval" });
    assert.equal(h.repairs, 0);
    assert.equal(h.shipped.length, 0);
  });

  it("repairs generated-only conflicts, waits for CI, then ships", async () => {
    const cleanDiff = [
      "diff --git a/src/x.ts b/src/x.ts",
      "+++ b/src/x.ts",
      "+export const x = 1;",
    ].join("\n");
    const h = harness({ mergeStateStatus: "DIRTY", diff: cleanDiff });
    const r = await autoshipRun(h.deps, succeededRun());
    assert.equal(r.action, "shipped");
    assert.equal(h.repairs, 1);
    assert.equal(h.shipped.length, 1);
    assert.match(h.comments[0]!, /recovered generated-file conflicts/i);
  });

  it("does not ship when generated-conflict recovery refuses a mixed conflict", async () => {
    const h = harness({
      mergeStateStatus: "DIRTY",
      repairResult: {
        ok: false,
        conflictPaths: ["docs/memory.md", "src/dispatcher.ts"],
        decision: null,
        reason: "one or more conflicts are not on the generated-file allowlist",
      },
    });
    const r = await autoshipRun(h.deps, succeededRun());
    assert.equal(r.action, "conflict_recovery_failed");
    assert.equal(h.shipped.length, 0);
    assert.match(h.comments[0]!, /merge conflicts need review/i);
  });

  it("does not ship when repaired-branch CI is still pending", async () => {
    const h = harness({ mergeStateStatus: "DIRTY", waitedCi: "pending" });
    const r = await autoshipRun(h.deps, succeededRun());
    assert.deepEqual(r, { action: "ci_not_green", state: "pending" });
    assert.equal(h.shipped.length, 0);
  });
});

describe("autoshipRun — shipping", () => {
  it("passes exact SHA and deployment checkout context to the ship command", async () => {
    const h = harness({ diff: "" });
    await autoshipRun(h.deps, succeededRun());
    assert.equal(h.shipped[0]!.command, "ship.sh");
    assert.equal(h.shipped[0]!.env.AUTOSHIP_PR_NUMBER, "42");
    assert.equal(h.shipped[0]!.env.AUTOSHIP_REPO, "o/r");
    assert.equal(h.shipped[0]!.env.AUTOSHIP_BRANCH, "issue-1-x");
    assert.equal(h.shipped[0]!.env.AUTOSHIP_PR_HEAD_SHA, "head456");
    assert.equal(h.shipped[0]!.env.AUTOSHIP_BASE_SHA, "base123");
    assert.equal(h.shipped[0]!.env.AUTOSHIP_DEPLOYMENT_CHECKOUT, "/deploy/o-r");
    assert.equal(h.shipped[0]!.cwd, "/deploy/o-r");
  });

  it("reports unknown state on non-zero exit without explicit rollback evidence", async () => {
    const h = harness({ diff: "", shipResult: { ok: false, stdout: "", stderr: "deploy blew up", code: 1 } });
    const r = await autoshipRun(h.deps, succeededRun());
    assert.equal(r.action, "ship_failed");
    assert.equal(r.state, "deployment_state_unknown");
    assert.ok(h.pushes.some((p) => /UNKNOWN/.test(p.title) && p.priority === 4));
  });

  it("reports rollback success only when the ship command explicitly says so", async () => {
    const h = harness({
      diff: "",
      shipResult: {
        ok: false,
        stdout: "::autoship:: state=deployment_failed_rollback_succeeded health=pass rollback=base123 last_good=base123\n",
        stderr: "deploy failed",
        code: 1,
      },
    });
    const r = await autoshipRun(h.deps, succeededRun());
    assert.equal(r.action, "ship_failed");
    assert.equal(r.state, "deployment_failed_rollback_succeeded");
    assert.ok(h.pushes.some((p) => /rolled back/i.test(p.title) && p.priority === 4));
  });

  it("does not throw if notifier rejects (best-effort)", async () => {
    const h = harness({ diff: "" });
    h.deps.notifier.send = async () => { throw new Error("ntfy down"); };
    const r = await autoshipRun(h.deps, succeededRun());
    assert.equal(r.action, "shipped");
  });
});
