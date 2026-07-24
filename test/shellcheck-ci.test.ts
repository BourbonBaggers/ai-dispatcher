import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), "..");
const shellcheckCi = join(repoRoot, "scripts", "shellcheck-ci.sh");

async function writeExecutable(path: string, contents: string): Promise<void> {
  await writeFile(path, contents, { mode: 0o755 });
}

async function runGit(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function makeFixture(): Promise<{ cwd: string; logPath: string; path: string; cleanup: () => Promise<void> }> {
  const cwd = await mkdtemp(join(tmpdir(), "shellcheck-ci-test-"));
  const binDir = join(cwd, "fake-bin");
  const logPath = join(cwd, "shellcheck-args.log");

  await mkdir(binDir);
  await writeExecutable(
    join(binDir, "shellcheck"),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "--version" ]]; then
  printf 'ShellCheck - shell script analysis tool\\nversion: 0.10.0\\n'
  exit 0
fi
printf '%s\\n' "$*" >> "$FAKE_SHELLCHECK_LOG"
if [[ -n "\${FAKE_SHELLCHECK_FAIL_ON:-}" ]]; then
  for arg in "$@"; do
    if [[ "$arg" == *"$FAKE_SHELLCHECK_FAIL_ON"* ]]; then
      exit 1
    fi
  done
fi
`,
  );
  await writeExecutable(
    join(binDir, "timeout"),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${FAKE_TIMEOUT_RC:-0}" != "0" ]]; then
  exit "$FAKE_TIMEOUT_RC"
fi
shift
exec "$@"
`,
  );

  await mkdir(join(cwd, "scripts"), { recursive: true });
  await mkdir(join(cwd, "bin"), { recursive: true });
  await mkdir(join(cwd, "node_modules"), { recursive: true });
  await mkdir(join(cwd, "vendor"), { recursive: true });
  await mkdir(join(cwd, "tmp"), { recursive: true });
  await writeFile(join(cwd, "scripts", "a.sh"), "echo a\n");
  await writeFile(join(cwd, "scripts", "b.sh"), "echo b\n");
  await writeFile(join(cwd, "bin", "tool"), "#!/usr/bin/env bash\necho tool\n");
  await writeFile(join(cwd, "node_modules", "ignored.sh"), "echo ignored\n");
  await writeFile(join(cwd, "vendor", "ignored.sh"), "echo ignored\n");
  await writeFile(join(cwd, "tmp", "ignored.sh"), "echo ignored\n");
  await writeFile(join(cwd, "tracked.txt"), "not shell\n");
  await symlink("scripts/a.sh", join(cwd, "linked.sh"));
  await writeFile(join(cwd, "untracked.sh"), "echo untracked\n");

  await runGit(cwd, ["init", "-q"]);
  await runGit(cwd, [
    "add",
    "scripts/a.sh",
    "scripts/b.sh",
    "bin/tool",
    "node_modules/ignored.sh",
    "vendor/ignored.sh",
    "tmp/ignored.sh",
    "tracked.txt",
    "linked.sh",
  ]);

  return {
    cwd,
    logPath,
    path: `${binDir}:${process.env.PATH ?? ""}`,
    cleanup: () => rm(cwd, { recursive: true, force: true }),
  };
}

test("shellcheck-ci discovers only tracked non-symlink shell files outside excluded directories", async () => {
  const fixture = await makeFixture();
  try {
    const result = await execFileAsync("bash", [shellcheckCi], {
      cwd: fixture.cwd,
      env: {
        ...process.env,
        PATH: fixture.path,
        FAKE_SHELLCHECK_LOG: fixture.logPath,
        SHELLCHECK_BATCH_SIZE: "2",
      },
    });

    assert.match(result.stdout, /ShellCheck version: 0\.10\.0/);
    assert.match(result.stdout, /Discovered shell file count: 3/);
    assert.match(result.stdout, /ShellCheck base command: shellcheck --severity=error --shell=bash/);
    assert.match(
      result.stdout,
      /ShellCheck batch command: shellcheck --severity=error --shell=bash bin\/tool scripts\/a\.sh/,
    );
    assert.match(result.stdout, /ShellCheck batch command: shellcheck --severity=error --shell=bash scripts\/b\.sh/);
    assert.match(result.stdout, /Checked 2\/3 files/);
    assert.match(result.stdout, /Checked 3\/3 files/);

    const invocations = (await readFile(fixture.logPath, "utf8")).trim().split("\n");
    assert.equal(invocations.length, 2);
    assert.match(invocations.join("\n"), /scripts\/a\.sh/);
    assert.match(invocations.join("\n"), /scripts\/b\.sh/);
    assert.match(invocations.join("\n"), /bin\/tool/);
    assert.doesNotMatch(invocations.join("\n"), /node_modules|vendor|tmp|linked\.sh|untracked\.sh|tracked\.txt/);
  } finally {
    await fixture.cleanup();
  }
});

test("shellcheck-ci preserves shellcheck failures as failing checks", async () => {
  const fixture = await makeFixture();
  try {
    await assert.rejects(
      execFileAsync("bash", [shellcheckCi], {
        cwd: fixture.cwd,
        env: {
          ...process.env,
          PATH: fixture.path,
          FAKE_SHELLCHECK_LOG: fixture.logPath,
          FAKE_SHELLCHECK_FAIL_ON: "scripts/a.sh",
        },
      }),
      (error: { code?: number }) => error.code === 1,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("shellcheck-ci reports an actionable message when the bounded check times out", async () => {
  const fixture = await makeFixture();
  try {
    await assert.rejects(
      execFileAsync("bash", [shellcheckCi], {
        cwd: fixture.cwd,
        env: {
          ...process.env,
          PATH: fixture.path,
          FAKE_SHELLCHECK_LOG: fixture.logPath,
          FAKE_TIMEOUT_RC: "124",
          SHELLCHECK_TIMEOUT_SECONDS: "5",
        },
      }),
      (error: { code?: number; stderr?: string }) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr ?? "", /ShellCheck timed out after 5s/);
        assert.match(error.stderr ?? "", /Reproduce locally with: SHELLCHECK_TIMEOUT_SECONDS=5 scripts\/shellcheck-ci\.sh/);
        return true;
      },
    );
  } finally {
    await fixture.cleanup();
  }
});
