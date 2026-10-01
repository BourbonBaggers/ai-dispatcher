import { mock, test } from "node:test";
import assert from "node:assert/strict";
import {
  listIssuesArgs,
  addLabelArgs,
  removeLabelArgs,
  commentArgs,
  issueStateArgs,
  issueLabelsArgs,
  issueBodyArgs,
  prReadyArgs,
  closeIssueArgs,
  reopenIssueArgs,
  prChecksArgs,
  prMergeInfoArgs,
  prStateArgs,
  prTitleBodyArgs,
  prDiffArgs,
  prFilesArgs,
  createPullRequestArgs,
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
    issueBodyArgs(SLUG, 5),
    prReadyArgs(SLUG, 7),
    closeIssueArgs(SLUG, 5),
    reopenIssueArgs(SLUG, 5),
    prChecksArgs(SLUG, 7),
    prMergeInfoArgs(SLUG, 7),
    prStateArgs(SLUG, 7),
    prTitleBodyArgs(SLUG, 7),
    prDiffArgs(SLUG, 7),
    createPullRequestArgs(SLUG, { base: "main", head: "feature", title: "t" }),
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

test("createPullRequestArgs uses --body-file - so the body never enters argv", () => {
  const args = createPullRequestArgs(SLUG, { base: "main", head: "feature", title: "t" });
  assert.deepEqual(args.slice(-2), ["--body-file", "-"]);
  assert.ok(!args.includes("--draft"));
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
        mergeCommit: { oid: "merge789" },
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
    mergeCommitOid: "merge789",
  });
});

test("prMergeInfo fails closed on malformed JSON", async () => {
  const repo = parseRepoSlug(SLUG);
  const { fn } = fakeExec(() => ok("{}"));
  const client = new GithubClient(repo.ok ? repo.value : (undefined as never), fn);
  assert.equal(await client.prMergeInfo(4), null);
});

test("prState maps gh pr view state to a lowercase lifecycle value", async () => {
  const repo = parseRepoSlug(SLUG);
  const cases: Array<[string, "open" | "merged" | "closed" | "unknown"]> = [
    ["OPEN", "open"],
    ["MERGED", "merged"],
    ["CLOSED", "closed"],
    ["weird", "unknown"],
  ];
  for (const [raw, expected] of cases) {
    const { fn } = fakeExec(() => ok(`${raw}\n`));
    const client: GithubClient = new GithubClient(
      repo.ok ? repo.value : (undefined as never),
      fn,
    );
    assert.equal(await client.prState(4), expected);
  }
});

test("prState fails safe (unknown, treated like open) on a gh read failure", async () => {
  const repo = parseRepoSlug(SLUG);
  const { fn } = fakeExec(() => ({ ok: false, stdout: "", stderr: "boom", code: 1 }));
  const client = new GithubClient(repo.ok ? repo.value : (undefined as never), fn);
  assert.equal(await client.prState(4), "unknown");
});

test("prTitleAndBody parses the PR's title and body", async () => {
  const repo = parseRepoSlug(SLUG);
  const { fn } = fakeExec(() => ok(JSON.stringify({ title: "Add widgets", body: "Issue: #4" })));
  const client = new GithubClient(repo.ok ? repo.value : (undefined as never), fn);
  assert.deepEqual(await client.prTitleAndBody(4), { title: "Add widgets", body: "Issue: #4" });
});

test("prTitleAndBody treats a missing body as empty rather than failing closed", async () => {
  const repo = parseRepoSlug(SLUG);
  const { fn } = fakeExec(() => ok(JSON.stringify({ title: "Add widgets" })));
  const client = new GithubClient(repo.ok ? repo.value : (undefined as never), fn);
  assert.deepEqual(await client.prTitleAndBody(4), { title: "Add widgets", body: "" });
});

test("prTitleAndBody fails closed on a gh read failure or malformed JSON", async () => {
  const repo = parseRepoSlug(SLUG);
  const { fn: failFn } = fakeExec(() => ({ ok: false, stdout: "", stderr: "boom", code: 1 }));
  const failClient = new GithubClient(repo.ok ? repo.value : (undefined as never), failFn);
  assert.equal(await failClient.prTitleAndBody(4), null);

  const { fn: badFn } = fakeExec(() => ok("not json"));
  const badClient = new GithubClient(repo.ok ? repo.value : (undefined as never), badFn);
  assert.equal(await badClient.prTitleAndBody(4), null);
});

