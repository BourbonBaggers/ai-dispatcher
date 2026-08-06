import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { join } from "node:path";

const repoRoot = join(import.meta.dirname, "..");
const fixtureRoot = join(repoRoot, "docs", "dogfood-demo-target");

test("dogfood demo target documents the minimal safe intake labels", async () => {
  const labels = await readFile(join(fixtureRoot, "labels.md"), "utf8");
  assert.match(labels, /dispatch:ready/);
  assert.match(labels, /agent:codex/);
  assert.match(labels, /priority:p1/);
  assert.match(labels, /effort:small/);
  assert.match(labels, /Do not enable autoship for the first dogfood pass\./);
});

test("dogfood demo issue keeps the fixture small and deterministic", async () => {
  const issue = await readFile(join(fixtureRoot, "issues", "1.md"), "utf8");
  assert.match(issue, /Issue 1: Add a greeting banner/);
  assert.match(issue, /Hello from the dogfood demo/);
  assert.match(issue, /claim/i);
  assert.match(issue, /isolated checkout execution/);
});

test("README points at the repeatable dogfood demo path and safe commands", async () => {
  const readme = await readFile(join(repoRoot, "README.md"), "utf8");
  assert.match(readme, /Repeatable dogfood demo target and runbook \(#71\)/);
  assert.match(readme, /docs\/dogfood-demo-target\//);
  assert.match(readme, /--dry-run/);
  assert.match(readme, /--once/);
  assert.match(readme, /Issue: #<number>/);
  assert.match(readme, /autoship disabled/);
});
