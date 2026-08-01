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
  mergeCommitOid: string | null;
}

export interface GithubPrChecksEvidence {
  state: "pass" | "pending" | "fail" | "unknown";
  /** null means the checks command itself could not be parsed/read. */
  checkCount: number | null;
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

export function issueBodyArgs(slug: string, issue: number): string[] {
  return ["issue", "view", String(issue), "--repo", slug, "--json", "body"];
}

export function prReadyArgs(slug: string, pr: number): string[] {
  return ["pr", "ready", String(pr), "--repo", slug];
}

export function closeIssueArgs(slug: string, issue: number): string[] {
  return ["issue", "close", String(issue), "--repo", slug];
}

export function reopenIssueArgs(slug: string, issue: number): string[] {
  return ["issue", "reopen", String(issue), "--repo", slug];
}

export function prMergeInfoArgs(slug: string, pr: number): string[] {
  return [
    "pr",
    "view",
    String(pr),
    "--repo",
    slug,
    "--json",
    "baseRefName,baseRefOid,headRefName,headRefOid,isDraft,mergeStateStatus,reviewDecision,mergeCommit",
  ];
}

export function prChecksArgs(slug: string, pr: number): string[] {
  return ["pr", "checks", String(pr), "--repo", slug, "--json", "bucket"];
}

export function prStateArgs(slug: string, pr: number): string[] {
  return ["pr", "view", String(pr), "--repo", slug, "--json", "state", "--jq", ".state"];
}

export function prTitleBodyArgs(slug: string, pr: number): string[] {
  return ["pr", "view", String(pr), "--repo", slug, "--json", "title,body"];
}

export function createPullRequestArgs(
  slug: string,
  request: { base: string; head: string; title: string },
): string[] {
  return [
    "pr",
    "create",
    "--repo",
    slug,
    "--base",
    request.base,
    "--head",
    request.head,
    "--title",
    request.title,
    "--body-file",
    "-",
  ];
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

  /** The issue's current label names, or null when absence cannot be proven. */
  async issueLabels(issue: number): Promise<string[] | null> {
    const result = await this.exec("gh", issueLabelsArgs(this.repo.slug, issue));
    if (!result.ok) return null;
    try {
      const raw = JSON.parse(result.stdout.trim()) as { labels?: Array<{ name: string }> };
      return (raw.labels ?? []).map((l) => l.name);
    } catch {
      return null;
    }
  }

  /** The issue body, or null when the read fails or GitHub returns unexpected data. */
  async issueBody(issue: number): Promise<string | null> {
    const result = await this.exec("gh", issueBodyArgs(this.repo.slug, issue));
    if (!result.ok) return null;
    try {
      const raw = JSON.parse(result.stdout.trim()) as { body?: unknown };
      return typeof raw.body === "string" ? raw.body : null;
    } catch {
      return null;
    }
  }

  /** Promotes a draft PR to ready for review. */
  async markPrReady(pr: number): Promise<boolean> {
    return (await this.exec("gh", prReadyArgs(this.repo.slug, pr))).ok;
  }

  /**
   * Opens a ready-for-review PR (never a draft) and returns its number, or null on
   * failure. The body is free-form and is piped over stdin, never argv, like `comment()`.
   */
  async createPullRequest(request: {
    base: string;
    head: string;
    title: string;
    body: string;
  }): Promise<number | null> {
    const result = await this.exec(
      "gh",
      createPullRequestArgs(this.repo.slug, request),
      { stdin: request.body },
    );
    if (!result.ok) return null;
    const match = /\/pull\/(\d+)\s*$/.exec(result.stdout.trim());
    if (!match) return null;
    const pr = Number.parseInt(match[1]!, 10);
    return Number.isInteger(pr) && pr > 0 ? pr : null;
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

  /** Restores an issue that closed before merged code was verified healthy in production. */
  async reopenIssue(issue: number): Promise<boolean> {
    return (await this.exec("gh", reopenIssueArgs(this.repo.slug, issue))).ok;
  }

  /**
   * The REAL CI verdict for a PR, read from  exit status — never the
   * agent's self-report.  exits 0 when all required checks pass, 8 while
   * any are still pending, and non-zero-non-8 when one has failed. Autoship gates on this
   * fresh reading at ship time; a verdict observed minutes earlier is not trusted.
   */
  async prChecksState(pr: number): Promise<"pass" | "pending" | "fail" | "unknown"> {
    return (await this.prChecksEvidence(pr)).state;
  }

  /**
   * Reads both the verdict and whether GitHub returned any check suite entries.
   * The empty-list distinction is essential: `gh pr checks` can exit successfully
   * before Actions has created a suite, and that condition must not park forever.
   */
  async prChecksEvidence(pr: number): Promise<GithubPrChecksEvidence> {
    const result = await this.exec("gh", prChecksArgs(this.repo.slug, pr));
    try {
      const checks = JSON.parse(result.stdout.trim()) as Array<{ bucket?: unknown }>;
      if (!Array.isArray(checks)) return { state: "unknown", checkCount: null };
      if (checks.length === 0) return { state: "unknown", checkCount: 0 };
      const buckets = checks.map((check) => check.bucket);
      if (buckets.some((bucket) => bucket === "fail" || bucket === "cancel")) {
        return { state: "fail", checkCount: checks.length };
      }
      if (buckets.some((bucket) => bucket === "pending")) {
        return { state: "pending", checkCount: checks.length };
      }
      if (buckets.every((bucket) => bucket === "pass" || bucket === "skipping")) {
        return { state: "pass", checkCount: checks.length };
      }
      return { state: "unknown", checkCount: checks.length };
    } catch {
      // Exit 8 is a documented pending result even if an older gh omitted JSON.
      return result.code === 8
        ? { state: "pending", checkCount: null }
        : { state: "unknown", checkCount: null };
    }
  }

  async waitForPrChecks(
    pr: number,
    timeoutSeconds: number,
    pollSeconds = 20,
  ): Promise<"pass" | "pending" | "fail" | "unknown"> {
    const deadline = Date.now() + Math.max(1, timeoutSeconds) * 1000;
    for (;;) {
      const state = await this.prChecksState(pr);
      if (state !== "pending" && state !== "unknown") return state;
      if (Date.now() >= deadline) return "pending";
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(1, pollSeconds) * 1000),
      );
    }
  }

