import { test } from "node:test";
import assert from "node:assert/strict";
import {
  listIssuesArgs,
  addLabelArgs,
  removeLabelArgs,
  commentArgs,
  issueStateArgs,
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
