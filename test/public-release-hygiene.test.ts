import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, "..");
const guard = join(repoRoot, "scripts", "check-public-release-hygiene.sh");

async function makeFixture(files: Record<string, string>): Promise<{ cwd: string; cleanup: () => Promise<void> }> {
  const cwd = await mkdtemp(join(tmpdir(), "public-release-hygiene-"));
  await mkdir(join(cwd, ".github"), { recursive: true });
  await mkdir(join(cwd, "docs", "plans"), { recursive: true });
  await mkdir(join(cwd, "src"), { recursive: true });
  await mkdir(join(cwd, "scripts"), { recursive: true });
  await mkdir(join(cwd, "macos", "DispatcherStatusBar", "Sources"), { recursive: true });
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(dirname(join(cwd, path)), { recursive: true });
    await writeFile(join(cwd, path), contents);
  }
  await execFileAsync("git", ["init"], { cwd });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd });
  await execFileAsync("git", ["config", "user.name", "Test User"], { cwd });
  await execFileAsync("git", ["add", "."], { cwd });
  await execFileAsync("git", ["commit", "-m", "fixture"], { cwd });
  return { cwd, cleanup: () => rm(cwd, { recursive: true, force: true }) };
}

test("public release hygiene guard rejects tracked build artifacts, .env files, private IPs, and private residue", async () => {
  const fixture = await makeFixture({
    "README.md": "repo: BourbonBaggers/internal-tools\nhost: 10.1.2.3\n",
    "SECURITY.md": "Report privately.\n",
    "CONTRIBUTING.md": "Use Node 24.\n",
    "LICENSE": "MIT\n",
    ".env": "SECRET=1\n",
    "macos/DispatcherStatusBar/build/Dispatcher Status Bar.app/Contents/Info.plist": "artifact\n",
    "src/example.ts": "const host = '192.168.1.5';\n",
  });

  try {
    await assert.rejects(
      execFileAsync("bash", [guard], { cwd: fixture.cwd }),
      (error: { code?: number; stderr?: string }) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr ?? "", /tracked build artifact|private release hygiene/);
        return true;
      },
    );
  } finally {
    await fixture.cleanup();
  }
});

test("public release hygiene guard passes on a clean release tree", async () => {
  const fixture = await makeFixture({
    "README.md": "Clean release notes.\n",
    "SECURITY.md": "Report privately.\n",
    "CONTRIBUTING.md": "Use Node 24.\n",
    "LICENSE": "MIT\n",
  });

  try {
    const result = await execFileAsync("bash", [guard], { cwd: fixture.cwd });
    assert.match(result.stdout, /public release hygiene checks passed/);
  } finally {
    await fixture.cleanup();
  }
});
