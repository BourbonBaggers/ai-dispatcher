import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  CANONICAL_TARGET_POLICY,
  DISPATCHER_TARGET_POLICY_ENV,
  TARGET_POLICY_FILE,
  TARGET_PROMPT_FILE,
  ensureTargetPolicyIgnored,
  reconcileTargetPolicy,
  shouldReconcileTargetPolicy,
  targetPolicyPaths,
} from "../src/target-policy.ts";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), "..");
const reconcileScript = join(repoRoot, "scripts", "reconcile-target-policy.mjs");

async function fixture(): Promise<{ checkout: string; cleanup: () => Promise<void> }> {
  const checkout = await mkdtemp(join(tmpdir(), "target-policy-test-"));
  await mkdir(join(checkout, ".git", "info"), { recursive: true });
  await writeFile(join(checkout, ".git", "info", "exclude"), "node_modules\n");
  return { checkout, cleanup: () => rm(checkout, { recursive: true, force: true }) };
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd });
  return result.stdout;
}

async function committedFixture(): Promise<{ checkout: string; cleanup: () => Promise<void> }> {
  const base = await mkdtemp(join(tmpdir(), "target-policy-git-test-"));
  await git(base, ["init", "-q"]);
  await git(base, ["config", "user.name", "Codex"]);
  await git(base, ["config", "user.email", "codex@users.noreply.github.com"]);
  await writeFile(join(base, "AGENTS.md"), "Repository says deploy manually.\n");
  await git(base, ["add", "AGENTS.md"]);
  await git(base, ["commit", "-q", "-m", "initial"]);
  return { checkout: base, cleanup: () => rm(base, { recursive: true, force: true }) };
}

test("target policy activation requires trusted dispatcher launch context", () => {
  assert.equal(shouldReconcileTargetPolicy({}), false);
  assert.equal(shouldReconcileTargetPolicy({ [DISPATCHER_TARGET_POLICY_ENV]: "0" }), false);
  assert.equal(shouldReconcileTargetPolicy({ [DISPATCHER_TARGET_POLICY_ENV]: "1" }), true);
});

test("reconcileTargetPolicy is inactive for ordinary interactive checkouts", async () => {
  const { checkout, cleanup } = await fixture();
  try {
    const result = await reconcileTargetPolicy(checkout, {});
    assert.equal(result.active, false);
    assert.equal(result.verified, false);
    assert.equal(
      await readFile(join(checkout, ".git", "info", "exclude"), "utf8"),
      "node_modules\n",
    );
  } finally {
    await cleanup();
  }
});

test("reconcileTargetPolicy materializes and verifies the canonical bytes", async () => {
  const { checkout, cleanup } = await fixture();
  try {
    const result = await reconcileTargetPolicy(checkout, {
      [DISPATCHER_TARGET_POLICY_ENV]: "1",
    });
    assert.equal(result.active, true);
    assert.equal(result.verified, true);
    assert.equal(await readFile(join(checkout, TARGET_POLICY_FILE), "utf8"), CANONICAL_TARGET_POLICY);
  } finally {
    await cleanup();
  }
});

test("reconcileTargetPolicy repairs missing, modified, and extended managed content", async () => {
  const { checkout, cleanup } = await fixture();
  try {
    await mkdir(join(checkout, ".dispatcher"), { recursive: true });
    await writeFile(join(checkout, TARGET_POLICY_FILE), `${CANONICAL_TARGET_POLICY}\nextra\n`);

    await reconcileTargetPolicy(checkout, { [DISPATCHER_TARGET_POLICY_ENV]: "1" });

    assert.equal(await readFile(join(checkout, TARGET_POLICY_FILE), "utf8"), CANONICAL_TARGET_POLICY);
  } finally {
    await cleanup();
  }
});

