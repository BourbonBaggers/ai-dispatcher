import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRepoSlug, parseCliConfig } from "../src/config.ts";

test("parseRepoSlug accepts a canonical owner/repository", () => {
  const result = parseRepoSlug("BourbonBaggers/internal-tools");
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok && result.value, {
    owner: "BourbonBaggers",
    repo: "internal-tools",
    slug: "BourbonBaggers/internal-tools",
  });
});

test("parseRepoSlug rejects a missing repository", () => {
  for (const bad of [undefined, null, "", "   "]) {
    const result = parseRepoSlug(bad);
    assert.equal(result.ok, false, `expected ${JSON.stringify(bad)} to be rejected`);
  }
});

test("parseRepoSlug rejects malformed identifiers", () => {
  const bad = [
    "internal-tools", // no owner
    "owner/repo/extra", // too many segments
    "owner//repo", // empty middle
    "-owner/repo", // leading hyphen in owner
    "owner-/repo", // trailing hyphen in owner
    "own er/repo", // space
    "owner/re po", // space in repo
    "owner/.", // dot repo
    "owner/..", // dotdot repo
    "owner/re$po", // invalid char
  ];
  for (const value of bad) {
    const result = parseRepoSlug(value);
    assert.equal(result.ok, false, `expected ${value} to be rejected`);
  }
});

test("parseRepoSlug accepts dots, underscores and hyphens in the repo name", () => {
  for (const value of ["a/b", "Org123/my_repo.js", "x-y/z-1.2_3"]) {
    assert.equal(parseRepoSlug(value).ok, true, `expected ${value} accepted`);
  }
});

test("parseCliConfig requires --repo (or DISPATCHER_REPO) and never falls back", () => {
  const result = parseCliConfig([], {
    DISPATCHER_REPO_DIR: "/mirror",
    DISPATCHER_WORKTREE_DIR: "/worktrees",
  });
  assert.equal(result.ok, false);
  assert.match(result.message ?? "", /repository is required|Invalid repository/);
});

test("parseCliConfig fails fast on a malformed --repo before anything else", () => {
  const result = parseCliConfig(["--repo", "not-a-slug"], {
    DISPATCHER_REPO_DIR: "/mirror",
    DISPATCHER_WORKTREE_DIR: "/worktrees",
  });
  assert.equal(result.ok, false);
  assert.match(result.message ?? "", /Invalid repository/);
});

test("parseCliConfig resolves a full config with the flag winning over env", () => {
  const result = parseCliConfig(["--repo", "acme/widgets", "--once", "--interval", "120"], {
    DISPATCHER_REPO: "other/thing",
    DISPATCHER_REPO_DIR: "/mirror",
    DISPATCHER_WORKTREE_DIR: "/worktrees",
    DISPATCHER_MAX_RUNTIME_MINUTES: "45",
  });
  assert.equal(result.ok, true);
  const c = result.config!;
  assert.equal(c.repo.slug, "acme/widgets"); // flag wins over DISPATCHER_REPO
  assert.equal(c.once, true);
  assert.equal(c.pollIntervalSeconds, 120);
  assert.equal(c.maxRuntimeMinutes, 45);
  assert.equal(c.dryRun, false);
});

test("parseCliConfig falls back to DISPATCHER_REPO when no flag is given", () => {
  const result = parseCliConfig([], {
    DISPATCHER_REPO: "acme/widgets",
    DISPATCHER_REPO_DIR: "/mirror",
    DISPATCHER_WORKTREE_DIR: "/worktrees",
  });
  assert.equal(result.ok, true);
  assert.equal(result.config!.repo.slug, "acme/widgets");
});

test("parseCliConfig requires repo-dir and worktree-dir", () => {
  const noRepoDir = parseCliConfig(["--repo", "a/b"], { DISPATCHER_WORKTREE_DIR: "/w" });
  assert.equal(noRepoDir.ok, false);
  assert.match(noRepoDir.message ?? "", /mirror checkout is required/);

  const noWorktree = parseCliConfig(["--repo", "a/b"], { DISPATCHER_REPO_DIR: "/m" });
  assert.equal(noWorktree.ok, false);
  assert.match(noWorktree.message ?? "", /worktree directory is required/);
});

test("parseCliConfig rejects an invalid log level", () => {
  const result = parseCliConfig(["--repo", "a/b", "--log-level", "loud"], {
    DISPATCHER_REPO_DIR: "/m",
    DISPATCHER_WORKTREE_DIR: "/w",
  });
  assert.equal(result.ok, false);
  assert.match(result.message ?? "", /Invalid --log-level/);
});

test("parseCliConfig --help returns usage", () => {
  const result = parseCliConfig(["--help"], {});
  assert.equal(result.ok, true);
  assert.equal(result.help, true);
  assert.match(result.message ?? "", /Usage:/);
});
