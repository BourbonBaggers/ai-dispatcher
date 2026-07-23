/**
 * GitHub access via the `gh` CLI, parameterized by the target repository.
 *
 * Repository identity is threaded through every call as an explicit `--repo
 * owner/name` argument — there is no ambient default. `gh` itself owns the GitHub
 * credential; this service never stores a token.
 *
 * Issue numbers are integers and labels are constants from labels.ts, so they are
 * safe as arguments. A comment body is free-form and is therefore piped over stdin
 * to `--body-file -`, never placed in argv.
 */

import { run, type ExecFn } from "./exec.ts";
import type { RepoSlug } from "./config.ts";

export interface GithubIssue {
  number: number;
  title: string;
  url: string;
  labels: string[];
  authorLogin: string | null;
}

export interface GithubPrMergeInfo {
  baseRefName: string;
  baseRefOid: string;
  headRefName: string;
  headRefOid: string;
  isDraft: boolean;
  mergeStateStatus: string;
  reviewDecision: string | null;
}

/** Issues are pulled newest-last so the scan can prefer the oldest actionable one. */
const ISSUE_FETCH_LIMIT = 100;

interface RawIssue {
  number: number;
  title: string;
  url: string;
  labels: Array<{ name: string }>;
  author?: { login?: string | null } | null;
}

// ── Pure argv builders (exported for unit tests: assert repo propagation) ──────

export function listIssuesArgs(slug: string): string[] {
  return [
    "issue",
    "list",
    "--repo",
    slug,
    "--state",
    "open",
    "--limit",
    String(ISSUE_FETCH_LIMIT),
    "--json",
    "number,title,url,labels,author",
  ];
}

export function addLabelArgs(slug: string, issue: number, label: string): string[] {
  return ["issue", "edit", String(issue), "--repo", slug, "--add-label", label];
}

export function removeLabelArgs(slug: string, issue: number, label: string): string[] {
  return ["issue", "edit", String(issue), "--repo", slug, "--remove-label", label];
}

export function commentArgs(slug: string, issue: number): string[] {
  return ["issue", "comment", String(issue), "--repo", slug, "--body-file", "-"];
}

export function issueStateArgs(slug: string, issue: number): string[] {
  return ["issue", "view", String(issue), "--repo", slug, "--json", "state", "--jq", ".state"];
}

export function issueLabelsArgs(slug: string, issue: number): string[] {
  return ["issue", "view", String(issue), "--repo", slug, "--json", "labels"];
}

export function prReadyArgs(slug: string, pr: number): string[] {
  return ["pr", "ready", String(pr), "--repo", slug];
}

export function closeIssueArgs(slug: string, issue: number): string[] {
  return ["issue", "close", String(issue), "--repo", slug];
}

export function prMergeInfoArgs(slug: string, pr: number): string[] {
  return [
    "pr",
    "view",
    String(pr),
    "--repo",
    slug,
    "--json",
    "baseRefName,baseRefOid,headRefName,headRefOid,isDraft,mergeStateStatus,reviewDecision",
  ];
}

export function prChecksArgs(slug: string, pr: number): string[] {
  return ["pr", "checks", String(pr), "--repo", slug];
}

// ── Client ─────────────────────────────────────────────────────────────────────

export class GithubClient {
  private readonly repo: RepoSlug;
  private readonly exec: ExecFn;

  constructor(repo: RepoSlug, exec: ExecFn = run) {
    this.repo = repo;
    this.exec = exec;
  }

  /** Open issues (pull requests are excluded by `gh issue list`), oldest first. */
  async listOpenIssues(): Promise<
    { ok: true; issues: GithubIssue[] } | { ok: false; error: string }
  > {
    const result = await this.exec("gh", listIssuesArgs(this.repo.slug));
    if (!result.ok) {
      return { ok: false, error: result.stderr.trim() || `gh exited ${result.code}` };
    }
    try {
      const raw = JSON.parse(result.stdout.trim() || "[]") as RawIssue[];
      const issues = raw.map((issue) => ({
        number: issue.number,
        title: issue.title,
        url: issue.url,
        labels: (issue.labels ?? []).map((l) => l.name),
        authorLogin: issue.author?.login ?? null,
      }));
      // Oldest first — the repo's queue rubric works the oldest actionable issue.
      issues.sort((a, b) => a.number - b.number);
      return { ok: true, issues };
    } catch {
      return { ok: false, error: "gh returned unparseable JSON" };
    }
  }