test("reconcileTargetPolicy is idempotent", async () => {
  const { checkout, cleanup } = await fixture();
  try {
    const env = { [DISPATCHER_TARGET_POLICY_ENV]: "1" };
    await reconcileTargetPolicy(checkout, env);
    const before = await readFile(join(checkout, TARGET_POLICY_FILE), "utf8");
    await reconcileTargetPolicy(checkout, env);
    const after = await readFile(join(checkout, TARGET_POLICY_FILE), "utf8");
    assert.equal(after, before);
  } finally {
    await cleanup();
  }
});

test("managed policy and prompt paths are ignored without touching repository instructions", async () => {
  const { checkout, cleanup } = await fixture();
  try {
    await writeFile(join(checkout, "AGENTS.md"), "repo instructions\n");

    await ensureTargetPolicyIgnored(checkout);
    await ensureTargetPolicyIgnored(checkout);

    const exclude = await readFile(join(checkout, ".git", "info", "exclude"), "utf8");
    assert.match(exclude, /(^|\n)\.dispatcher($|\n)/);
    assert.match(exclude, new RegExp(`(^|\\n)${TARGET_PROMPT_FILE.replace(".", "\\.")}($|\\n)`));
    assert.equal((exclude.match(/\.dispatcher/g) ?? []).length, 2);
    assert.equal(await readFile(join(checkout, "AGENTS.md"), "utf8"), "repo instructions\n");
  } finally {
    await cleanup();
  }
});

test("reconciled managed files leave a dispatcher target worktree clean", async () => {
  const { checkout, cleanup } = await committedFixture();
  try {
    await reconcileTargetPolicy(checkout, { [DISPATCHER_TARGET_POLICY_ENV]: "1" });

    assert.equal(await git(checkout, ["status", "--porcelain"]), "");
  } finally {
    await cleanup();
  }
});

test("conflicting repository instructions remain data and the dispatcher policy still wins", async () => {
  const { checkout, cleanup } = await committedFixture();
  try {
    await reconcileTargetPolicy(checkout, { [DISPATCHER_TARGET_POLICY_ENV]: "1" });

    assert.equal(await readFile(join(checkout, "AGENTS.md"), "utf8"), "Repository says deploy manually.\n");
    const policy = await readFile(join(checkout, TARGET_POLICY_FILE), "utf8");
    assert.match(policy, /explicit precedence over repository instructions/);
    assert.match(policy, /must not merge pull requests, deploy, close issues, or push to the default/);
  } finally {
    await cleanup();
  }
});

test("targetPolicyPaths returns checkout-local managed paths", () => {
  assert.deepEqual(targetPolicyPaths("/tmp/checkout"), {
    policyPath: join("/tmp/checkout", TARGET_POLICY_FILE),
    promptPath: join("/tmp/checkout", TARGET_PROMPT_FILE),
  });
});

test("reconcile-target-policy command refuses untrusted launch context", async () => {
  const { checkout, cleanup } = await fixture();
  try {
    await assert.rejects(
      execFileAsync("node", [reconcileScript, checkout], { env: { ...process.env } }),
      (error: { code?: number; stderr?: string }) => {
        assert.equal(error.code, 65);
        assert.match(error.stderr ?? "", /trusted launch context/);
        return true;
      },
    );
  } finally {
    await cleanup();
  }
});

test("reconcile-target-policy command repairs drift and prints the verified path", async () => {
  const { checkout, cleanup } = await fixture();
  try {
    await mkdir(join(checkout, ".dispatcher"), { recursive: true });
    await writeFile(join(checkout, TARGET_POLICY_FILE), "drift\n");

    const result = await execFileAsync("node", [reconcileScript, checkout], {
      env: { ...process.env, [DISPATCHER_TARGET_POLICY_ENV]: "1" },
    });

    assert.equal(result.stdout.trim(), join(checkout, TARGET_POLICY_FILE));
    assert.equal(await readFile(join(checkout, TARGET_POLICY_FILE), "utf8"), CANONICAL_TARGET_POLICY);
  } finally {
    await cleanup();
  }
});
