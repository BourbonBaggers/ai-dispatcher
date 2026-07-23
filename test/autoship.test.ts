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
    exitCode: 0,
    ciSelfHealAttempts: 0,
    ciEscalated: false,
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
  ciSelfHealMaxAttempts?: number;
  ciEscalationModel?: string;
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
    ciSelfHealMaxAttempts: opts.ciSelfHealMaxAttempts ?? 2,
    ciEscalationModel: opts.ciEscalationModel ?? "claude-opus-4-8",
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
    const r = await autoshipRun(
      h.deps,
      succeededRun({ status: "failed", exitCode: 1 } as Partial<RunRecord>),
    );
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

  it("does not ship when CI has failed (self-heal and escalation budgets already exhausted)", async () => {
    const h = harness({ ci: "fail", ciSelfHealMaxAttempts: 2 });
    const r = await autoshipRun(h.deps, succeededRun({ ciSelfHealAttempts: 2, ciEscalated: true }));
    assert.equal(r.action, "ci_not_green");
    assert.equal(h.shipped.length, 0);
  });
});

describe("autoshipRun — CI self-heal", () => {
  it("attempts a self-heal relaunch on the first red CI, without holding", async () => {
    const h = harness({ ci: "fail", ciSelfHealMaxAttempts: 2 });
    const r = await autoshipRun(h.deps, succeededRun({ ciSelfHealAttempts: 0 }));
    assert.deepEqual(r, { action: "ci_self_heal", attempt: 1, maxAttempts: 2 });
    assert.equal(h.shipped.length, 0);
    assert.ok(!h.labels.includes(AUTOSHIP_HELD_LABEL), "must not hold while self-heal budget remains");
    assert.equal(h.comments.length, 0, "no held-for-human comment yet");
    assert.ok(h.pushes.some((p) => /self-heal 1\/2/.test(p.title) && p.priority === 3));
  });

  it("attempts a second self-heal when one attempt has already been made", async () => {
    const h = harness({ ci: "fail", ciSelfHealMaxAttempts: 2 });
    const r = await autoshipRun(h.deps, succeededRun({ ciSelfHealAttempts: 1 }));
    assert.deepEqual(r, { action: "ci_self_heal", attempt: 2, maxAttempts: 2 });
    assert.ok(!h.labels.includes(AUTOSHIP_HELD_LABEL));
  });

  it("escalates to the configured model once the self-heal budget is exhausted, without holding", async () => {
    const h = harness({ ci: "fail", ciSelfHealMaxAttempts: 2, ciEscalationModel: "claude-opus-4-8" });
    const r = await autoshipRun(h.deps, succeededRun({ ciSelfHealAttempts: 2, ciEscalated: false }));
    assert.deepEqual(r, { action: "ci_escalate", model: "claude-opus-4-8" });
    assert.ok(!h.labels.includes(AUTOSHIP_HELD_LABEL), "must not hold before the escalation attempt runs");
    assert.match(h.comments[0]!, /self-heal failed, escalating/i);
    assert.match(h.comments[0]!, /claude-opus-4-8/);
    assert.ok(h.pushes.some((p) => /escalating #1 to claude-opus-4-8/.test(p.title) && p.priority === 3));
  });

  it("holds with autoship-held once BOTH self-heal and the escalation attempt are exhausted", async () => {
    const h = harness({ ci: "fail", ciSelfHealMaxAttempts: 2 });
    const r = await autoshipRun(h.deps, succeededRun({ ciSelfHealAttempts: 2, ciEscalated: true }));
    assert.deepEqual(r, { action: "ci_not_green", state: "fail" });
    assert.ok(h.labels.includes(AUTOSHIP_HELD_LABEL));
    assert.match(h.comments[0]!, /still failing after self-heal and escalation/i);
    assert.ok(h.pushes.some((p) => /HELD/.test(p.title) && p.priority === 4));
  });

  it("escalates (does not hold) immediately when the self-heal budget is configured to zero", async () => {
    const h = harness({ ci: "fail", ciSelfHealMaxAttempts: 0 });
    const r = await autoshipRun(h.deps, succeededRun({ ciSelfHealAttempts: 0, ciEscalated: false }));
    assert.equal(r.action, "ci_escalate");
    assert.ok(!h.labels.includes(AUTOSHIP_HELD_LABEL));
  });

  it("holds immediately when both budgets are zero/exhausted from the start", async () => {
    const h = harness({ ci: "fail", ciSelfHealMaxAttempts: 0 });
    const r = await autoshipRun(h.deps, succeededRun({ ciSelfHealAttempts: 0, ciEscalated: true }));
    assert.equal(r.action, "ci_not_green");
    assert.ok(h.labels.includes(AUTOSHIP_HELD_LABEL));
  });

  it("interpolates the PR and issue number correctly in the held comment/notification", async () => {
    // Regression test: an earlier version of this code path had escaped template
    // literals (`\${pr}`) that printed the literal text "${pr}" instead of the number.
    const h = harness({ ci: "fail", ciSelfHealMaxAttempts: 0 });
    await autoshipRun(h.deps, succeededRun({ ciSelfHealAttempts: 0, ciEscalated: true, issueNumber: 366 }));
    assert.match(h.comments[0]!, /PR #42/);
    assert.ok(!h.comments[0]!.includes("${pr}"));
    assert.ok(h.pushes.some((p) => p.title.includes("#366") && !p.title.includes("${")));
  });

  it("interpolates the escalation model name correctly in the escalation comment/notification", async () => {
    const h = harness({ ci: "fail", ciSelfHealMaxAttempts: 0, ciEscalationModel: "claude-opus-4-8" });
    await autoshipRun(h.deps, succeededRun({ ciSelfHealAttempts: 0, ciEscalated: false, issueNumber: 366 }));
    assert.match(h.comments[0]!, /claude-opus-4-8/);
    assert.ok(!h.comments[0]!.includes("${deps.ciEscalationModel}"));
    assert.ok(h.pushes.some((p) => p.title.includes("#366") && p.title.includes("claude-opus-4-8")));
  });

  it("treats a run that FAILED solely on red CI (exit 0) as a self-heal/ship candidate", async () => {
    const h = harness({ ci: "pass", diff: "" });
    const r = await autoshipRun(
      h.deps,
      succeededRun({ status: "failed", exitCode: 0, ciSelfHealAttempts: 1 } as Partial<RunRecord>),
    );
    assert.equal(r.action, "shipped");
  });

  it("still skips a failed run that exited non-zero (not a red-CI-only failure)", async () => {
    const h = harness({});
    const r = await autoshipRun(
      h.deps,
      succeededRun({ status: "failed", exitCode: 1 } as Partial<RunRecord>),
    );
    assert.equal(r.action, "skipped");
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

  it("holds (stamps autoship-held) on merge_blocked, so a draft PR does not get re-dispatched forever", async () => {
    // Regression test for #366: mergeBlocked used to say "Autoship HELD" in its comment
    // title without ever stamping the label, so the issue stayed fully eligible and got
    // re-claimed and re-run on every single poll — dozens of times over many hours,
    // every one a no-op, because nothing had changed and nothing was going to change
    // until a human converted the PR out of draft.
    const h = harness({ isDraft: true });
    const r = await autoshipRun(h.deps, succeededRun());
    assert.deepEqual(r, { action: "merge_blocked", reason: "PR is still a draft" });
    assert.ok(h.labels.includes(AUTOSHIP_HELD_LABEL));
    assert.match(h.comments[0]!, /autoship-held.*label is removed/is);
  });

  it("holds on merge_blocked when a PR requires review, not just when it's a draft", async () => {
    const h = harness({ reviewDecision: "REVIEW_REQUIRED" });
    const r = await autoshipRun(h.deps, succeededRun());
    assert.deepEqual(r, { action: "merge_blocked", reason: "PR requires review approval" });
    assert.ok(h.labels.includes(AUTOSHIP_HELD_LABEL));
  });

  it("holds on merge_blocked when PR mergeability could not be read at all", async () => {
    const h = harness({});
    h.deps.github.prMergeInfo = async () => null;
    const r = await autoshipRun(h.deps, succeededRun());
    assert.deepEqual(r, { action: "merge_blocked", reason: "PR mergeability could not be read" });
    assert.ok(h.labels.includes(AUTOSHIP_HELD_LABEL));
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
