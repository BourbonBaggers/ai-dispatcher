import { test } from "node:test";
import assert from "node:assert/strict";
import { runShipCommand } from "../src/main.ts";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out: (s: string) => out.push(s),
    err: (s: string) => err.push(s),
    lines: () => ({ out: out.join(""), err: err.join("") }),
  };
}

test("runShipCommand --help prints usage and exits 0 without requiring --repo/--pr", async () => {
  const cap = capture();
  const code = await runShipCommand(["--help"], {}, cap.out, cap.err);
  assert.equal(code, 0);
  assert.match(cap.lines().out, /Usage:/);
});

test("runShipCommand exits 2 on a missing --repo", async () => {
  const cap = capture();
  const code = await runShipCommand(["--pr", "1"], { DISPATCHER_AUTOSHIP_CMD: "ship.sh" }, cap.out, cap.err);
  assert.equal(code, 2);
  assert.match(cap.lines().err, /Invalid repository|repository is required/);
});

test("runShipCommand exits 2 on a missing --pr", async () => {
  const cap = capture();
  const code = await runShipCommand(
    ["--repo", "acme/widgets"],
    { DISPATCHER_AUTOSHIP_CMD: "ship.sh" },
    cap.out,
    cap.err,
  );
  assert.equal(code, 2);
  assert.match(cap.lines().err, /--pr is required/);
});

test("runShipCommand exits 2 when DISPATCHER_AUTOSHIP_CMD is not configured", async () => {
  const cap = capture();
  const code = await runShipCommand(["--repo", "acme/widgets", "--pr", "1"], {}, cap.out, cap.err);
  assert.equal(code, 2);
  assert.match(cap.lines().err, /DISPATCHER_AUTOSHIP_CMD must be configured/);
});
