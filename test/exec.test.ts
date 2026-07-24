import { test } from "node:test";
import assert from "node:assert/strict";
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
