import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  gitCheckoutInspector,
  isPlanFileFor,
  planCandidates,
  readPlanProgress,
} from "../src/checkout-inspection.ts";

function checkout(): { path: string; git: (...args: string[]) => string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), "checkout-inspection-"));
  const git = (...args: string[]): string => {
    const result = spawnSync("git", args, { cwd: path, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init", "-q");
  git("config", "user.email", "inspection@example.invalid");
  git("config", "user.name", "Inspection");
  writeFileSync(join(path, "README.md"), "base\n");
  git("add", "README.md");
  git("commit", "-qm", "base");
  return { path, git, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

const run = (path: string, planPath: string | null = null) => ({
  checkoutPath: path,
  issueNumber: 773,
  planPath,
});

test("plan file names follow the launcher's and this repository's conventions", () => {
  assert.equal(isPlanFileFor("2026-10-01-issue773-cheap-local-verify.md", 773), true);
  assert.equal(isPlanFileFor(".plan-issue-773.md", 773), true);
  assert.equal(isPlanFileFor("PLAN-issue-773.md", 773), true);
  assert.equal(isPlanFileFor("issue773.md", 773), true);
  assert.equal(isPlanFileFor("2026-10-01-issue7731-other.md", 773), false, "a longer number is another issue");
  assert.equal(isPlanFileFor("2026-10-01-issue77-other.md", 773), false);
  assert.equal(isPlanFileFor("tissue773-x.md", 773), false);
  assert.equal(isPlanFileFor("issue773-notes.txt", 773), false);
});

test("a missing checkout is reported as missing, not as clean", async () => {
  const snapshot = await gitCheckoutInspector().inspect(run(join(tmpdir(), "no-such-checkout-773")));
  assert.deepEqual(snapshot, { state: "missing" });
});

test("inspection reports HEAD, the agent's dirty work only, and plan progress (#109)", async () => {
  const { path, git, cleanup } = checkout();
  try {
    mkdirSync(join(path, "docs", "plans"), { recursive: true });
    writeFileSync(
      join(path, "docs", "plans", "2026-10-01-issue773-verify.md"),
      "## [DONE] Milestone 1: a\n## [DONE] Milestone 2: b\n",
    );
    git("add", "docs");
    git("commit", "-qm", "plan");
    // Dispatcher-owned files, one tracked by mistake: none of them is unpublished work.
    writeFileSync(join(path, ".dispatcher-deps-key"), "old\n");
    git("add", ".dispatcher-deps-key");
    git("commit", "-qm", "accidental capture");
    writeFileSync(join(path, ".dispatcher-deps-key"), "new\n");
    writeFileSync(join(path, ".dispatcher-prompt.md"), "prompt\n");
    mkdirSync(join(path, ".dispatcher"));
    writeFileSync(join(path, ".dispatcher", "policy.md"), "policy\n");
    const indexBefore = statSync(join(path, ".git", "index")).mtimeMs;

    const clean = await gitCheckoutInspector().inspect(run(path));
    assert.deepEqual(clean, {
      state: "present",
      head: git("rev-parse", "HEAD"),
      dirty: [],
      plan: { path: "docs/plans/2026-10-01-issue773-verify.md", total: 2, done: 2 },
    });
    assert.equal(statSync(join(path, ".git", "index")).mtimeMs, indexBefore, "read-only: index untouched");

    writeFileSync(join(path, "README.md"), "uncommitted\n");
    writeFileSync(join(path, "new.ts"), "export {};\n");
    const dirty = await gitCheckoutInspector().inspect(run(path));
    assert.equal(dirty.state === "present" && dirty.dirty.join("|"), " M README.md|?? new.ts");
  } finally {
    cleanup();
  }
});

test("the launcher-reported plan wins, then docs/plans, then the root conventions", () => {
  const { path, cleanup } = checkout();
  try {
    writeFileSync(join(path, ".plan-issue-773.md"), "## Milestone 1: root\n");
    assert.deepEqual(readPlanProgress(path, 773, null), { path: ".plan-issue-773.md", total: 1, done: 0 });

    mkdirSync(join(path, "docs", "plans"), { recursive: true });
    writeFileSync(join(path, "docs", "plans", "a-issue773-x.md"), "## [DONE] Milestone 1: x\n");
    assert.equal(readPlanProgress(path, 773, null)?.path, "docs/plans/a-issue773-x.md");

    writeFileSync(join(path, "reported.md"), "## [DONE] Milestone 1: r\n## Milestone 2: r\n");
    assert.deepEqual(readPlanProgress(path, 773, "reported.md"), { path: "reported.md", total: 2, done: 1 });
    assert.deepEqual(planCandidates(path, 773, "reported.md"), [
      "reported.md",
      "docs/plans/a-issue773-x.md",
      ".plan-issue-773.md",
      "PLAN-issue-773.md",
    ]);
  } finally {
    cleanup();
  }
});

test("a plan path outside the checkout is never read", () => {
  const { path, cleanup } = checkout();
  const outside = mkdtempSync(join(tmpdir(), "outside-plan-"));
  try {
    writeFileSync(join(outside, "plan.md"), "## [DONE] Milestone 1: forged\n");
    assert.equal(readPlanProgress(path, 773, join(outside, "plan.md")), null);
    assert.equal(readPlanProgress(path, 773, "../" + outside.split("/").pop() + "/plan.md"), null);
    assert.equal(readFileSync(join(outside, "plan.md"), "utf8").length > 0, true);
  } finally {
    cleanup();
    rmSync(outside, { recursive: true, force: true });
  }
});

test("published means the PR head contains HEAD; an unknown head proves nothing", async () => {
  const { path, git, cleanup } = checkout();
  try {
    const inspector = gitCheckoutInspector();
    const base = git("rev-parse", "HEAD");
    writeFileSync(join(path, "pushed.ts"), "1\n");
    git("add", "pushed.ts");
    git("commit", "-qm", "pushed");
    const prHead = git("rev-parse", "HEAD");

    assert.equal(await inspector.headContainedIn(run(path), prHead), true, "HEAD is the PR head");
    git("reset", "-q", "--hard", base);
    assert.equal(await inspector.headContainedIn(run(path), prHead), true, "checkout behind the PR");

    writeFileSync(join(path, "local.ts"), "2\n");
    git("add", "local.ts");
    git("commit", "-qm", "local only");
    assert.equal(await inspector.headContainedIn(run(path), prHead), false, "a commit the PR lacks");

    assert.equal(await inspector.headContainedIn(run(path), "f".repeat(40)), null, "never fetched");
    assert.equal(await inspector.headContainedIn(run(path), "--output=/tmp/x"), null, "not a SHA");
  } finally {
    cleanup();
  }
});
