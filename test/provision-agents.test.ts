import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("provisioning script is parameterized through documented dispatcher config", () => {
  const script = readFileSync("scripts/provision-agents.sh", "utf8");

  assert.match(script, /DISPATCHER_REPO/);
  assert.match(script, /DISPATCHER_REPO_DIR/);
  assert.match(script, /DISPATCHER_WORKTREE_DIR/);
  assert.match(script, /DISPATCHER_ENV_SOURCE_DIR/);
  assert.match(script, /--repo <owner\/repo>/);
  assert.match(script, /--env-source-dir <path>/);

  assert.doesNotMatch(script, /DISPATCHER_ENV_SOURCE\b/);
  assert.doesNotMatch(script, /--repo-slug/);
  assert.doesNotMatch(script, /--env-source(?!-dir)/);
});
