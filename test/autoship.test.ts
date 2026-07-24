import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { autoshipRun, AUTOSHIP_HELD_LABEL, type AutoshipDeps } from "../src/autoship.ts";
import type { ExecResult } from "../src/exec.ts";
import type { RunRecord } from "../src/state.ts";
import type { GeneratedConflictRepairResult } from "../src/generated-conflict-repair.ts";

const ok: ExecResult = {
  ok: true,
  stdout: "::autoship:: state=shipped health=pass merged=merge789 deployed=merge789\n",
  stderr: "",
  code: 0,
};

function succeededRun(over: Partial<RunRecord> = {}): RunRecord {
  const recovery = over.recovery ?? {
    ci: {
      attempts: over.ciSelfHealAttempts ?? 0,
      escalated: over.ciEscalated ?? false,
    },
    deploy: {
      attempts: 0,
      escalated: over.deployEscalated ?? false,
    },
  };
  return {
    status: "succeeded",
    prNumber: 42,
    prUrl: "https://github.com/o/r/pull/42",
    branch: "issue-1-x",
    issueNumber: 1,
    issueTitle: "t",
    exitCode: 0,
    recovery,
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
  errors: string[];
  promotions: number;
  closedIssues: number[];
}

function harness(opts: {
  autoshipCmd?: string | null;
  ci?: "pass" | "pending" | "fail" | "unknown";
  waitedCi?: "pass" | "pending" | "fail" | "unknown";
  mergeStateStatus?: string;
  isDraft?: boolean;
  reviewDecision?: string | null;
  diff?: string | null;
  shipResult?: ExecResult;
  repairResult?: GeneratedConflictRepairResult;
  ciSelfHealMaxAttempts?: number;
  ciEscalationModel?: string;
  /** Simulates the repo label not existing yet (or another gh failure) — addLabel no-ops. */
  addLabelFails?: boolean;
  /** Issue labels returned by issueLabels() -- default none. */
  issueLabels?: string[];
  /** Whether markPrReady (gh pr ready) succeeds -- default true. */
  markPrReadyOk?: boolean;
  /** Whether closeIssue (gh issue close) succeeds -- default true. */
  closeIssueOk?: boolean;
  /** PR lifecycle state returned by prState() -- default "open". */
  prState?: "open" | "merged" | "closed" | "unknown";
  beforeShip?: AutoshipDeps["beforeShip"];
}): Harness {
  const shipped: Harness["shipped"] = [];
  const comments: string[] = [];
  const labels: string[] = [];
  const pushes: Harness["pushes"] = [];
  const errors: string[] = [];
  const closedIssues: number[] = [];
  let repairs = 0;
  let promotions = 0;
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
    ...(opts.beforeShip ? { beforeShip: opts.beforeShip } : {}),
    github: {
      prState: async () => opts.prState ?? "open",
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
        mergeCommitOid: "merge789",
      }),
      prDiff: async () => (opts.diff === undefined ? "" : opts.diff),
      comment: async (_i, b) => { comments.push(b); return true; },
      addLabel: async (_i, l) => {
        if (opts.addLabelFails) return false;
        labels.push(l);
        return true;
      },
      issueLabels: async () => opts.issueLabels ?? [],
      markPrReady: async () => {
        promotions += 1;
        return opts.markPrReadyOk ?? true;
      },
      closeIssue: async (issue: number) => {
        if (opts.closeIssueOk === false) return false;
        closedIssues.push(issue);
        return true;
      },
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
    logger: {
      debug() {},
      info() {},
      warn() {},
      error(msg: string) { errors.push(msg); },
    },
  };
  return {
    deps,
    shipped,
    comments,
    labels,
    pushes,
    errors,
    closedIssues,
    get repairs() {
      return repairs;
    },
    get promotions() {
      return promotions;
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

  it("ships artifact-proven pr_ready work after a later provider-capacity exit", async () => {
    const h = harness({});
    const r = await autoshipRun(
      h.deps,
      succeededRun({ status: "pr_ready", exitCode: 75 } as Partial<RunRecord>),
    );
    assert.equal(r.action, "shipped");
    assert.equal(h.shipped.length, 1);
  });

  it("ships the same capacity-ended delivery after a CI-pending recheck", async () => {
    const h = harness({});
    const r = await autoshipRun(
      h.deps,
      succeededRun({ status: "ci_pending", exitCode: 75 } as Partial<RunRecord>),
    );
    assert.equal(r.action, "shipped");
    assert.equal(h.shipped.length, 1);
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
    const r = await autoshipRun(
      h.deps,
      succeededRun({ recovery: { ci: { attempts: 2, escalated: true } } }),
    );
    assert.equal(r.action, "exhausted");
    assert.equal(h.shipped.length, 0);
  });
});

