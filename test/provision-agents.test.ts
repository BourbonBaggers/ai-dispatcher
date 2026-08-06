import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, "..");
const scriptPath = join(repoRoot, "scripts", "provision-agents.sh");

async function makeFixture(): Promise<{
  cwd: string;
  binDir: string;
  gitLogPath: string;
  cleanup: () => Promise<void>;
}> {
  const cwd = await mkdtemp(join(tmpdir(), "provision-agents-test-"));
  const binDir = join(cwd, "fake-bin");
  const gitLogPath = join(cwd, "git-args.log");
  const codexDir = join(cwd, ".codex");
  const claudeDir = join(cwd, ".claude");

  await mkdir(binDir);
  await mkdir(codexDir);
  await mkdir(claudeDir);
  await writeFile(join(codexDir, "auth.json"), "{\"token\":\"test\"}\n", { mode: 0o600 });
  await writeFile(join(claudeDir, ".credentials.json"), "{\"token\":\"test\"}\n", { mode: 0o600 });
  await writeFile(
    join(binDir, "git"),
    String.raw`#!/usr/bin/env bash
set -euo pipefail
case "${'${'}1:-}" in
  --version)
    printf 'git version 2.46.0\\n'
    exit 0
    ;;
  clone)
    printf '%s\\n' "$*" >> "$FAKE_GIT_LOG"
    mkdir -p "$4/.git"
    exit 0
    ;;
  fetch|reset|config|rev-parse)
    printf '%s\\n' "$*" >> "$FAKE_GIT_LOG"
    exit 0
    ;;
esac
printf '%s\\n' "$*" >> "$FAKE_GIT_LOG"
exit 0
`,
    { mode: 0o755 },
  );
  await writeFile(
    join(binDir, "gh"),
    String.raw`#!/usr/bin/env bash
set -euo pipefail
case "${'${'}1:-}" in
  --version)
    printf 'gh version 2.63.2 (2026-01-01)\\n'
    ;;
  auth)
    if [[ "${'${'}2:-}" == "status" || "${'${'}2:-}" == "setup-git" ]]; then
      exit 0
    fi
    ;;
esac
exit 0
`,
    { mode: 0o755 },
  );
  await writeFile(
    join(binDir, "codex"),
    String.raw`#!/usr/bin/env bash
set -euo pipefail
printf 'codex 0.0.0\\n'
`,
    { mode: 0o755 },
  );
  await writeFile(
    join(binDir, "claude"),
    String.raw`#!/usr/bin/env bash
set -euo pipefail
printf 'claude 0.0.0\\n'
`,
    { mode: 0o755 },
  );

  return {
    cwd,
    binDir,
    gitLogPath,
    cleanup: () => rm(cwd, { recursive: true, force: true }),
  };
}

test("provisioning script is parameterized through documented dispatcher config", async () => {
  const script = await readFile(scriptPath, "utf8");

  assert.match(script, /DISPATCHER_REPO/);
  assert.match(script, /DISPATCHER_REPO_DIR/);
  assert.match(script, /DISPATCHER_WORKTREE_DIR/);
  assert.match(script, /DISPATCHER_ENV_SOURCE_DIR/);
  assert.match(script, /--repo <owner\/repo>/);
  assert.match(script, /--env-source-dir <path>/);

  assert.doesNotMatch(script, /DISPATCHER_ENV_SOURCE\b/);
  assert.doesNotMatch(script, /--repo-slug/);
  assert.doesNotMatch(script, /--env-source(?!-dir)/);
});

test("provisioning script threads repo and path config through its shell entrypoint", async () => {
  const fixture = await makeFixture();
  const repoDir = join(fixture.cwd, "dispatcher-checkout");
  const worktreeDir = join(fixture.cwd, "worktrees");
  const envSourceDir = join(fixture.cwd, "env-source");

  await mkdir(envSourceDir);
  await writeFile(join(envSourceDir, ".env"), "DISPATCHER_REPO=ignored/ignored\n", { mode: 0o600 });

  try {
    const result = await execFileAsync(
      "bash",
      [
        scriptPath,
        "--repo",
        "owner/repo",
        "--repo-dir",
        repoDir,
        "--worktree-dir",
        worktreeDir,
        "--env-source-dir",
        envSourceDir,
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          PATH: `${fixture.binDir}:${process.env.PATH ?? ""}`,
          FAKE_GIT_LOG: fixture.gitLogPath,
          HOME: fixture.cwd,
        },
      },
    );

    assert.match(result.stdout, /cloned owner\/repo →/);

    const gitLog = await readFile(fixture.gitLogPath, "utf8");
    assert.match(gitLog, new RegExp(`clone --quiet https://github\\.com/owner/repo\\.git ${escapeForRegExp(repoDir)}`));
    await assert.doesNotReject(stat(join(repoDir, ".git")));
    await assert.doesNotReject(access(worktreeDir));
    await assert.doesNotReject(readFile(join(fixture.cwd, ".codex", "auth.json"), "utf8"));
    await assert.doesNotReject(readFile(join(fixture.cwd, ".claude", ".credentials.json"), "utf8"));
  } finally {
    await fixture.cleanup();
  }
});

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