  async addLabel(issue: number, label: string): Promise<boolean> {
    return (await this.exec("gh", addLabelArgs(this.repo.slug, issue, label))).ok;
  }

  async removeLabel(issue: number, label: string): Promise<boolean> {
    return (await this.exec("gh", removeLabelArgs(this.repo.slug, issue, label))).ok;
  }

  /** Posts a comment; the body is piped over stdin so it is never argv. */
  async comment(issue: number, body: string): Promise<boolean> {
    return (await this.exec("gh", commentArgs(this.repo.slug, issue), { stdin: body })).ok;
  }

  /** OPEN | CLOSED | UNKNOWN — used to refuse work on an already-closed issue. */
  async issueState(issue: number): Promise<string> {
    const result = await this.exec("gh", issueStateArgs(this.repo.slug, issue));
    return result.ok ? result.stdout.trim() || "UNKNOWN" : "UNKNOWN";
  }

  /** The issue's current label names. Empty on any read failure -- fail safe (callers
   * treat "no labels read" the same as "label absent", never as "label present"). */
  async issueLabels(issue: number): Promise<string[]> {
    const result = await this.exec("gh", issueLabelsArgs(this.repo.slug, issue));
    if (!result.ok) return [];
    try {
      const raw = JSON.parse(result.stdout.trim()) as { labels?: Array<{ name: string }> };
      return (raw.labels ?? []).map((l) => l.name);
    } catch {
      return [];
    }
  }

  /** Promotes a draft PR to ready for review. */
  async markPrReady(pr: number): Promise<boolean> {
    return (await this.exec("gh", prReadyArgs(this.repo.slug, pr))).ok;
  }

  /**
   * Closes the issue explicitly. This is the ONLY place an issue closes -- PR bodies
   * never carry a GitHub auto-close keyword (Closes/Fixes/Resolves #n), specifically so
   * merging a PR never closes its issue before the deploy that follows is verified.
   * Call this only after the ship command has confirmed a healthy deploy.
   */
  async closeIssue(issue: number): Promise<boolean> {
    return (await this.exec("gh", closeIssueArgs(this.repo.slug, issue))).ok;
  }

  /**
   * The REAL CI verdict for a PR, read from  exit status — never the
   * agent's self-report.  exits 0 when all required checks pass, 8 while
   * any are still pending, and non-zero-non-8 when one has failed. Autoship gates on this
   * fresh reading at ship time; a verdict observed minutes earlier is not trusted.
   */
  async prChecksState(pr: number): Promise<"pass" | "pending" | "fail"> {
    const result = await this.exec("gh", prChecksArgs(this.repo.slug, pr));
    if (result.code === 0) return "pass";
    if (result.code === 8) return "pending";
    return "fail";
  }

  async waitForPrChecks(
    pr: number,
    timeoutSeconds: number,
    pollSeconds = 20,
  ): Promise<"pass" | "pending" | "fail"> {
    const deadline = Date.now() + Math.max(1, timeoutSeconds) * 1000;
    for (;;) {
      const state = await this.prChecksState(pr);
      if (state !== "pending") return state;
      if (Date.now() >= deadline) return "pending";
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(1, pollSeconds) * 1000),
      );
    }
  }

  async prMergeInfo(pr: number): Promise<GithubPrMergeInfo | null> {
    const result = await this.exec("gh", prMergeInfoArgs(this.repo.slug, pr));
    if (!result.ok) return null;
    try {
      const raw = JSON.parse(result.stdout.trim()) as Partial<GithubPrMergeInfo>;
      if (
        typeof raw.baseRefName !== "string" ||
        typeof raw.baseRefOid !== "string" ||
        typeof raw.headRefName !== "string" ||
        typeof raw.headRefOid !== "string" ||
        typeof raw.isDraft !== "boolean" ||
        typeof raw.mergeStateStatus !== "string"
      ) {
        return null;
      }
      return {
        baseRefName: raw.baseRefName,
        baseRefOid: raw.baseRefOid,
        headRefName: raw.headRefName,
        headRefOid: raw.headRefOid,
        isDraft: raw.isDraft,
        mergeStateStatus: raw.mergeStateStatus,
        reviewDecision: typeof raw.reviewDecision === "string" ? raw.reviewDecision : null,
      };
    } catch {
      return null;
    }
  }

  /** The PR's unified diff, or null if it could not be read (the gate then fails safe). */
  async prDiff(pr: number): Promise<string | null> {
    const result = await this.exec("gh", ["pr", "diff", String(pr), "--repo", this.repo.slug]);
    return result.ok ? result.stdout : null;
  }
}