describe("autoshipRun — CI self-heal", () => {
  it("attempts a self-heal relaunch on the first red CI, without holding", async () => {
    const h = harness({ ci: "fail", ciSelfHealMaxAttempts: 2 });
    const r = await autoshipRun(h.deps, succeededRun());
    assert.equal(r.action, "repair");
    assert.equal(r.action === "repair" ? r.kind : null, "ci");
    assert.equal(r.action === "repair" ? r.attempt : null, 1);
    assert.equal(h.shipped.length, 0);
    assert.ok(!h.labels.includes(AUTOSHIP_HELD_LABEL), "must not hold while self-heal budget remains");
    assert.equal(h.comments.length, 0, "no held-for-human comment yet");
    assert.equal(h.pushes.length, 0, "routine repair must not page the operator");
  });

  it("attempts a second self-heal when one attempt has already been made", async () => {
    const h = harness({ ci: "fail", ciSelfHealMaxAttempts: 2 });
    const r = await autoshipRun(
      h.deps,
      succeededRun({ recovery: { ci: { attempts: 1, escalated: false } } }),
    );
    assert.equal(r.action, "repair");
    assert.equal(r.action === "repair" ? r.attempt : null, 2);
    assert.ok(!h.labels.includes(AUTOSHIP_HELD_LABEL));
  });

  it("escalates to the configured model once the self-heal budget is exhausted, without holding", async () => {
    const h = harness({ ci: "fail", ciSelfHealMaxAttempts: 2, ciEscalationModel: "claude-opus-4-8" });
    const r = await autoshipRun(
      h.deps,
      succeededRun({ recovery: { ci: { attempts: 2, escalated: false } } }),
    );
    assert.equal(r.action, "escalate");
    assert.equal(r.action === "escalate" ? r.model : null, "claude-opus-4-8");
    assert.ok(!h.labels.includes(AUTOSHIP_HELD_LABEL), "must not hold before the escalation attempt runs");
    assert.match(h.comments[0]!, /repair attempts exhausted, escalating/i);
    assert.match(h.comments[0]!, /claude-opus-4-8/);
    assert.equal(h.pushes.length, 0, "escalation is still automation-owned");
  });

  it("reports exhaustion once BOTH self-heal and the escalation attempt are exhausted", async () => {
    const h = harness({ ci: "fail", ciSelfHealMaxAttempts: 2 });
    const r = await autoshipRun(
      h.deps,
      succeededRun({ recovery: { ci: { attempts: 2, escalated: true } } }),
    );
    assert.equal(r.action, "exhausted");
    assert.equal(r.action === "exhausted" ? r.kind : null, "ci");
    assert.equal(h.pushes.length, 0, "dispatcher owns the single final exhausted page");
  });

  it("escalates (does not hold) immediately when the self-heal budget is configured to zero", async () => {
    const h = harness({ ci: "fail", ciSelfHealMaxAttempts: 0 });
    const r = await autoshipRun(h.deps, succeededRun());
    assert.equal(r.action, "escalate");
    assert.ok(!h.labels.includes(AUTOSHIP_HELD_LABEL));
  });

  it("holds immediately when both budgets are zero/exhausted from the start", async () => {
    const h = harness({ ci: "fail", ciSelfHealMaxAttempts: 0 });
    const r = await autoshipRun(
      h.deps,
      succeededRun({ recovery: { ci: { attempts: 0, escalated: true } } }),
    );
    assert.equal(r.action, "exhausted");
  });

  it("interpolates the escalation model name correctly in the escalation comment", async () => {
    const h = harness({ ci: "fail", ciSelfHealMaxAttempts: 0, ciEscalationModel: "claude-opus-4-8" });
    await autoshipRun(h.deps, succeededRun({ issueNumber: 366 }));
    assert.match(h.comments[0]!, /claude-opus-4-8/);
    assert.ok(!h.comments[0]!.includes("${deps.ciEscalationModel}"));
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

describe("autoshipRun — already merged (#10)", () => {
  it("deploys and verifies an already-merged PR instead of holding", async () => {
    const h = harness({ prState: "merged", diff: "" });
    const r = await autoshipRun(h.deps, succeededRun());
    assert.deepEqual(r, { action: "shipped" });
    assert.equal(h.shipped.length, 1);
    assert.equal(h.shipped[0]!.env.AUTOSHIP_MERGED_SHA, "merge789");
    assert.ok(!h.labels.includes(AUTOSHIP_HELD_LABEL));
  });

  it("closes the issue after the already-merged commit is verified in production", async () => {
    const h = harness({ prState: "merged", diff: "" });
    const r = await autoshipRun(h.deps, succeededRun({ issueNumber: 9 } as Partial<RunRecord>));
    assert.equal(r.action, "shipped");
    assert.deepEqual(h.closedIssues, [9]);
  });

  it("evaluates a still-open PR normally (does not short-circuit)", async () => {
    const h = harness({ prState: "open", diff: "" });
    const r = await autoshipRun(h.deps, succeededRun());
    assert.equal(r.action, "shipped");
    assert.equal(h.shipped.length, 1);
  });
});

describe("autoshipRun — autoship-everything policy (no data-loss / human-review gate)", () => {
  const destructiveDiff = [
    "diff --git a/prisma/migrations/x/migration.sql b/prisma/migrations/x/migration.sql",
    "+++ b/prisma/migrations/x/migration.sql",
    '+DROP TABLE "Retailer";',
  ].join("\n");

  it("ships a destructive PR — there is no data-loss gate; rollback is the net", async () => {
    const h = harness({ diff: destructiveDiff });
    const r = await autoshipRun(h.deps, succeededRun());
    assert.equal(r.action, "shipped");
    assert.equal(h.shipped.length, 1);
    assert.ok(!h.labels.includes(AUTOSHIP_HELD_LABEL), "destructive changes must not be held");
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
  it("promotes a draft PR (no human-review-required label) and still evaluates conflict recovery normally", async () => {
    // Policy change (post-#366): agents open ready-for-review PRs by default now, so a
    // draft reaching autoship gets promoted rather than parked forever behind a human
    // click. Draft status alone must not block generated-conflict recovery once promoted.
    const cleanDiff = ["diff --git a/src/x.ts b/src/x.ts", "+++ b/src/x.ts", "+export const x = 1;"].join("\n");
    const h = harness({ mergeStateStatus: "DIRTY", isDraft: true, diff: cleanDiff });
    const r = await autoshipRun(h.deps, succeededRun());
    assert.equal(r.action, "shipped");
    assert.equal(h.promotions, 1);
    assert.equal(h.repairs, 1);
  });

  it("promotes and ships even when the issue carries human-review-required (no human gate)", async () => {
    const h = harness({ mergeStateStatus: "DIRTY", isDraft: true, issueLabels: ["human-review-required"] });
    const r = await autoshipRun(h.deps, succeededRun());
    assert.equal(r.action, "shipped");
    assert.equal(h.promotions, 1);
    assert.ok(!h.labels.includes(AUTOSHIP_HELD_LABEL), "human-review-required must not block");
  });

  it("ships even when marking the draft ready reports failure (the ship command re-readies + admin-merges)", async () => {
    const h = harness({ isDraft: true, markPrReadyOk: false, diff: "" });
    const r = await autoshipRun(h.deps, succeededRun());
    assert.equal(r.action, "shipped");
    assert.equal(h.shipped.length, 1);
  });

  it("ships a PR that reports REVIEW_REQUIRED — the merge forces through with --admin", async () => {
    const h = harness({ mergeStateStatus: "DIRTY", reviewDecision: "REVIEW_REQUIRED" });
    const r = await autoshipRun(h.deps, succeededRun());
    assert.equal(r.action, "shipped");
    assert.ok(!h.labels.includes(AUTOSHIP_HELD_LABEL), "review-required must not block");
  });

  it("parks without spending recovery when mergeability cannot be read", async () => {
    const h = harness({});
    h.deps.github.prMergeInfo = async () => null;
    const r = await autoshipRun(h.deps, succeededRun());
    assert.deepEqual(r, { action: "ci_not_green", state: "unknown" });
    assert.ok(!h.labels.includes(AUTOSHIP_HELD_LABEL));
  });

  it("parks an unreadable PR lifecycle instead of fabricating a merge failure", async () => {
    const h = harness({ prState: "unknown" });
    const r = await autoshipRun(h.deps, succeededRun());
    assert.deepEqual(r, { action: "ci_not_green", state: "unknown" });
    assert.equal(h.shipped.length, 0);
  });

  it("repairs a PR confirmed closed without merging", async () => {
    const h = harness({ prState: "closed" });
    const r = await autoshipRun(h.deps, succeededRun());
    assert.equal(r.action, "repair");
    assert.equal(r.action === "repair" ? r.kind : null, "merge");
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
    assert.equal(r.action, "repair");
    assert.equal(r.action === "repair" ? r.kind : null, "merge");
    assert.equal(h.shipped.length, 0);
    assert.ok(!h.labels.includes(AUTOSHIP_HELD_LABEL));
  });

  it("does not ship when repaired-branch CI is still pending", async () => {
    const h = harness({ mergeStateStatus: "DIRTY", waitedCi: "pending" });
    const r = await autoshipRun(h.deps, succeededRun());
    assert.deepEqual(r, { action: "ci_not_green", state: "pending" });
    assert.equal(h.shipped.length, 0);
  });
});

describe("autoshipRun — shipping", () => {
  it("durably checkpoints deployment before invoking the ship command", async () => {
    const order: string[] = [];
    const h = harness({
      diff: "",
      beforeShip: () => {
        order.push("checkpoint");
      },
    });
    const originalShip = h.deps.ship;
    h.deps.ship = async (...args) => {
      order.push("ship");
      return originalShip(...args);
    };

    await autoshipRun(h.deps, succeededRun());
    assert.deepEqual(order, ["checkpoint", "ship"]);
  });

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

  it("repairs a deploy failure with the assigned model before escalating", async () => {
    const h = harness({
      diff: "",
      shipResult: { ok: false, stdout: "", stderr: "deploy blew up", code: 1 },
      ciEscalationModel: "claude-opus-4-8",
    });
    const r = await autoshipRun(h.deps, succeededRun());
    assert.equal(r.action, "repair");
    assert.equal(r.action === "repair" ? r.kind : null, "deploy");
    assert.equal(r.action === "repair" ? r.attempt : null, 1);
    assert.ok(!h.labels.includes(AUTOSHIP_HELD_LABEL));
    assert.equal(h.pushes.length, 0);
    assert.match(r.action === "repair" ? r.reason : "", /automated recovery attempt/);
    assert.doesNotMatch(r.action === "repair" ? r.reason : "", /Human production verification/);
  });

  it("escalates deploy only after the assigned-model repair budget is exhausted", async () => {
    const h = harness({ diff: "", shipResult: { ok: false, stdout: "", stderr: "deploy blew up", code: 1 } });
    const r = await autoshipRun(
      h.deps,
      succeededRun({ recovery: { deploy: { attempts: 2, escalated: false } } }),
    );
    assert.equal(r.action, "escalate");
    assert.equal(r.action === "escalate" ? r.model : null, "claude-opus-4-8");
    assert.ok(!h.labels.includes(AUTOSHIP_HELD_LABEL));
  });

  it("a spent CI escalation does not consume the deploy escalation budget", async () => {
    const h = harness({ diff: "", shipResult: { ok: false, stdout: "", stderr: "deploy blew up", code: 1 } });
    const r = await autoshipRun(
      h.deps,
      succeededRun({
        recovery: {
          ci: { attempts: 2, escalated: true },
          deploy: { attempts: 2, escalated: false },
        },
      }),
    );
    assert.equal(r.action, "escalate");
    assert.equal(r.action === "escalate" ? r.kind : null, "deploy");
    assert.ok(!h.labels.includes(AUTOSHIP_HELD_LABEL));
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
    const r = await autoshipRun(
      h.deps,
      succeededRun({ recovery: { deploy: { attempts: 2, escalated: true } } }),
    );
    assert.equal(r.action, "exhausted");
    assert.match(r.action === "exhausted" ? r.reason : "", /rollback SHA/i);
    assert.equal(h.pushes.length, 0, "dispatcher sends the one final exhausted page");
  });

  it("parks a detached systemd deployment until production health is verified", async () => {
    const h = harness({
      diff: "",
      shipResult: {
        ok: true,
        stdout:
          "::autoship:: state=merge_succeeded_deployment_not_attempted health=unknown merged=merge789\n",
        stderr: "",
        code: 0,
      },
    });
    const r = await autoshipRun(h.deps, succeededRun({ issueNumber: 366 } as Partial<RunRecord>));
    assert.deepEqual(r, { action: "deploy_pending", mergedSha: "merge789" });
    assert.deepEqual(h.closedIssues, [], "a restart handoff is not a verified deployment");
    assert.equal(h.pushes.length, 0);
  });

  it("does not accept rollback health as successful deployment health on exit zero", async () => {
    const h = harness({
      diff: "",
      shipResult: {
        ok: true,
        stdout:
          "::autoship:: state=deployment_failed_rollback_succeeded health=pass merged=bad rollback=good\n",
        stderr: "",
        code: 0,
      },
    });
    const r = await autoshipRun(h.deps, succeededRun({ issueNumber: 366 } as Partial<RunRecord>));
    assert.equal(r.action, "repair");
    assert.deepEqual(h.closedIssues, []);
  });

  it("closes the issue ONLY after a shipped, health-pass deploy -- never on merge alone (#366)", async () => {
    // Regression test: PR bodies never carry a GitHub auto-close keyword (Closes/Fixes/
    // Resolves #n) specifically so merging never closes the issue before the deploy that
    // follows is verified. The dispatcher itself must close it explicitly, and only once
    // the ship command confirms success.
    const h = harness({ diff: "" });
    const r = await autoshipRun(h.deps, succeededRun({ issueNumber: 366 } as Partial<RunRecord>));
    assert.equal(r.action, "shipped");
    assert.deepEqual(h.closedIssues, [366]);
  });

  it("does NOT close the issue when the ship command fails", async () => {
    const h = harness({ diff: "", shipResult: { ok: false, stdout: "", stderr: "deploy blew up", code: 1 } });
    const r = await autoshipRun(
      h.deps,
      succeededRun({
        issueNumber: 366,
        recovery: { deploy: { attempts: 2, escalated: true } },
      } as Partial<RunRecord>),
    );
    assert.equal(r.action, "exhausted");
    assert.deepEqual(h.closedIssues, []);
  });

  it("does NOT close the issue when the ship command exits 0 but its own report says health is not pass", async () => {
    // A script that reports honestly but, for whatever reason, exits 0 anyway -- the
    // parsed health is what gates closing, not merely reaching the success branch.
    const h = harness({
      diff: "",
      shipResult: {
        ok: true,
        stdout: "::autoship:: state=shipped health=unknown\n",
        stderr: "",
        code: 0,
      },
    });
    const r = await autoshipRun(h.deps, succeededRun({ issueNumber: 366 } as Partial<RunRecord>));
    assert.equal(r.action, "repair");
    assert.deepEqual(h.closedIssues, [], "non-pass health never becomes shipped");
  });

  it("repairs instead of closing when a healthy deploy report names a stale merge SHA", async () => {
    const h = harness({
      diff: "",
      shipResult: {
        ok: true,
        stdout: "::autoship:: state=shipped health=pass merged=stale deployed=stale\n",
        stderr: "",
        code: 0,
      },
    });

    const result = await autoshipRun(h.deps, succeededRun());

    assert.equal(result.action, "repair");
    assert.equal(h.closedIssues.length, 0);
  });

  it("repairs instead of claiming success when closing the shipped issue fails", async () => {
    const h = harness({ diff: "", closeIssueOk: false });
    const r = await autoshipRun(h.deps, succeededRun({ issueNumber: 366 } as Partial<RunRecord>));
    assert.equal(r.action, "repair");
    assert.equal(r.action === "repair" ? r.kind : null, "merge");
    assert.deepEqual(h.closedIssues, []);
    assert.ok(h.errors.some((e) => /failed to close the issue/.test(e)));
  });

  it("does not throw if notifier rejects (best-effort)", async () => {
    const h = harness({ diff: "" });
    h.deps.notifier.send = async () => { throw new Error("ntfy down"); };
    const r = await autoshipRun(h.deps, succeededRun());
    assert.equal(r.action, "shipped");
  });
});
