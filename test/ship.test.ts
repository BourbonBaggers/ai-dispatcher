import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shipRun, findAutoCloseKeyword, type ShipDeps } from "../src/ship.ts";
import type { ExecResult } from "../src/exec.ts";
import type { GithubPrMergeInfo } from "../src/github.ts";

const ok: ExecResult = {
  ok: true,
  stdout: "::autoship:: state=shipped health=pass merged=merge789 deployed=merge789 pr_head=head456\n",
  stderr: "",
  code: 0,
};

interface Harness {
  deps: ShipDeps;
  shipped: { command: string; env: Record<string, string>; cwd: string | undefined }[];
  closedIssues: number[];
  errors: string[];
}

function harness(opts: {
  autoshipCmd?: string;
  ci?: "pass" | "pending" | "fail" | "unknown";
  mergeStateStatus?: string;
  isDraft?: boolean;
  prState?: "open" | "merged" | "closed" | "unknown";
  titleBody?: { title: string; body: string } | null;
  mergeInfo?: Partial<GithubPrMergeInfo> | null;
  shipResult?: ExecResult;
  closeIssueOk?: boolean;
}): Harness {
  const shipped: Harness["shipped"] = [];
  const closedIssues: number[] = [];
  const errors: string[] = [];
  const defaultMergeInfo: GithubPrMergeInfo = {
    baseRefName: "main",
    baseRefOid: "base123",
    headRefName: "issue-1-x",
    headRefOid: "head456",
    isDraft: opts.isDraft ?? false,
    mergeStateStatus: opts.mergeStateStatus ?? "CLEAN",
    reviewDecision: null,
    mergeCommitOid: "merge789",
  };
  const deps: ShipDeps = {
    autoshipCmd: opts.autoshipCmd ?? "ship.sh",
    repoSlug: "o/r",
    autoshipDeploymentCheckout: "/deploy/o-r",
    github: {
      prState: async () => opts.prState ?? "open",
      prChecksState: async () => opts.ci ?? "pass",
      prMergeInfo: async () =>
        opts.mergeInfo === null ? null : { ...defaultMergeInfo, ...(opts.mergeInfo ?? {}) },
      prTitleAndBody: async () =>
        opts.titleBody === null
          ? null
          : opts.titleBody ?? { title: "Add widgets", body: "Issue: #4" },
      closeIssue: async (issue: number) => {
        if (opts.closeIssueOk === false) return false;
        closedIssues.push(issue);
        return true;
      },
    },
    ship: async (command, env, options) => {
      shipped.push({ command, env, cwd: options?.cwd });
      return opts.shipResult ?? ok;
    },
    logger: {
      debug() {},
      info() {},
      warn() {},
      error(msg: string) {
        errors.push(msg);
      },
    },
  };
  return { deps, shipped, closedIssues, errors };
}

describe("findAutoCloseKeyword", () => {
  it("matches every documented GitHub close/fix/resolve form", () => {
    for (const text of [
      "Closes #123",
      "close #123",
      "Closed #123",
      "Fix #123",
      "fixes #123",
      "Fixed #123",
      "Resolve #123",
      "resolves #123",
      "Resolved #123",
      "closes GH-123",
      "closes https://github.com/o/r/issues/123",
    ]) {
      assert.ok(findAutoCloseKeyword(text), `expected a match in "${text}"`);
    }
  });

  it("does not false-positive on ordinary words or a bare issue reference", () => {
    for (const text of [
      "This is the closest we can get",
      "Fixture data for #123",
      "Issue: #123",
      "See #123 for context",
    ]) {
      assert.equal(findAutoCloseKeyword(text), null, `unexpected match in "${text}"`);
    }
  });
});

describe("shipRun — gating", () => {
  it("blocks when PR state is unknown", async () => {
    const h = harness({ prState: "unknown" });
    const r = await shipRun(h.deps, { pr: 42, issueNumber: null });
    assert.equal(r.action, "blocked");
    assert.equal(h.shipped.length, 0);
  });

  it("blocks a closed (not merged) PR", async () => {
    const h = harness({ prState: "closed" });
    const r = await shipRun(h.deps, { pr: 42, issueNumber: null });
    assert.equal(r.action, "blocked");
  });

  it("blocks when the PR title/body cannot be read", async () => {
    const h = harness({ titleBody: null });
    const r = await shipRun(h.deps, { pr: 42, issueNumber: null });
    assert.equal(r.action, "blocked");
    assert.equal(h.shipped.length, 0);
  });

  it("blocks a PR carrying a GitHub auto-close keyword", async () => {
    const h = harness({ titleBody: { title: "Add widgets", body: "Closes #4" } });
    const r = await shipRun(h.deps, { pr: 42, issueNumber: 4 });
    assert.equal(r.action, "blocked");
    if (r.action === "blocked") assert.match(r.reason, /auto-close keyword/);
    assert.equal(h.shipped.length, 0);
  });

  it("blocks when PR mergeability cannot be read", async () => {
    const h = harness({ mergeInfo: null });
    const r = await shipRun(h.deps, { pr: 42, issueNumber: null });
    assert.equal(r.action, "blocked");
  });

  it("blocks a draft PR instead of promoting it", async () => {
    const h = harness({ isDraft: true });
    const r = await shipRun(h.deps, { pr: 42, issueNumber: null });
    assert.equal(r.action, "blocked");
    if (r.action === "blocked") assert.match(r.reason, /draft/);
    assert.equal(h.shipped.length, 0);
  });

  it("blocks a PR with merge conflicts rather than repairing them", async () => {
    const h = harness({ mergeStateStatus: "DIRTY" });
    const r = await shipRun(h.deps, { pr: 42, issueNumber: null });
    assert.equal(r.action, "blocked");
    if (r.action === "blocked") assert.match(r.reason, /conflict/);
    assert.equal(h.shipped.length, 0);
  });

  it("reports ci_not_green without merging when CI is pending", async () => {
    const h = harness({ ci: "pending" });
    const r = await shipRun(h.deps, { pr: 42, issueNumber: null });
    assert.deepEqual(r, { action: "ci_not_green", state: "pending" });
    assert.equal(h.shipped.length, 0);
  });

  it("reports ci_not_green without merging when CI is red", async () => {
    const h = harness({ ci: "fail" });
    const r = await shipRun(h.deps, { pr: 42, issueNumber: null });
    assert.deepEqual(r, { action: "ci_not_green", state: "fail" });
    assert.equal(h.shipped.length, 0);
  });
});

