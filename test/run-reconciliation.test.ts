import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decideReconciliation,
  planIsComplete,
  planMilestoneProgress,
  reconciledDeliveryComment,
  selectBranchPullRequest,
  type BranchPullRequest,
  type CheckoutSnapshot,
  type ReconcileEvidence,
} from "../src/run-reconciliation.ts";

const HEAD = "7ac045908c2a1670d34675f0ddde19d54b2942e8";

function pr(overrides: Partial<BranchPullRequest> = {}): BranchPullRequest {
  return {
    number: 787,
    state: "open",
    isDraft: false,
    headRefOid: HEAD,
    url: "https://github.com/o/r/pull/787",
    ...overrides,
  };
}

function present(overrides: Partial<Extract<CheckoutSnapshot, { state: "present" }>> = {}): CheckoutSnapshot {
  return { state: "present", head: HEAD, dirty: [], plan: null, ...overrides };
}

function evidence(overrides: Partial<ReconcileEvidence> = {}): ReconcileEvidence {
  return { pr: pr(), checkout: present(), published: true, agentFinished: false, ...overrides };
}

// ── plan progress ─────────────────────────────────────────────────────────────

test("plan progress counts numbered milestone headers and their [DONE] markers", () => {
  const plan = [
    "# Issue #773",
    "## Goal",
    "## [DONE] Milestone 1: `scripts/verify.sh`",
    "### [done] Milestone 2: lower-case marker and deeper header",
    "## Milestone 3: Update guidance [DONE]",
    "## Milestone 4: Verify and open PR",
    "- Milestone 5 mentioned in a bullet is not a header",
  ].join("\n");
  assert.deepEqual(planMilestoneProgress(plan), { total: 4, done: 3 });
});

test("a Milestones section or a placeholder header is not mistaken for unfinished work", () => {
  const plan = "## Milestones\n## Milestone N: Title\n## [DONE] Milestone 1: real\n";
  assert.deepEqual(planMilestoneProgress(plan), { total: 1, done: 1 });
});

test("a plan is complete only when it has milestones and every one is [DONE]", () => {
  assert.equal(planIsComplete({ total: 4, done: 4 }), true);
  assert.equal(planIsComplete({ total: 4, done: 3 }), false);
  assert.equal(planIsComplete({ total: 0, done: 0 }), false, "no milestones proves nothing");
});

// ── branch PR selection ───────────────────────────────────────────────────────

test("a merged PR stays the branch's delivery identity over any open one", () => {
  const selected = selectBranchPullRequest(
    [pr({ number: 801, state: "open" }), pr({ number: 787, state: "merged" })],
    801,
  );
  assert.equal(selected?.number, 787);
});

test("the run's own open PR is kept; otherwise the newest open PR", () => {
  const prs = [pr({ number: 790 }), pr({ number: 787 }), pr({ number: 780, state: "closed" })];
  assert.equal(selectBranchPullRequest(prs, 787)?.number, 787);
  assert.equal(selectBranchPullRequest(prs, null)?.number, 790);
  assert.equal(selectBranchPullRequest(prs, 780)?.number, 790, "a closed known PR is not resumed");
});

test("a branch with no PR, or only closed ones, has no delivery to resume", () => {
  assert.equal(selectBranchPullRequest([], 787), null);
  assert.equal(selectBranchPullRequest([pr({ state: "closed" })], 787), null);
});

// ── the decision ──────────────────────────────────────────────────────────────

test("internal-tools #773: a clean agent exit whose only objection was a dispatcher file delivers", () => {
  // Exit 75 after `claude exited with code 0`; HEAD is the PR head; the cache key is
  // excluded from the dirty set; every milestone is [DONE].
  const decision = decideReconciliation(
    evidence({
      agentFinished: true,
      checkout: present({ plan: { path: "docs/plans/issue773.md", total: 4, done: 4 } }),
    }),
  );
  assert.equal(decision.action, "deliver");
  assert.equal(decision.action === "deliver" && decision.basis, "agent-finished");
  assert.equal(decision.action === "deliver" && decision.pr.number, 787);
});

