import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Runs the launcher's own shell against real repositories. The TS mirror of the capture
// DECISION lives in capture.test.ts; this covers what the shell actually stages and
// reports, which is where dispatcher-owned files leaked into "unpublished work" (#109).

const libraryPath = new URL("../scripts/lib/dispatch-capture.sh", import.meta.url).pathname;
const launcherPath = new URL("../scripts/dispatch-agent.sh", import.meta.url).pathname;

function repo(): { cwd: string; git: (...args: string[]) => string; cleanup: () => void } {
  const cwd = mkdtempSync(join(tmpdir(), "dispatch-capture-"));
  const git = (...args: string[]): string => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  git("init", "-q");
  git("config", "user.email", "capture-test@example.invalid");
  git("config", "user.name", "Capture Test");
  writeFileSync(join(cwd, "README.md"), "base\n");
  // A repository that tracked its cache key by mistake (this one did, #102): no exclude
  // file can hide a tracked path, so the pathspecs alone must keep it out of the work.
  writeFileSync(join(cwd, ".dispatcher-deps-key"), "old-key\n");
  git("add", "README.md", ".dispatcher-deps-key");
  git("commit", "-qm", "base");
  return { cwd, git, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

/** Dirties every dispatcher-owned path the launcher or cache can leave behind. */
function dirtyManagedFiles(cwd: string): void {
  writeFileSync(join(cwd, ".dispatcher-deps-key"), "new-key\n");
  writeFileSync(join(cwd, ".dispatcher-prompt.md"), "prompt\n");
  writeFileSync(join(cwd, ".dispatcher-no-work-needed"), "");
  mkdirSync(join(cwd, ".dispatcher"), { recursive: true });
  writeFileSync(join(cwd, ".dispatcher", "policy.md"), "policy\n");
  mkdirSync(join(cwd, ".dispatcher-node-modules-77"), { recursive: true });
  writeFileSync(join(cwd, ".dispatcher-node-modules-77", "x.js"), "x\n");
}

function bash(cwd: string, script: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("bash", ["-c", `set -euo pipefail\nsource "${libraryPath}"\n${script}`], {
    cwd,
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("work_tree_status reports only the agent's work, never dispatcher-owned files (#109)", () => {
  const { cwd, cleanup } = repo();
  try {
    dirtyManagedFiles(cwd);
    assert.equal(bash(cwd, "work_tree_status").stdout, "");

    writeFileSync(join(cwd, "README.md"), "agent change\n");
    writeFileSync(join(cwd, "new.ts"), "export {};\n");
    assert.equal(bash(cwd, "work_tree_status").stdout, " M README.md\n?? new.ts\n");
  } finally {
    cleanup();
  }
});

test("the capture net never commits dispatcher-owned files as agent work (#109)", () => {
  const { cwd, git, cleanup } = repo();
  try {
    dirtyManagedFiles(cwd);
    const nothing = bash(cwd, "capture_uncommitted_work 109 0 0");
    assert.equal(nothing.status, 1, "only dispatcher files are dirty: nothing to rescue");
    assert.equal(git("rev-list", "--count", "HEAD").trim(), "1", "no capture commit");

    writeFileSync(join(cwd, "feature.ts"), "export const done = true;\n");
    const captured = bash(cwd, "capture_uncommitted_work 109 0 0");
    assert.equal(captured.status, 0, captured.stderr);
    assert.equal(git("log", "-1", "--pretty=%s").trim(), "dispatcher: capture uncommitted agent work for #109");
    assert.equal(git("show", "--name-only", "--pretty=format:", "HEAD").trim(), "feature.ts");
  } finally {
    cleanup();
  }
});

/** The launcher's dirty-tail decision, executed exactly as written in dispatch-agent.sh. */
function dirtyTailBlock(): string {
  const launcher = readFileSync(launcherPath, "utf8");
  const block = /^DIRTY_TAIL="\$\(work_tree_status\)"\n[\s\S]*?\n^fi$/m.exec(launcher)?.[0];
  assert.ok(block, "dispatch-agent.sh computes the dirty tail through work_tree_status");
  return block;
}

test("a clean exit whose only dirt is dispatcher-owned is published, not unpublished work (#109)", () => {
  const { cwd, cleanup } = repo();
  try {
    dirtyManagedFiles(cwd);
    const result = bash(
      cwd,
      `event() { printf 'EVENT %s\\n' "$*"; }\nEXIT_CODE=0\nCOMMITS_AHEAD=3\n${dirtyTailBlock()}\nprintf 'EXIT=%s\\n' "$EXIT_CODE"`,
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "EXIT=0\n");
  } finally {
    cleanup();
  }
});

test("a real dirty tail after earlier commits still becomes launcher recovery, naming the files", () => {
  const { cwd, cleanup } = repo();
  try {
    dirtyManagedFiles(cwd);
    writeFileSync(join(cwd, "README.md"), "uncommitted milestone work\n");
    const result = bash(
      cwd,
      `event() { printf 'EVENT %s\\n' "$*"; }\nEXIT_CODE=0\nCOMMITS_AHEAD=3\n${dirtyTailBlock()}\nprintf 'EXIT=%s\\n' "$EXIT_CODE"`,
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^EVENT UNPUBLISHED WORK: clean exit left dirty files after earlier commits \(README\.md \)/m);
    assert.doesNotMatch(result.stdout, /\.dispatcher/);
    assert.match(result.stdout, /EXIT=75\n$/);
  } finally {
    cleanup();
  }
});
