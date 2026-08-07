import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseEnvFile, parseInitCommand, runDoctor, runInit } from "../src/setup.ts";
import type { ExecFn } from "../src/exec.ts";

test("parseEnvFile reads inert assignments without evaluating shell syntax", () => {
  assert.deepEqual(
    parseEnvFile("export DISPATCHER_REPO=owner/repo\nVALUE=$(touch /tmp/nope)\n# comment\n"),
    { DISPATCHER_REPO: "owner/repo", VALUE: "$(touch /tmp/nope)" },
  );
});

test("parseInitCommand requires a canonical target repository", () => {
  assert.equal(parseInitCommand([], {}).ok, false);
  const parsed = parseInitCommand(["--repo", "owner/repo", "--trusted-author", "alice"], {});
  assert.equal(parsed.ok, true);
  assert.equal(parsed.options?.repo.slug, "owner/repo");
  assert.equal(parsed.options?.trustedAuthors, "alice");
});

test("runInit writes a private config, creates directories, and clones the mirror", async () => {
  const root = await mkdtemp(join(tmpdir(), "ai-dispatcher-init-"));
  const envFile = join(root, ".dispatcher", "env");
  const calls: string[][] = [];
  const exec: ExecFn = async (file, args) => {
    calls.push([file, ...args]);
    if (file === "gh" && args[0] === "repo") {
      const repoDir = args[3]!;
      await stat(join(repoDir, ".."));
      await mkdir(join(repoDir, ".git"), { recursive: true });
    }
    return { ok: true, stdout: "", stderr: "", code: 0 };
  };
  const lines: string[] = [];
  const code = await runInit(
    {
      repo: { owner: "owner", repo: "repo", slug: "owner/repo" },
      envFile,
      trustedAuthors: "alice",
      force: false,
    },
    (line) => lines.push(line),
    (line) => lines.push(`ERR: ${line}`),
    exec,
  );
  assert.equal(code, 0);
  assert.match(await readFile(envFile, "utf8"), /DISPATCHER_REPO=owner\/repo/);
  assert.match(await readFile(envFile, "utf8"), /DISPATCHER_TRUSTED_ISSUE_AUTHORS=alice/);
  assert.ok(calls.some((call) => call[0] === "gh" && call[1] === "repo" && call[2] === "clone"));
  assert.match(lines.join("\n"), /Next: ai-dispatcher doctor/);
});

test("runDoctor reports a ready configuration without exposing credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "ai-dispatcher-doctor-"));
  const repoDir = join(root, "repo");
  const worktreeDir = join(root, "worktrees");
  const stateDir = join(root, "state");
  const { writeFile } = await import("node:fs/promises");
  await mkdir(join(repoDir, ".git"), { recursive: true });
  await mkdir(worktreeDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  const envFile = join(root, "env");
  await writeFile(envFile, [
    "DISPATCHER_REPO=owner/repo",
    `DISPATCHER_REPO_DIR=${repoDir}`,
    `DISPATCHER_WORKTREE_DIR=${worktreeDir}`,
    `DISPATCHER_STATE_DIR=${stateDir}`,
    "DISPATCHER_TRUSTED_ISSUE_AUTHORS=alice",
  ].join("\n"));
  const exec: ExecFn = async (file, args) => {
    if (file === "gh" && args[0] === "repo") return { ok: true, stdout: '{"nameWithOwner":"owner/repo"}', stderr: "", code: 0 };
    return { ok: true, stdout: `${file} 1.0`, stderr: "", code: 0 };
  };
  const lines: string[] = [];
  const code = await runDoctor({ envFile }, { CODEX_API_KEY: "redacted-test-value" }, (line) => lines.push(line), exec);
  assert.equal(code, 0);
  assert.match(lines.join("\n"), /Doctor complete: ready to run/);
  assert.doesNotMatch(lines.join("\n"), /redacted-test-value/);
});
