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
}

/** Issues are pulled newest-last so the scan can prefer the oldest actionable one. */
const ISSUE_FETCH_LIMIT = 100;

interface RawIssue {
  number: number;
  title: string;
  url: string;
  labels: Array<{ name: string }>;
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
    "number,title,url,labels",
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

// ── Client ─────────────────────────────────────────────────────────────────────

export class GithubClient {
  private readonly repo: RepoSlug;
  private readonly exec: ExecFn;

  constructor(repo: RepoSlug, exec: ExecFn = run) {
    this.repo = repo;
    this.exec = exec;
  }

  /** Open issues (pull requests are excluded by `gh issue list`), oldest first. */
  async listOpenIssues(): Promise<{ ok: true; issues: GithubIssue[] } | { ok: false; error: string }> {
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
}
