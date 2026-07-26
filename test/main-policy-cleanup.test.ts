import { test } from "node:test";
import assert from "node:assert/strict";
import { runPolicyCleanupCommand } from "../src/main.ts";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out: (s: string) => out.push(s),
    err: (s: string) => err.push(s),
    lines: () => ({ out: out.join(""), err: err.join("") }),
  };
}

test("runPolicyCleanupCommand --help prints usage and exits 0 without requiring --repo", async () => {
  const cap = capture();
  const code = await runPolicyCleanupCommand(["--help"], {}, cap.out, cap.err);
  assert.equal(code, 0);
  assert.match(cap.lines().out, /Usage:/);
});

test("runPolicyCleanupCommand exits 2 on a missing --repo", async () => {
  const cap = capture();
  const code = await runPolicyCleanupCommand([], {}, cap.out, cap.err);
  assert.equal(code, 2);
  assert.match(cap.lines().err, /Invalid repository|repository is required/);
});

test("runPolicyCleanupCommand exits 2 on an invalid DISPATCHER_CI_ESCALATION_MODEL", async () => {
  const cap = capture();
  const code = await runPolicyCleanupCommand(
    ["--repo", "acme/widgets"],
    { DISPATCHER_CI_ESCALATION_MODEL: "not-a-real-model" },
    cap.out,
    cap.err,
  );
  assert.equal(code, 2);
  assert.match(cap.lines().err, /Invalid DISPATCHER_CI_ESCALATION_MODEL/);
});
