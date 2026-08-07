import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, "..");
const guard = join(repoRoot, "scripts", "check-private-residue.sh");

async function makeFixture(files: Record<string, string>): Promise<{ cwd: string; cleanup: () => Promise<void> }> {
  const cwd = await mkdtemp(join(tmpdir(), "private-residue-guard-"));
  await mkdir(join(cwd, ".github"), { recursive: true });
  await mkdir(join(cwd, "docs", "plans"), { recursive: true });
  await mkdir(join(cwd, "test"), { recursive: true });
  await mkdir(join(cwd, "src"), { recursive: true });
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(dirname(join(cwd, path)), { recursive: true });
    await writeFile(join(cwd, path), contents);
  }
  return { cwd, cleanup: () => rm(cwd, { recursive: true, force: true }) };
}

test("private residue guard rejects private repository names and private IP literals in shipped files", async () => {
  const fixture = await makeFixture({
    "README.md": "repo: private-org/private-service\nhost: 10.1.2.3\n",
    "test/allowed.txt": "private-org/private-service\n10.1.2.3\n",
    "docs/plans/issue-1.md": "private-org/private-service\n10.1.2.3\n",
  });

  try {
    await assert.rejects(
      execFileAsync("bash", [guard], { cwd: fixture.cwd }),
      (error: { code?: number; stderr?: string }) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr ?? "", /private residue/);
        return true;
      },
    );
  } finally {
    await fixture.cleanup();
  }
});

test("private residue guard allows historical and test-only references outside shipped paths", async () => {
  const fixture = await makeFixture({
    "test/allowed.txt": "private-org/private-service\n10.1.2.3\n",
    "docs/plans/issue-1.md": "private-org/private-service\n10.1.2.3\n",
  });

  try {
    const result = await execFileAsync("bash", [guard], { cwd: fixture.cwd });
    assert.match(result.stdout, /no private deployment residue found/);
  } finally {
    await fixture.cleanup();
  }
});