test("issueLabels parses label names from the issue", async () => {
  const repo = parseRepoSlug(SLUG);
  const { fn } = fakeExec(() =>
    ok(JSON.stringify({ labels: [{ name: "human-review-required" }, { name: "bug" }] })),
  );
  const client = new GithubClient(repo.ok ? repo.value : (undefined as never), fn);
  assert.deepEqual(await client.issueLabels(6), ["human-review-required", "bug"]);
});

test("issueLabels preserves unknown on a gh failure or malformed JSON", async () => {
  const repo = parseRepoSlug(SLUG);
  const failing = fakeExec(() => ({ ok: false, stdout: "", stderr: "boom", code: 1 }));
  const failingClient = new GithubClient(repo.ok ? repo.value : (undefined as never), failing.fn);
  assert.equal(await failingClient.issueLabels(6), null);

  const malformed = fakeExec(() => ok("not json"));
  const malformedClient = new GithubClient(repo.ok ? repo.value : (undefined as never), malformed.fn);
  assert.equal(await malformedClient.issueLabels(6), null);
});

test("issueBody parses the issue body and fails closed on unreadable data", async () => {
  const repo = parseRepoSlug(SLUG);
  const succeeding = fakeExec(() => ok(JSON.stringify({ body: "Blocked by #26." })));
  const successClient = new GithubClient(repo.ok ? repo.value : (undefined as never), succeeding.fn);
  assert.equal(await successClient.issueBody(6), "Blocked by #26.");

  const failing = fakeExec(() => ({ ok: false, stdout: "", stderr: "boom", code: 1 }));
  const failClient = new GithubClient(repo.ok ? repo.value : (undefined as never), failing.fn);
  assert.equal(await failClient.issueBody(6), null);

  const malformed = fakeExec(() => ok("not json"));
  const malformedClient = new GithubClient(repo.ok ? repo.value : (undefined as never), malformed.fn);
  assert.equal(await malformedClient.issueBody(6), null);
});

// gh 2.63.2 on a PR whose head commit has no checks yet: no JSON even under --json, and
// exit 1 -- the same exit code as a red check.
const NO_CHECKS: ExecResult = {
  ok: false,
  stdout: "",
  stderr: "no checks reported on the 'issue-7-widgets' branch\n",
  code: 1,
};
const checksJson = (...buckets: string[]): ExecResult =>
  ok(JSON.stringify(buckets.map((bucket, i) => ({ name: `check-${i}`, bucket }))));

test("prChecksState separates red, pending, green, and unreadable GitHub state", async () => {
  const repo = parseRepoSlug(SLUG);
  assert.equal(repo.ok, true);
  const cases: Array<[ExecResult, "pass" | "pending" | "fail" | "unknown"]> = [
    [ok(JSON.stringify([{ bucket: "pass" }, { bucket: "skipping" }])), "pass"],
    [{ ok: false, stdout: JSON.stringify([{ bucket: "pending" }]), stderr: "", code: 8 }, "pending"],
    [{ ok: false, stdout: JSON.stringify([{ bucket: "fail" }]), stderr: "", code: 1 }, "fail"],
    [{ ok: false, stdout: "", stderr: "network unavailable", code: 1 }, "unknown"],
    // No checks registered yet is pending, never red and never unreadable (#96).
    [NO_CHECKS, "pending"],
    [ok("[]"), "pending"],
  ];
  for (const [result, expected] of cases) {
    const { fn } = fakeExec(() => result);
    const client: GithubClient = new GithubClient(
      repo.ok ? repo.value : (undefined as never),
      fn,
    );
    assert.equal(await client.prChecksState(7), expected);
  }
});

test("prChecksEvidence reports no registered checks as pending with a zero count (#96)", async () => {
  const repo = parseRepoSlug(SLUG);
  const evidence = async (result: ExecResult) =>
    new GithubClient(repo.ok ? repo.value : (undefined as never), fakeExec(() => result).fn)
      .prChecksEvidence(7);

  // The zero count is what lets autoship give a missing suite its own grace (#60).
  assert.deepEqual(await evidence(NO_CHECKS), { state: "pending", checkCount: 0 });
  assert.deepEqual(await evidence(ok("[]")), { state: "pending", checkCount: 0 });
  // A transport failure stays unreadable; only the exact no-checks report is absence.
  assert.deepEqual(
    await evidence({ ok: false, stdout: "", stderr: "HTTP 502: Bad Gateway", code: 1 }),
    { state: "unknown", checkCount: null },
  );
  assert.deepEqual(await evidence(checksJson("pass", "fail", "pending")), { state: "fail", checkCount: 3 });
  assert.deepEqual(await evidence(checksJson("cancel")), { state: "fail", checkCount: 1 });
  assert.deepEqual(await evidence(checksJson("pending", "pass")), { state: "pending", checkCount: 2 });
  assert.deepEqual(await evidence(ok("[null]")), { state: "unknown", checkCount: 1 });
});

