import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { it } from "node:test";
import assert from "node:assert/strict";

const scriptPath = new URL("../scripts/dispatch-agent.sh", import.meta.url).pathname;

it("checkpoints docs/plans without optional generated markdown files", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "dispatch-checkpoint-"));
  try {
    const git = (...args: string[]) => {
      const result = spawnSync("git", args, { cwd, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    git("init", "-q");
    git("config", "user.email", "checkpoint-test@example.invalid");
    git("config", "user.name", "Checkpoint Test");
    await mkdir(join(cwd, "docs", "plans"), { recursive: true });
    await writeFile(join(cwd, "docs", "plans", "issue-1.md"), "initial\n");
    git("add", "docs/plans/issue-1.md");
    git("commit", "-qm", "initial");
    await writeFile(join(cwd, "docs", "plans", "issue-1.md"), "updated plan\n");

    const script = await readFile(scriptPath, "utf8");
    const checkpoint = script.match(/checkpoint_once\(\) \{[\s\S]*?\n\}/)?.[0];
    assert.ok(checkpoint, "checkpoint_once function exists");
    const result = spawnSync("bash", ["-c", `${checkpoint}\ncheckpoint_once`], {
      cwd,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(git("status", "--porcelain"), "");
    assert.equal(git("log", "-1", "--pretty=%s"), "plan: checkpoint");
    assert.equal(await readFile(join(cwd, "docs", "plans", "issue-1.md"), "utf8"), "updated plan\n");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
