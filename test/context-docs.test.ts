import assert from "node:assert/strict";
import { lstatSync, readFileSync, readlinkSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { dispatchableModels } from "../src/models.ts";

const root = resolve(import.meta.dirname, "..");

test("Claude and Codex load the same canonical agent context", () => {
  const claudePath = resolve(root, "CLAUDE.md");
  assert.equal(lstatSync(claudePath).isSymbolicLink(), true);
  assert.equal(readlinkSync(claudePath), "AGENTS.md");
  assert.equal(
    readFileSync(claudePath, "utf8"),
    readFileSync(resolve(root, "AGENTS.md"), "utf8"),
  );
});

test("repository-local Markdown links resolve", () => {
  const markdown = [
    "AGENTS.md",
    "PLAN-issue-8.md",
    "README.md",
    "ROUTING.md",
    "docs/plans/issue-10-self-ship-autoship-converge.md",
    "docs/plans/issue-12-shellcheck-ci-timeout.md",
    "docs/plans/issue-14-closed-held-runs.md",
    "docs/plans/issue-4-auto-recover-pr-merge-conflicts.md",
    "docs/plans/issue-6-prevent-autoship-from-dirty-worktree.md",
    "docs/shellcheck-ci.md",
  ];

  for (const file of markdown) {
    const body = readFileSync(resolve(root, file), "utf8");
    for (const match of body.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const target = match[1]!;
      if (/^[a-z]+:/i.test(target) || target.startsWith("#")) continue;
      const path = decodeURIComponent(target.split("#", 1)[0]!);
      assert.equal(
        existsSync(resolve(root, dirname(file), path)),
        true,
        `${file} links to missing ${target}`,
      );
    }
  }
});

test("historical plans are visibly quarantined from current instructions", () => {
  const plans = [
    "PLAN-issue-8.md",
    "docs/plans/issue-10-self-ship-autoship-converge.md",
    "docs/plans/issue-12-shellcheck-ci-timeout.md",
    "docs/plans/issue-14-closed-held-runs.md",
    "docs/plans/issue-4-auto-recover-pr-merge-conflicts.md",
    "docs/plans/issue-6-prevent-autoship-from-dirty-worktree.md",
  ];
  for (const file of plans) {
    assert.match(
      readFileSync(resolve(root, file), "utf8").slice(0, 500),
      /historical/i,
      `${file} must identify itself as historical near the top`,
    );
  }
});

test(".env.example covers exactly the environment read by config", () => {
  const config = readFileSync(resolve(root, "src/config.ts"), "utf8");
  const example = readFileSync(resolve(root, ".env.example"), "utf8");
  const used = new Set(
    [...config.matchAll(/\benv\.([A-Z][A-Z0-9_]+)/g)].map((match) => match[1]!),
  );
  const documented = new Set(
    [...example.matchAll(/^([A-Z][A-Z0-9_]+)=/gm)].map((match) => match[1]!),
  );
  assert.deepEqual([...documented].sort(), [...used].sort());
});

test("ROUTING.md lists every live model with its explicit CLI identifier", () => {
  const routing = readFileSync(resolve(root, "ROUTING.md"), "utf8");
  for (const model of dispatchableModels()) {
    assert.match(routing, new RegExp(`\\\`${model.modelLabel}\\\``));
    assert.match(routing, new RegExp(`\\\`${model.cliModel}\\\``));
  }
});

test("self-ship does not bypass durable exhaustion with an operator page", () => {
  const script = readFileSync(resolve(root, "scripts/self-ship.sh"), "utf8");
  assert.doesNotMatch(script, /push\s+"[^"]+"\s+"[^"]+"\s+[45]\b/);
  assert.doesNotMatch(script, /Needs a human/i);
  assert.doesNotMatch(script, /until healthy/);
  assert.match(script, /ROLLBACK_RESTART_ATTEMPTS/);
  assert.match(script, /deployment_failed_rollback_failed/);
});
