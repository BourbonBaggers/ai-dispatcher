/**
 * Read-only evidence from a preserved run checkout, for reconciliation (#109).
 *
 * Before autoship may take over a branch's PR, the dispatcher must know the checkout holds
 * no work that PR lacks. Every read here leaves the checkout exactly as the next launch
 * expects to find it: nothing is fetched (the published check uses only objects already
 * present and fails closed when the PR head is not among them), and `--no-optional-locks`
 * keeps `git status` from rewriting the index. Dispatcher-owned files are excluded exactly
 * as the launcher excludes them, so they can never read as unpublished work again.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { run as execRun, type ExecFn } from "./exec.ts";
import { planMilestoneProgress, type CheckoutSnapshot, type PlanProgress } from "./run-reconciliation.ts";
import type { RunRecord } from "./state.ts";
import { MANAGED_CHECKOUT_PATHSPECS } from "./target-policy.ts";

export interface CheckoutInspector {
  /** HEAD, uncommitted work, and plan progress of the run's preserved checkout. */
  inspect(run: Pick<RunRecord, "checkoutPath" | "issueNumber" | "planPath">): Promise<CheckoutSnapshot>;
  /** Whether `sha` (a PR head) contains the checkout's HEAD; null when git cannot tell. */
  headContainedIn(run: Pick<RunRecord, "checkoutPath">, sha: string): Promise<boolean | null>;
}

const GIT_TIMEOUT_MS = 30_000;
/** Enough to name the dirty files in a reason without retaining unbounded output. */
const MAX_DIRTY_ENTRIES = 20;
/** Plans are short Markdown; a larger file is not a plan worth trusting as evidence. */
const MAX_PLAN_BYTES = 512 * 1024;
const FULL_SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/i;

/**
 * Plan files agents write for an issue: the launcher's `docs/plans/*issue<N>-*.md`, a
 * `.plan-issue-<N>.md` or `PLAN-issue-<N>.md` at the root (this repository's convention).
 */
export function isPlanFileFor(name: string, issueNumber: number): boolean {
  return new RegExp(`(?:^|[^0-9a-z])issue-?${issueNumber}(?:-[^/]*)?\\.md$`, "i").test(name);
}

/** Candidate plan paths, checkout-relative, in the order they are trusted. */
export function planCandidates(
  checkoutPath: string,
  issueNumber: number,
  reportedPlan: string | null,
): string[] {
  const candidates: string[] = [];
  if (reportedPlan) candidates.push(reportedPlan);
  try {
    for (const name of readdirSync(join(checkoutPath, "docs", "plans")).sort()) {
      if (isPlanFileFor(name, issueNumber)) candidates.push(`docs/plans/${name}`);
    }
  } catch {
    // No docs/plans directory: the root conventions below still apply.
  }
  candidates.push(`.plan-issue-${issueNumber}.md`, `PLAN-issue-${issueNumber}.md`);
  return [...new Set(candidates)];
}

/** Reads the first candidate plan that exists inside the checkout. */
export function readPlanProgress(
  checkoutPath: string,
  issueNumber: number,
  reportedPlan: string | null,
): PlanProgress | null {
  const root = resolve(checkoutPath);
  for (const candidate of planCandidates(checkoutPath, issueNumber, reportedPlan)) {
    const path = resolve(root, candidate);
    // The reported path comes from our own control channel, but a plan is agent output:
    // never follow one outside the checkout.
    if (!path.startsWith(`${root}${sep}`)) continue;
    try {
      const info = statSync(path);
      if (!info.isFile() || info.size > MAX_PLAN_BYTES) continue;
      const { total, done } = planMilestoneProgress(readFileSync(path, "utf8"));
      return { path: relative(root, path), total, done };
    } catch {
      continue;
    }
  }
  return null;
}

export function gitCheckoutInspector(exec: ExecFn = execRun): CheckoutInspector {
  const git = (checkoutPath: string, args: string[]) =>
    exec("git", ["--no-optional-locks", "-C", checkoutPath, ...args], { timeoutMs: GIT_TIMEOUT_MS });

  return {
    async inspect(run) {
      if (!existsSync(join(run.checkoutPath, ".git"))) return { state: "missing" };
      const head = await git(run.checkoutPath, ["rev-parse", "--verify", "HEAD^{commit}"]);
      const sha = head.stdout.trim();
      if (!head.ok || !FULL_SHA.test(sha)) {
        return { state: "unknown", reason: "git could not read the checkout's HEAD" };
      }
      const status = await git(run.checkoutPath, [
        "status",
        "--porcelain",
        "--untracked-files=normal",
        "--",
        ".",
        ...MANAGED_CHECKOUT_PATHSPECS,
      ]);
      if (!status.ok) return { state: "unknown", reason: "git could not read the checkout's status" };
      const dirty = status.stdout
        .split("\n")
        .filter((line) => line.trim() !== "")
        .slice(0, MAX_DIRTY_ENTRIES)
        .map((line) => line.slice(0, 200));
      return {
        state: "present",
        head: sha,
        dirty,
        plan: readPlanProgress(run.checkoutPath, run.issueNumber, run.planPath),
      };
    },

    async headContainedIn(run, sha) {
      if (!FULL_SHA.test(sha)) return null;
      const result = await git(run.checkoutPath, ["merge-base", "--is-ancestor", "HEAD", sha]);
      // 0: HEAD is the PR head or behind it. 1: the checkout has commits the PR lacks.
      // Anything else (the PR head was never fetched here) proves nothing either way.
      if (result.code === 0) return true;
      if (result.code === 1) return false;
      return null;
    },
  };
}