describe("shipRun — shipping", () => {
  it("invokes the ship command with the PR's merge context", async () => {
    const h = harness({});
    const r = await shipRun(h.deps, { pr: 42, issueNumber: null });
    assert.equal(r.action, "shipped");
    assert.equal(h.shipped.length, 1);
    assert.deepEqual(h.shipped[0]!.env, {
      AUTOSHIP_PR_NUMBER: "42",
      AUTOSHIP_BRANCH: "issue-1-x",
      AUTOSHIP_REPO: "o/r",
      AUTOSHIP_PR_HEAD_SHA: "head456",
      AUTOSHIP_BASE_SHA: "base123",
      AUTOSHIP_DEPLOYMENT_CHECKOUT: "/deploy/o-r",
    });
    assert.equal(h.shipped[0]!.cwd, "/deploy/o-r");
  });

  it("does not close an issue when none was supplied", async () => {
    const h = harness({});
    const r = await shipRun(h.deps, { pr: 42, issueNumber: null });
    assert.equal(r.action, "shipped");
    if (r.action === "shipped") assert.equal(r.issueClosed, null);
    assert.equal(h.closedIssues.length, 0);
    assert.equal(h.shipped[0]!.env.AUTOSHIP_ISSUE_NUMBER, undefined);
  });

  it("closes the supplied issue only after verified delivery", async () => {
    const h = harness({});
    const r = await shipRun(h.deps, { pr: 42, issueNumber: 4 });
    assert.equal(r.action, "shipped");
    if (r.action === "shipped") assert.equal(r.issueClosed, true);
    assert.deepEqual(h.closedIssues, [4]);
    assert.equal(h.shipped[0]!.env.AUTOSHIP_ISSUE_NUMBER, "4");
  });

  it("reports shipped but issueClosed:false when closing fails", async () => {
    const h = harness({ closeIssueOk: false });
    const r = await shipRun(h.deps, { pr: 42, issueNumber: 4 });
    assert.equal(r.action, "shipped");
    if (r.action === "shipped") assert.equal(r.issueClosed, false);
  });

  it("reports deploy_pending for a detached deploy awaiting verification, without closing the issue", async () => {
    const h = harness({
      shipResult: {
        ok: true,
        stdout: "::autoship:: state=merge_succeeded_deployment_not_attempted health=unknown merged=merge789\n",
        stderr: "",
        code: 0,
      },
    });
    const r = await shipRun(h.deps, { pr: 42, issueNumber: 4 });
    assert.deepEqual(r, { action: "deploy_pending", mergedSha: "merge789" });
    assert.equal(h.closedIssues.length, 0);
  });

  it("reports deploy_failed when the ship command exits non-zero", async () => {
    const h = harness({
      shipResult: { ok: false, stdout: "", stderr: "deploy exploded", code: 1 },
    });
    const r = await shipRun(h.deps, { pr: 42, issueNumber: null });
    assert.equal(r.action, "deploy_failed");
    assert.equal(h.closedIssues.length, 0);
  });

  it("does not trust exit zero without health=pass in the structured report", async () => {
    const h = harness({
      shipResult: {
        ok: true,
        stdout: "::autoship:: state=deployment_failed_rollback_succeeded health=fail merged=merge789 deployed=old111 rollback=old111\n",
        stderr: "",
        code: 0,
      },
    });
    const r = await shipRun(h.deps, { pr: 42, issueNumber: 4 });
    assert.equal(r.action, "deploy_failed");
    assert.equal(h.closedIssues.length, 0);
  });

  it("rejects a shipped report whose merge SHA does not match a fresh GitHub read", async () => {
    const h = harness({
      shipResult: {
        ok: true,
        stdout: "::autoship:: state=shipped health=pass merged=STALESHA deployed=STALESHA\n",
        stderr: "",
        code: 0,
      },
    });
    const r = await shipRun(h.deps, { pr: 42, issueNumber: null });
    assert.equal(r.action, "deploy_failed");
    assert.equal(h.closedIssues.length, 0);
  });
});

describe("shipRun — already-merged PR (safe rerun)", () => {
  it("deploys and verifies the exact merge SHA without re-checking CI or conflicts", async () => {
    const h = harness({ prState: "merged", ci: "fail", mergeStateStatus: "DIRTY" });
    const r = await shipRun(h.deps, { pr: 42, issueNumber: 4 });
    assert.equal(r.action, "shipped");
    assert.equal(h.shipped.length, 1);
    assert.equal(h.shipped[0]!.env.AUTOSHIP_MERGED_SHA, "merge789");
    assert.deepEqual(h.closedIssues, [4]);
  });

  it("blocks when the merged PR's merge commit SHA cannot be read", async () => {
    const h = harness({ prState: "merged", mergeInfo: { mergeCommitOid: null } });
    const r = await shipRun(h.deps, { pr: 42, issueNumber: null });
    assert.equal(r.action, "blocked");
    assert.equal(h.shipped.length, 0);
  });
});
