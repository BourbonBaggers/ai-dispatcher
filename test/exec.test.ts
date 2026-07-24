import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { run } from "../src/exec.ts";

test("process-group timeout reports 124 and does not wait for descendant processes", async () => {
  const started = Date.now();
  const result = await run(
    "bash",
    ["-lc", "sleep 30 & wait"],
    { timeoutMs: 100, killProcessGroup: true, killGraceMs: 100 },
  );

  assert.equal(result.code, 124);
  assert.ok(Date.now() - started < 5_000, "the descendant sleep must not survive the timeout");
});

test("timeout kills a detached descendant that ignores SIGTERM and closes wrapper pipes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dispatcher-exec-tree-"));
  const pidFile = join(dir, "pid");
  let descendant = 0;
  try {
    const result = await run(
      process.execPath,
      [
        "-e",
        [
          "const { spawn } = require('node:child_process');",
          "const { writeFileSync } = require('node:fs');",
          `const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { detached: true, stdio: 'ignore' });`,
          "child.unref();",
          "writeFileSync(process.argv[1], String(child.pid));",
          "setInterval(() => {}, 1000);",
        ].join(" "),
        pidFile,
      ],
      { timeoutMs: 100, killProcessGroup: true, killGraceMs: 100 },
    );
    descendant = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
    assert.equal(result.code, 124);
    let stat = "";
    try {
      stat = execFileSync("ps", ["-o", "stat=", "-p", String(descendant)], {
        encoding: "utf8",
      }).trim();
    } catch {
      // ps exits non-zero once the process is fully reaped.
    }
    assert.ok(stat === "" || stat.startsWith("Z"), `descendant must be dead, got process state ${stat}`);
  } finally {
    if (descendant > 0) {
      try {
        process.kill(descendant, "SIGKILL");
      } catch {
        // already gone
      }
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("large command output is tail-capped without aborting the command", async () => {
  const result = await run(
    process.execPath,
    ["-e", "process.stdout.write('x'.repeat(200000)); process.stdout.write('END')"],
    { timeoutMs: 5_000, maxOutputBytes: 1_024 },
  );

  assert.equal(result.code, 0);
  assert.equal(result.ok, true);
  assert.ok(result.stdout.length <= 1_024);
  assert.ok(result.stdout.endsWith("END"));
});