/**
 * Drives waitForPrChecks on a virtual clock: every answer is one read, and each poll
 * interval passes instantly. Returns the verdict, the reads made, and the virtual time.
 */
async function waitOnVirtualClock(
  answers: ExecResult[],
  timeoutSeconds = 900,
): Promise<{ state: string; reads: number; elapsedMs: number }> {
  const repo = parseRepoSlug(SLUG);
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  try {
    let reads = 0;
    const exec: ExecFn = async () => answers[Math.min(reads++, answers.length - 1)]!;
    const client = new GithubClient(repo.ok ? repo.value : (undefined as never), exec);
    let state: string | undefined;
    const waiting = client.waitForPrChecks(7, timeoutSeconds).then((result) => {
      state = result;
    });
    for (let polls = 0; state === undefined; polls++) {
      assert.ok(polls < 1000, "waitForPrChecks never settled");
      await new Promise((resolve) => setImmediate(resolve));
      if (state === undefined) mock.timers.tick(20_000);
    }
    await waiting;
    return { state: state!, reads, elapsedMs: Date.now() };
  } finally {
    mock.timers.reset();
  }
}

test("waitForPrChecks: no checks then green keeps polling and passes", async () => {
  const run = await waitOnVirtualClock([NO_CHECKS, NO_CHECKS, checksJson("pending"), checksJson("pass")]);
  assert.deepEqual(run, { state: "pass", reads: 4, elapsedMs: 60_000 });
});

test("waitForPrChecks: no checks then red fails once a check fails", async () => {
  const run = await waitOnVirtualClock([NO_CHECKS, checksJson("pending"), checksJson("pass", "fail")]);
  assert.deepEqual(run, { state: "fail", reads: 3, elapsedMs: 40_000 });
});

test("waitForPrChecks: pending then green passes", async () => {
  const run = await waitOnVirtualClock([checksJson("pending"), checksJson("pass", "skipping")]);
  assert.deepEqual(run, { state: "pass", reads: 2, elapsedMs: 20_000 });
});