test("a published PR whose plan is complete delivers even after a blind kill", () => {
  const decision = decideReconciliation(
    evidence({ checkout: present({ plan: { path: ".plan-issue-109.md", total: 5, done: 5 } }) }),
  );
  assert.equal(decision.action, "deliver");
  assert.equal(decision.action === "deliver" && decision.basis, "plan-complete");
  assert.match(decision.reason, /every milestone in \.plan-issue-109\.md is marked \[DONE\]/);
});

test("a green PR alone is not proof: an unfinished plan or no evidence relaunches", () => {
  const unfinished = decideReconciliation(
    evidence({ checkout: present({ plan: { path: "p.md", total: 4, done: 2 } }) }),
  );
  assert.deepEqual(unfinished, {
    action: "relaunch",
    reason: "p.md still has 2 milestone(s) without [DONE]",
  });
  const noPlan = decideReconciliation(evidence());
  assert.equal(noPlan.action, "relaunch");
  assert.match(noPlan.reason, /no plan/);
});

test("unpublished work always relaunches: uncommitted edits, unpushed commits, or unprovable ancestry", () => {
  const dirty = decideReconciliation(
    evidence({
      agentFinished: true,
      checkout: present({
        dirty: [" M src/a.ts", "?? src/b.ts", "?? c.md", "?? d.md"],
        plan: { path: "p.md", total: 1, done: 1 },
      }),
    }),
  );
  assert.deepEqual(dirty, {
    action: "relaunch",
    reason: "the checkout has uncommitted changes (src/a.ts, src/b.ts, c.md, and 1 more)",
  });

  const ahead = decideReconciliation(evidence({ agentFinished: true, published: false }));
  assert.equal(ahead.action, "relaunch");
  assert.match(ahead.reason, /commits that PR #787 does not contain/);

  const unknown = decideReconciliation(evidence({ agentFinished: true, published: null }));
  assert.equal(unknown.action, "relaunch");
  assert.match(unknown.reason, /could not prove/);
});

test("no PR, a closed PR, or an uninspectable checkout relaunches the saved checkout", () => {
  assert.equal(decideReconciliation(evidence({ pr: null, agentFinished: true })).action, "relaunch");
  assert.equal(
    decideReconciliation(evidence({ pr: pr({ state: "closed" }), agentFinished: true })).action,
    "relaunch",
  );
  const unreadable = decideReconciliation(
    evidence({ checkout: { state: "unknown", reason: "git timed out" }, agentFinished: true }),
  );
  assert.deepEqual(unreadable, {
    action: "relaunch",
    reason: "the preserved checkout could not be inspected (git timed out)",
  });
});

test("a merged PR delivers whatever the checkout holds; an unreadable GitHub only waits", () => {
  const merged = decideReconciliation(
    evidence({
      pr: pr({ state: "merged" }),
      checkout: present({ dirty: [" M x"] }),
      published: false,
    }),
  );
  assert.equal(merged.action === "deliver" && merged.basis, "merged");
  assert.deepEqual(decideReconciliation(evidence({ pr: "unknown", agentFinished: true })), {
    action: "wait",
    reason: "GitHub could not report the branch's pull requests",
  });
});

test("a missing checkout delivers only on the agent's own clean finish", () => {
  const finished = decideReconciliation(
    evidence({ checkout: { state: "missing" }, published: null, agentFinished: true }),
  );
  assert.equal(finished.action === "deliver" && finished.basis, "agent-finished");
  assert.match(finished.reason, /only remaining copy/);
  const unproven = decideReconciliation(evidence({ checkout: { state: "missing" }, published: null }));
  assert.equal(unproven.action, "relaunch");
});

test("a draft PR with finished work is delivered; autoship owns promoting it", () => {
  const decision = decideReconciliation(evidence({ pr: pr({ isDraft: true }), agentFinished: true }));
  assert.equal(decision.action, "deliver");
});

test("the delivery comment names the PR and says no model budget was spent", () => {
  const decision = decideReconciliation(evidence({ agentFinished: true }));
  assert.equal(decision.action, "deliver");
  if (decision.action !== "deliver") return;
  const comment = reconciledDeliveryComment({ branch: "issue-773-x" }, decision);
  assert.match(comment, /^## Dispatcher: finished work found on PR #787/);
  assert.match(comment, /`issue-773-x`/);
  assert.match(comment, /instead of relaunching the agent/);
  assert.match(comment, /No model repair or frontier budget was spent/);
});
