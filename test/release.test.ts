import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../src/state.ts";
import { releaseHeldRun } from "../src/release.ts";
import type { GithubClient } from "../src/github.ts";

test("release selects a confirmed merged PR and removes the hold label", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dispatcher-release-"));
  const store = StateStore.open(dir);
  try {
    const created = store.createRun({
      issueNumber: 93, issueTitle: "deploy", issueUrl: "https://github.com/o/r/issues/93",
      agent: "codex", modelLabel: "model:gpt-5.6-sol", cliModel: "gpt-5.6-sol",
      effortLabel: "effort:medium", cliEffort: "medium", branch: "issue-93",
      checkoutPath: "/tmp/issue-93", planPath: null, trigger: "poll",
    });
    store.updateRun(created.id, {
      status: "held", prNumber: 750,
      exhaustion: { kind: "deploy", reason: "failed", at: 1, labelApplied: true },
    });
    const removed: string[] = [];
    const github = {
      prState: async () => "merged",
      prMergeInfo: async () => ({ mergeCommitOid: "merged749" }),
      removeLabel: async (_issue: number, label: string) => { removed.push(label); return true; },
    } as unknown as Pick<GithubClient, "prState" | "prMergeInfo" | "removeLabel">;
    const result = await releaseHeldRun(store, github, "o/r", 93, 749);
    assert.deepEqual(result, { ok: true, pr: 749 });
    assert.deepEqual(removed, ["autoship-held"]);
    assert.equal(store.getRun(created.id)?.prNumber, 749);
    assert.deepEqual(store.getRun(created.id)?.mergedDelivery, { pr: 749, sha: "merged749" });
    assert.equal(store.getRun(created.id)?.status, "held", "the live dispatcher resumes the retained claim");
  } finally {
    store.releaseLock();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("release refuses an unmerged PR override without changing the held claim", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dispatcher-release-"));
  const store = StateStore.open(dir);
  try {
    const created = store.createRun({
      issueNumber: 93, issueTitle: "deploy", issueUrl: "https://github.com/o/r/issues/93",
      agent: "codex", modelLabel: "model:gpt-5.6-sol", cliModel: "gpt-5.6-sol",
      effortLabel: "effort:medium", cliEffort: "medium", branch: "issue-93",
      checkoutPath: "/tmp/issue-93", planPath: null, trigger: "poll",
    });
    store.updateRun(created.id, {
      status: "held", prNumber: 750,
      exhaustion: { kind: "deploy", reason: "failed", at: 1, labelApplied: true },
    });
    const github = {
      prState: async () => "open",
      prMergeInfo: async () => null,
      removeLabel: async () => { throw new Error("must not remove label"); },
    } as unknown as Pick<GithubClient, "prState" | "prMergeInfo" | "removeLabel">;
    const result = await releaseHeldRun(store, github, "o/r", 93, 749);
    assert.equal(result.ok, false);
    assert.equal(store.getRun(created.id)?.prNumber, 750);
  } finally {
    store.releaseLock();
    rmSync(dir, { recursive: true, force: true });
  }
});