test("waitForPrChecks: no checks past the deadline is pending, never fail", async () => {
  const run = await waitOnVirtualClock([NO_CHECKS], 120);
  assert.equal(run.state, "pending");
  assert.equal(run.elapsedMs, 120_000);
  assert.equal(run.reads, 7);
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

test("createPullRequest parses the PR number from gh's printed URL and pipes body via stdin", async () => {
  const repo = parseRepoSlug(SLUG);
  const succeeding = fakeExec(() => ok("https://github.com/acme/widgets/pull/42\n"));
  const client = new GithubClient(repo.ok ? repo.value : (undefined as never), succeeding.fn);
  const pr = await client.createPullRequest({
    base: "main",
    head: "dispatcher/policy-cleanup-1",
    title: "Reconcile agent instructions with dispatcher policy",
    body: "Issue: none",
  });
  assert.equal(pr, 42);
  assert.equal(succeeding.calls[0]!.stdin, "Issue: none");
  assert.deepEqual(succeeding.calls[0]!.args.slice(-2), ["--body-file", "-"]);
});

test("createPullRequest fails closed on a gh failure or unparseable output", async () => {
  const repo = parseRepoSlug(SLUG);
  const failing = fakeExec(() => ({ ok: false, stdout: "", stderr: "already exists", code: 1 }));
  const failClient = new GithubClient(repo.ok ? repo.value : (undefined as never), failing.fn);
  assert.equal(
    await failClient.createPullRequest({ base: "main", head: "h", title: "t", body: "b" }),
    null,
  );

  const garbled = fakeExec(() => ok("not a url\n"));
  const garbledClient = new GithubClient(repo.ok ? repo.value : (undefined as never), garbled.fn);
  assert.equal(
    await garbledClient.createPullRequest({ base: "main", head: "h", title: "t", body: "b" }),
    null,
  );
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

test("reopenIssue repairs premature issue closure", async () => {
  const repo = parseRepoSlug(SLUG);
  const succeeding = fakeExec(() => ok());
  const client = new GithubClient(repo.ok ? repo.value : (undefined as never), succeeding.fn);
  assert.equal(await client.reopenIssue(366), true);
  assert.deepEqual(succeeding.calls[0]!.args, ["issue", "reopen", "366", "--repo", SLUG]);
});

// ── PR evidence for the post-ship audit (#98) ──────────────────────────────────

/** gh's real output for a PR over GitHub's 300-file diff limit (PR #760, 305 files). */
const DIFF_TOO_LARGE_STDERR = [
  "could not find pull request diff: HTTP 406: Sorry, the diff exceeded the maximum number of files (300). Consider using 'List pull requests files' API or locally cloning the repository instead. (https://api.github.com/repos/acme/widgets/pulls/760)",
  "PullRequest.diff too_large",
  "",
].join("\n");

function client(fn: ExecFn): GithubClient {
  const repo = parseRepoSlug(SLUG);
  return new GithubClient(repo.ok ? repo.value : (undefined as never), fn);
}

test("prDiff returns a readable diff", async () => {
  const { fn, calls } = fakeExec(() => ok("diff --git a/x b/x\n+1\n"));
  assert.deepEqual(await client(fn).prDiff(7), { state: "ok", diff: "diff --git a/x b/x\n+1\n" });
  assert.deepEqual(calls[0]!.args, ["pr", "diff", "7", "--repo", SLUG]);
});

// The refusal is permanent for the PR, so it must be told apart from a failed read.
test("prDiff reports a diff GitHub refuses as too large, apart from a failed read (#98)", async () => {
  const { fn: tooLarge } = fakeExec(() => ({ ok: false, stdout: "", stderr: DIFF_TOO_LARGE_STDERR, code: 1 }));
  assert.deepEqual(await client(tooLarge).prDiff(760), {
    state: "too_large",
    error: DIFF_TOO_LARGE_STDERR.split("\n")[0]!.slice(0, 200),
  });

  for (const stderr of [
    "HTTP 406: Sorry, the diff exceeded the maximum number of lines (20000).",
    "HTTP 422: Server Error: Sorry, this diff is taking too long to generate.",
  ]) {
    const { fn } = fakeExec(() => ({ ok: false, stdout: "", stderr, code: 1 }));
    assert.equal((await client(fn).prDiff(760)).state, "too_large", stderr);
  }

  for (const [stderr, error] of [
    ["HTTP 502: Bad Gateway (https://api.github.com/graphql)\n", "HTTP 502: Bad Gateway (https://api.github.com/graphql)"],
    ["", "gh exited 1"],
  ] as const) {
    const { fn } = fakeExec(() => ({ ok: false, stdout: "", stderr, code: 1 }));
    assert.deepEqual(await client(fn).prDiff(760), { state: "unavailable", error });
  }
});

test("prFilesArgs pages the files API for the configured repository only", () => {
  const args = prFilesArgs(SLUG, 760);
  assert.equal(args[0], "api");
  assert.ok(args.includes("--paginate"));
  assert.ok(args.includes(`repos/${SLUG}/pulls/760/files?per_page=100`));
  // One compact JSON object per line, whatever gh's output mode, and no removed-file patch.
  const jq = args[args.indexOf("--jq") + 1]!;
  assert.match(jq, /@json$/);
  assert.match(jq, /if \.status == "removed" then null else \.patch end/);
});

test("prFiles parses one changed file per line (#98)", async () => {
  const lines = [
    { filename: "CLAUDE.md", previous_filename: null, status: "modified", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-a\n+b" },
    { filename: "docs/new.md", previous_filename: "docs/old.md", status: "renamed", additions: 0, deletions: 0, patch: null },
    { filename: "docs/plans/gone.md", previous_filename: null, status: "removed", additions: 0, deletions: 96, patch: null },
  ].map((file) => JSON.stringify(file));
  const { fn, calls } = fakeExec(() => ok(`${lines.join("\n")}\n`));

  assert.deepEqual(await client(fn).prFiles(760), [
    { filename: "CLAUDE.md", status: "modified", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-a\n+b" },
    { filename: "docs/new.md", previousFilename: "docs/old.md", status: "renamed", additions: 0, deletions: 0 },
    { filename: "docs/plans/gone.md", status: "removed", additions: 0, deletions: 96 },
  ]);
  assert.deepEqual(calls[0]!.args, prFilesArgs(SLUG, 760));
});

// A partial list would make a file look untouched, which reads as work never attempted.
test("prFiles fails closed rather than returning a partial list (#98)", async () => {
  const good = JSON.stringify({ filename: "a", status: "modified", additions: 1, deletions: 0 });
  for (const result of [
    { ok: false, stdout: `${good}\n`, stderr: "HTTP 502", code: 1 },
    ok(`${good}\nnot json\n`),
    ok(`${good}\n${JSON.stringify({ status: "modified" })}\n`),
  ]) {
    const { fn } = fakeExec(() => result);
    assert.equal(await client(fn).prFiles(760), null, JSON.stringify(result));
  }
  const { fn: empty } = fakeExec(() => ok(""));
  assert.deepEqual(await client(empty).prFiles(760), []);
});
