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
  MANAGED_CHECKOUT_PATHSPECS,
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
    assert.match(exclude, /(^|\n)\/\.dispatcher-\*($|\n)/);
    assert.equal((exclude.match(/\.dispatcher/g) ?? []).length, 3, "idempotent: no duplicate lines");
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

// #109: the dependency-cache key sat untracked in every checkout, so each clean agent exit
// looked like an unpublished dirty tail and a finished, green PR was relaunched until the
// model ladder "exhausted".
test("dispatcher-owned run files never make a reconciled target worktree dirty (#109)", async () => {
  const { checkout, cleanup } = await committedFixture();
  try {
    await reconcileTargetPolicy(checkout, { [DISPATCHER_TARGET_POLICY_ENV]: "1" });
    await writeFile(join(checkout, ".dispatcher-deps-key"), "abc123\n");
    await mkdir(join(checkout, ".dispatcher-node-modules-4242", "pkg"), { recursive: true });
    await writeFile(join(checkout, ".dispatcher-node-modules-4242", "pkg", "index.js"), "x\n");
    await writeFile(join(checkout, ".dispatcher-no-work-needed"), "");

    assert.equal(await git(checkout, ["status", "--porcelain"]), "");

    // Anchored: a repository file elsewhere that merely shares the prefix is still work.
    await mkdir(join(checkout, "src"), { recursive: true });
    await writeFile(join(checkout, "src", ".dispatcher-notes"), "real work\n");
    assert.equal(await git(checkout, ["status", "--porcelain"]), "?? src/\n");
  } finally {
    await cleanup();
  }
});

test("managed pathspecs hide a dispatcher file a repository tracks by mistake, and nothing else (#109)", async () => {
  const { checkout, cleanup } = await committedFixture();
  try {
    // This repository committed its cache key through the capture safety net (#102); an
    // exclude file cannot hide a tracked path, so status must filter it explicitly.
    await writeFile(join(checkout, ".dispatcher-deps-key"), "old-key\n");
    await git(checkout, ["add", ".dispatcher-deps-key"]);
    await git(checkout, ["commit", "-q", "-m", "accidental capture"]);
    await reconcileTargetPolicy(checkout, { [DISPATCHER_TARGET_POLICY_ENV]: "1" });
    await writeFile(join(checkout, ".dispatcher-deps-key"), "new-key\n");

    const status = (extra: string[] = []) =>
      git(checkout, ["status", "--porcelain", "--", ".", ...MANAGED_CHECKOUT_PATHSPECS, ...extra]);
    assert.match(await git(checkout, ["status", "--porcelain"]), /M \.dispatcher-deps-key/);
    assert.equal(await status(), "");

    await writeFile(join(checkout, "AGENTS.md"), "changed\n");
    assert.equal(await status(), " M AGENTS.md\n");
  } finally {
    await cleanup();
  }
});

test("the launcher's managed pathspecs mirror the TypeScript list exactly", async () => {
  const library = await readFile(join(repoRoot, "scripts", "lib", "dispatch-capture.sh"), "utf8");
  const declared = /^DISPATCHER_MANAGED_PATHSPECS=\((.*)\)$/m.exec(library)?.[1];
  assert.ok(declared, "dispatch-capture.sh declares DISPATCHER_MANAGED_PATHSPECS");
  const shellList = [...declared.matchAll(/'([^']*)'/g)].map((match) => match[1]);
  assert.deepEqual(shellList, [...MANAGED_CHECKOUT_PATHSPECS]);
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
    const env = { ...process.env };
    delete env[DISPATCHER_TARGET_POLICY_ENV];
    await assert.rejects(
      execFileAsync("node", [reconcileScript, checkout], { env }),
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
