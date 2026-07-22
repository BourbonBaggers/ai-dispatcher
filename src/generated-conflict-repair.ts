/**
 * Operational repair for PRs whose only merge conflicts are generated files.
 *
 * The repair recreates the existing PR branch from the current base branch, reapplies
 * the meaningful diff while excluding allowlisted generated files, optionally runs the
 * repository's configured generation command, commits the repaired tree, and pushes back
 * to the same head branch. All command invocations use argv arrays except the optional
 * operator-owned generation command, which is intentionally a shell command string like
 * DISPATCHER_AUTOSHIP_CMD.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, type ExecFn } from "./exec.ts";
import {
  decideGeneratedConflictRecovery,
  type GeneratedConflictRecoveryDecision,
} from "./generated-conflict-recovery.ts";

export interface GeneratedConflictRepairRequest {
  repoSlug: string;
  pr: number;
  baseRefName: string;
  headRefName: string;
  allowlistedPaths: readonly string[];
  regenerationCommand: string | null;
  maxAttempts: number;
}

export type GeneratedConflictRepairResult =
  | {
      ok: true;
      conflictPaths: string[];
      discardedPaths: string[];
      commit: string;
    }
  | {
      ok: false;
      conflictPaths: string[];
      decision: GeneratedConflictRecoveryDecision | null;
      reason: string;
    };

export function parseMergeTreeConflictPaths(stdout: string): string[] {
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (lines.length <= 1) return [];
  const pathLines = lines.slice(1).filter((line) => !/^[0-9a-f]{40,64}$/i.test(line));
  return [...new Set(pathLines)].sort();
}

async function execOk(
  exec: ExecFn,
  file: string,
  args: string[],
  options: { cwd?: string; stdin?: string; timeoutMs?: number } = {},
): Promise<{ ok: true; stdout: string } | { ok: false; detail: string }> {
  const result = await exec(file, args, options);
  if (result.ok) return { ok: true, stdout: result.stdout };
  const detail = (result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`).slice(-500);
  return { ok: false, detail };
}

export async function repairGeneratedFileConflicts(
  request: GeneratedConflictRepairRequest,
  exec: ExecFn = run,
): Promise<GeneratedConflictRepairResult> {
  const tmp = mkdtempSync(join(tmpdir(), "ai-dispatcher-generated-conflict-"));
  const checkout = join(tmp, "repo");
  let conflictPaths: string[] = [];
  let decision: GeneratedConflictRecoveryDecision | null = null;

  try {
    const clone = await execOk(exec, "git", [
      "clone",
      "--quiet",
      `https://github.com/${request.repoSlug}.git`,
      checkout,
    ]);
    if (!clone.ok) return { ok: false, conflictPaths, decision, reason: `clone failed: ${clone.detail}` };

    const fetch = await execOk(exec, "git", [
      "-C",
      checkout,
      "fetch",
      "--quiet",
      "origin",
      request.baseRefName,
      request.headRefName,
    ]);
    if (!fetch.ok) return { ok: false, conflictPaths, decision, reason: `fetch failed: ${fetch.detail}` };

    const checkoutHead = await execOk(exec, "git", [
      "-C",
      checkout,
      "checkout",
      "--quiet",
      "-B",
      request.headRefName,
      `origin/${request.headRefName}`,
    ]);
    if (!checkoutHead.ok) {
      return { ok: false, conflictPaths, decision, reason: `checkout failed: ${checkoutHead.detail}` };
    }

    const mergeTree = await exec("git", [
      "-C",
      checkout,
      "merge-tree",
      "--write-tree",
      "--name-only",
      "--no-messages",
      `origin/${request.baseRefName}`,
      "HEAD",
    ]);
    if (mergeTree.code !== 1) {
      const detail =
        mergeTree.ok
          ? "PR no longer reports merge conflicts"
          : (mergeTree.stderr.trim() || mergeTree.stdout.trim() || `exit ${mergeTree.code}`).slice(-500);
      return { ok: false, conflictPaths, decision, reason: detail };
    }

    conflictPaths = parseMergeTreeConflictPaths(mergeTree.stdout);
    decision = decideGeneratedConflictRecovery(
      conflictPaths,
      { allowlistedPaths: request.allowlistedPaths, maxAttempts: request.maxAttempts },
      0,
    );
    if (!decision.recoverable) {
      return { ok: false, conflictPaths, decision, reason: decision.reason };
    }

    const excludePathspecs = decision.recoverablePaths.map((path) => `:(exclude)${path}`);
    const diff = await execOk(exec, "git", [
      "-C",
      checkout,
      "diff",
      "--binary",
      `origin/${request.baseRefName}...HEAD`,
      "--",
      ".",
      ...excludePathspecs,
    ]);
    if (!diff.ok) return { ok: false, conflictPaths, decision, reason: `diff failed: ${diff.detail}` };

    const reset = await execOk(exec, "git", [
      "-C",
      checkout,
      "reset",
      "--hard",
      "--quiet",
      `origin/${request.baseRefName}`,
    ]);
    if (!reset.ok) return { ok: false, conflictPaths, decision, reason: `reset failed: ${reset.detail}` };

    if (diff.stdout.trim() !== "") {
      const apply = await execOk(
        exec,
        "git",
        ["-C", checkout, "apply", "--index", "--binary", "-"],
        { stdin: diff.stdout },
      );
      if (!apply.ok) return { ok: false, conflictPaths, decision, reason: `patch apply failed: ${apply.detail}` };
    }

    if (request.regenerationCommand) {
      const regen = await execOk(exec, "bash", ["-lc", request.regenerationCommand], {
        cwd: checkout,
        timeoutMs: 10 * 60_000,
      });
      if (!regen.ok) {
        return { ok: false, conflictPaths, decision, reason: `regeneration failed: ${regen.detail}` };
      }
      const add = await execOk(exec, "git", [
        "-C",
        checkout,
        "add",
        "--",
        ...decision.recoverablePaths,
      ]);
      if (!add.ok) return { ok: false, conflictPaths, decision, reason: `git add failed: ${add.detail}` };
    }

    const status = await execOk(exec, "git", ["-C", checkout, "status", "--porcelain"]);
    if (!status.ok) return { ok: false, conflictPaths, decision, reason: `status failed: ${status.detail}` };
    if (status.stdout.trim() === "") {
      return {
        ok: false,
        conflictPaths,
        decision,
        reason: "repair produced no branch changes after discarding generated files",
      };
    }

    const commit = await execOk(exec, "git", [
      "-C",
      checkout,
      "commit",
      "--quiet",
      "-m",
      `Recover generated-file conflicts for PR #${request.pr}`,
    ]);
    if (!commit.ok) return { ok: false, conflictPaths, decision, reason: `commit failed: ${commit.detail}` };

    const sha = await execOk(exec, "git", ["-C", checkout, "rev-parse", "HEAD"]);
    if (!sha.ok) return { ok: false, conflictPaths, decision, reason: `rev-parse failed: ${sha.detail}` };

    const push = await execOk(exec, "git", [
      "-C",
      checkout,
      "push",
      "--force-with-lease",
      "origin",
      `HEAD:${request.headRefName}`,
    ]);
    if (!push.ok) return { ok: false, conflictPaths, decision, reason: `push failed: ${push.detail}` };

    return {
      ok: true,
      conflictPaths,
      discardedPaths: decision.recoverablePaths,
      commit: sha.stdout.trim(),
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