  /**
   * The PR's lifecycle state, read from `gh pr view --json state`: `open`, `merged`, or
   * `closed` (closed without merging). `unknown` on any read/parse failure — callers
   * treat that like `open` and fall through to the normal gates (fail safe: never assume
   * a PR is merged/closed on a read error). Used so autoship recognises an already-merged
   * PR and stands down instead of running `gh pr merge` on it and mistaking the
   * "already merged" failure for a broken deploy (#10).
   */
  async prState(pr: number): Promise<"open" | "merged" | "closed" | "unknown"> {
    const result = await this.exec("gh", prStateArgs(this.repo.slug, pr));
    if (!result.ok) return "unknown";
    switch (result.stdout.trim().toUpperCase()) {
      case "OPEN":
        return "open";
      case "MERGED":
        return "merged";
      case "CLOSED":
        return "closed";
      default:
        return "unknown";
    }
  }

  async prMergeInfo(pr: number): Promise<GithubPrMergeInfo | null> {
    const result = await this.exec("gh", prMergeInfoArgs(this.repo.slug, pr));
    if (!result.ok) return null;
    try {
      const raw = JSON.parse(result.stdout.trim()) as Partial<GithubPrMergeInfo> & {
        mergeCommit?: { oid?: unknown } | null;
      };
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
        mergeCommitOid:
          raw.mergeCommit && typeof raw.mergeCommit.oid === "string"
            ? raw.mergeCommit.oid
            : null,
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

  /**
   * The PR's title and body, used only to refuse a GitHub auto-close keyword before an
   * ad hoc `ship` merges it (issue #27) -- untrusted free text, never fed to a shell.
   */
  async prTitleAndBody(pr: number): Promise<{ title: string; body: string } | null> {
    const result = await this.exec("gh", prTitleBodyArgs(this.repo.slug, pr));
    if (!result.ok) return null;
    try {
      const raw = JSON.parse(result.stdout.trim()) as { title?: unknown; body?: unknown };
      if (typeof raw.title !== "string") return null;
      return { title: raw.title, body: typeof raw.body === "string" ? raw.body : "" };
    } catch {
      return null;
    }
  }
}
