import { test } from "node:test";
import assert from "node:assert/strict";
import {
  listIssuesArgs,
  addLabelArgs,
  removeLabelArgs,
  commentArgs,
  issueStateArgs,
  issueLabelsArgs,
  prReadyArgs,
  closeIssueArgs,
  prChecksArgs,
  prMergeInfoArgs,
  GithubClient,
} from "../src/github.ts";
import type { ExecFn, ExecResult } from "../src/exec.ts";
import { parseRepoSlug } from "../src/config.ts";

const SLUG = "acme/widgets";

test("every gh argv builder threads --repo <slug> through", () => {
  const builders = [
    listIssuesArgs(SLUG),
    addLabelArgs(SLUG, 5, "agent-working"),
    removeLabelArgs(SLUG, 5, "agent-working"),
    commentArgs(SLUG, 5),
    issueStateArgs(SLUG, 5),
    issueLabelsArgs(SLUG, 5),
    prReadyArgs(SLUG, 7),
    closeIssueArgs(SLUG, 5),
    prChecksArgs(SLUG, 7),
    prMergeInfoArgs(SLUG, 7),
  ];
  for (const args of builders) {
    const idx = args.indexOf("--repo");
    assert.ok(idx >= 0, `expected --repo in ${args.join(" ")}`);
    assert.equal(args[idx + 1], SLUG);
  }
});

test("comment uses --body-file - so the body never enters argv", () => {
  const args = commentArgs(SLUG, 12);
  assert.deepEqual(args.slice(-2), ["--body-file", "-"]);
});

test("issue number is passed as a string argument, not interpolated", () => {
  assert.equal(addLabelArgs(SLUG, 99, "x")[2], "99");
});

function fakeExec(script: (file: string, args: string[]) => ExecResult): {
  fn: ExecFn;
  calls: Array<{ file: string; args: string[]; stdin: string | undefined }>;
} {
  const calls: Array<{ file: string; args: string[]; stdin: string | undefined }> = [];
  const fn: ExecFn = (file, args, options) => {
    calls.push({ file, args, stdin: options?.stdin });
    return Promise.resolve(script(file, args));
  };
  return { fn, calls };
}

function ok(stdout = ""): ExecResult {
  return { ok: true, stdout, stderr: "", code: 0 };
}

test("listOpenIssues parses gh JSON and sorts oldest-first", async () => {
  const repo = parseRepoSlug(SLUG);
  assert.equal(repo.ok, true);
  const { fn } = fakeExec(() =>
    ok(
      JSON.stringify([
        {
          number: 9,
          title: "b",
          url: "u9",
          labels: [{ name: "agent:claude" }],
          author: { login: "BourbonBaggers" },
        },
        { number: 3, title: "a", url: "u3", labels: [], author: { login: "octocat" } },
      ]),
    ),
  );
  const client = new GithubClient(repo.ok ? repo.value : (undefined as never), fn);
  const result = await client.listOpenIssues();
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(
      result.issues.map((i) => i.number),
      [3, 9],
    );
    assert.deepEqual(result.issues[0]!.labels, []);
    assert.deepEqual(result.issues[1]!.labels, ["agent:claude"]);
    assert.equal(result.issues[0]!.authorLogin, "octocat");
    assert.equal(result.issues[1]!.authorLogin, "BourbonBaggers");
  }
});

test("comment pipes the body via stdin, not argv", async () => {
  const repo = parseRepoSlug(SLUG);
  const { fn, calls } = fakeExec(() => ok());
  const client = new GithubClient(repo.ok ? repo.value : (undefined as never), fn);
  const body = "line one\n`backtick` and $(dangerous) — still just data";
  await client.comment(7, body);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.stdin, body);
  assert.ok(!calls[0]!.args.includes(body), "body must not appear in argv");
});

test("issueState returns UNKNOWN when gh fails", async () => {
  const repo = parseRepoSlug(SLUG);
  const { fn } = fakeExec(() => ({ ok: false, stdout: "", stderr: "boom", code: 1 }));
  const client = new GithubClient(repo.ok ? repo.value : (undefined as never), fn);
  assert.equal(await client.issueState(1), "UNKNOWN");
});

test("listOpenIssues reports an error on unparseable JSON", async () => {
  const repo = parseRepoSlug(SLUG);
  const { fn } = fakeExec(() => ok("not json"));
  const client = new GithubClient(repo.ok ? repo.value : (undefined as never), fn);
  const result = await client.listOpenIssues();
  assert.equal(result.ok, false);
});

test("prMergeInfo parses structured PR mergeability fields", async () => {
  const repo = parseRepoSlug(SLUG);
  const { fn } = fakeExec(() =>
    ok(
      JSON.stringify({
        baseRefName: "main",
        baseRefOid: "base123",
        headRefName: "issue-4-x",
        headRefOid: "head456",
        isDraft: false,
        mergeStateStatus: "DIRTY",
        reviewDecision: null,
      }),
    ),
  );
  const client = new GithubClient(repo.ok ? repo.value : (undefined as never), fn);
  assert.deepEqual(await client.prMergeInfo(4), {
    baseRefName: "main",
    baseRefOid: "base123",
    headRefName: "issue-4-x",
    headRefOid: "head456",
    isDraft: false,
    mergeStateStatus: "DIRTY",
    reviewDecision: null,
  });
});

test("prMergeInfo fails closed on malformed JSON", async () => {
  const repo = parseRepoSlug(SLUG);
  const { fn } = fakeExec(() => ok("{}"));
  const client = new GithubClient(repo.ok ? repo.value : (undefined as never), fn);
  assert.equal(await client.prMergeInfo(4), null);
});

test("issueLabels parses label names from the issue", async () => {
  const repo = parseRepoSlug(SLUG);
  const { fn } = fakeExec(() =>
    ok(JSON.stringify({ labels: [{ name: "human-review-required" }, { name: "bug" }] })),
  );
  const client = new GithubClient(repo.ok ? repo.value : (undefined as never), fn);
  assert.deepEqual(await client.issueLabels(6), ["human-review-required", "bug"]);
});

test("issueLabels fails safe (empty) on a gh failure or malformed JSON", async () => {
  const repo = parseRepoSlug(SLUG);
  const failing = fakeExec(() => ({ ok: false, stdout: "", stderr: "boom", code: 1 }));
  const failingClient = new GithubClient(repo.ok ? repo.value : (undefined as never), failing.fn);
  assert.deepEqual(await failingClient.issueLabels(6), []);

  const malformed = fakeExec(() => ok("not json"));
  const malformedClient = new GithubClient(repo.ok ? repo.value : (undefined as never), malformed.fn);
  assert.deepEqual(await malformedClient.issueLabels(6), []);
});

test("markPrReady runs gh pr ready and reports success/failure", async () => {
  const repo = parseRepoSlug(SLUG);
  const succeeding = fakeExec(() => ok());
  const successClient = new GithubClient(repo.ok ? repo.value : (undefined as never), succeeding.fn);
  assert.equal(await successClient.markPrReady(9), true);
  assert.deepEqual(succeeding.calls[0]!.args, ["pr", "ready", "9", "--repo", SLUG]);

  const failing = fakeExec(() => ({ ok: false, stdout: "", stderr: "already ready", code: 1 }));
  const failClient = new GithubClient(repo.ok ? repo.value : (undefined as never), failing.fn);
  assert.equal(await failClient.markPrReady(9), false);
});

test("closeIssue runs gh issue close and reports success/failure", async () => {
  const repo = parseRepoSlug(SLUG);
  const succeeding = fakeExec(() => ok());
  const successClient = new GithubClient(repo.ok ? repo.value : (undefined as never), succeeding.fn);
  assert.equal(await successClient.closeIssue(366), true);
  assert.deepEqual(succeeding.calls[0]!.args, ["issue", "close", "366", "--repo", SLUG]);

  const failing = fakeExec(() => ({ ok: false, stdout: "", stderr: "already closed", code: 1 }));
  const failClient = new GithubClient(repo.ok ? repo.value : (undefined as never), failing.fn);
  assert.equal(await failClient.closeIssue(366), false);
});
