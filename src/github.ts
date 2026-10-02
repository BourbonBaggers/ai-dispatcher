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
import { redact } from "./sanitize.ts";

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
  mergedAt?: string | null;
}

/** One pull request whose head is a run's branch, as `gh pr list --head` reports it. */
export interface GithubBranchPullRequest {
  number: number;
  state: "open" | "merged" | "closed";
  isDraft: boolean;
  headRefOid: string;
  url: string;
}

export interface GithubPrChecksEvidence {
  state: "pass" | "pending" | "fail" | "unknown";
  /** null means the checks command itself could not be parsed/read. */
  checkCount: number | null;
}

/**
 * gh's report for a PR whose head commit has no checks registered yet. It prints no JSON
 * for that state, even under `--json`, and exits 1 — the same code as a red check.
 */
const NO_CHECKS_REPORTED = /no checks reported/i;

/**
 * GitHub refusing to render a PR's diff at all: more than 300 files or 20 000 lines is
 * HTTP 406 (`PullRequest.diff too_large`), and a huge diff can also time out generating.
 * That is permanent for the PR, unlike a transport failure, so it must not be retried.
 */
const DIFF_TOO_LARGE =
  /too_large|HTTP 406|exceeded the maximum number of (?:files|lines)|diff is taking too long to generate/i;

/**
 * gh resolves every `--label` to an ID before it creates anything, so one label the
 * repository lacks fails the whole `gh issue create` — identically, every time.
 */
const MISSING_LABEL = /could not add label: '([^']+)' not found/i;

/** `gh label create` on a name the repository already has (any case). */
const LABEL_EXISTS = /already exists/i;

/** An issue's number, or gh's failure — kept so a deterministic one can be told apart. */
export type GithubCreatedIssue =
  | { ok: true; issue: number }
  | { ok: false; error: string; missingLabel?: string };

export interface GithubLabelSpec {
  name: string;
  /** Six hex digits, no `#`. */
  color: string;
  description: string;
}

/** A PR's unified diff, or why it could not be read. */
export type GithubPrDiff =
  | { state: "ok"; diff: string }
  | { state: "too_large"; error: string }
  | { state: "unavailable"; error: string };

/** One changed file from the PR files API. */
export interface GithubPrFile {
  filename: string;
  /** The old path of a renamed file. */
  previousFilename?: string;
  /** added | removed | modified | renamed | copied | changed | unchanged */
  status: string;
  additions: number;
  deletions: number;
  /** Absent for a removed file, and wherever GitHub omits it (binary or very large). */
  patch?: string;
}

/**
 * gh's failure as one bounded, redacted line — enough to tell failures apart in logs and
 * durable state without persisting unbounded or sensitive output.
 */
function ghError(result: { stderr: string; code: number | null }): string {
  const line = result.stderr.split(/\r?\n/).find((text) => text.trim() !== "")?.trim();
  return line ? redact(line).slice(0, 200) : `gh exited ${result.code ?? "without a code"}`;
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

/**
 * Creates an issue. The title and body are free-form: the body goes over stdin like every
 * other free-form text, and labels come from the caller's frozen allowlist, never from
 * anything an agent or model produced.
 */
export function createIssueArgs(
  slug: string,
  request: { title: string; labels: readonly string[] },
): string[] {
  return [
    "issue",
    "create",
    "--repo",
    slug,
    "--title",
    request.title,
    "--body-file",
    "-",
    ...request.labels.flatMap((label) => ["--label", label]),
  ];
}

/**
 * Creates a label. Never `--force`: an existing label's color and description belong to
 * the operator, and only the caller's constants ever reach this argv.
 */
export function createLabelArgs(slug: string, label: GithubLabelSpec): string[] {
  return [
    "label",
    "create",
    label.name,
    "--repo",
    slug,
    "--color",
    label.color,
    "--description",
    label.description,
  ];
}

/** Open issues carrying a label — used to find an existing audit follow-up before filing. */
export function issuesWithLabelArgs(slug: string, label: string): string[] {
  return [
    "issue",
    "list",
    "--repo",
    slug,
    "--state",
    "open",
    "--label",
    label,
    "--limit",
    String(ISSUE_FETCH_LIMIT),
    "--json",
    "number,body",
  ];
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
    "baseRefName,baseRefOid,headRefName,headRefOid,isDraft,mergeStateStatus,reviewDecision,mergeCommit,mergedAt",
  ];
}

/** Every PR, in any state, whose head is `branch` (a validated `issue-<n>-<slug>` name). */
export function branchPullRequestsArgs(slug: string, branch: string): string[] {
  return [
    "pr",
    "list",
    "--repo",
    slug,
    "--head",
    branch,
    "--state",
    "all",
    "--json",
    "number,state,isDraft,headRefOid,url",
    "--limit",
    "20",
  ];
}

function parseBranchPullRequest(raw: unknown): GithubBranchPullRequest | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const state = typeof record.state === "string" ? record.state.toLowerCase() : "";
  if (
    typeof record.number !== "number" ||
    !Number.isSafeInteger(record.number) ||
    (state !== "open" && state !== "merged" && state !== "closed") ||
    typeof record.isDraft !== "boolean" ||
    typeof record.headRefOid !== "string" ||
    typeof record.url !== "string"
  ) {
    return null;
  }
  return {
    number: record.number,
    state,
    isDraft: record.isDraft,
    headRefOid: record.headRefOid,
    url: record.url,
  };
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

export function prDiffArgs(slug: string, pr: number): string[] {
  return ["pr", "diff", String(pr), "--repo", slug];
}

/**
 * The files API lists up to 3000 changed files even when the diff is refused as too large.
 * A removed file keeps its name and counts but drops its patch: deleted content is the bulk
 * of a large cleanup and cannot show that anything was attempted — `removed` already says
 * the file is gone. `@json` keeps one compact object per line whatever gh's output mode.
 */
const PR_FILES_JQ =
  ".[] | {filename, previous_filename, status, additions, deletions, " +
  'patch: (if .status == "removed" then null else .patch end)} | @json';

export function prFilesArgs(slug: string, pr: number): string[] {
  return ["api", "--paginate", `repos/${slug}/pulls/${pr}/files?per_page=100`, "--jq", PR_FILES_JQ];
}

function parsePrFile(raw: unknown): GithubPrFile | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.filename !== "string" || typeof record.status !== "string") return null;
  return {
    filename: record.filename,
    status: record.status,
    additions: typeof record.additions === "number" ? record.additions : 0,
    deletions: typeof record.deletions === "number" ? record.deletions : 0,
    ...(typeof record.previous_filename === "string"
      ? { previousFilename: record.previous_filename }
      : {}),
    ...(typeof record.patch === "string" ? { patch: record.patch } : {}),
  };
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

  /**
   * Creates an issue and returns its number. The body is piped over stdin so untrusted
   * audit text never reaches argv. A failure keeps gh's error, and names the label when
   * the repository lacks one, so the audit can tell a deterministic failure apart (#98).
   */
  async createIssue(request: {
    title: string;
    body: string;
    labels: readonly string[];
  }): Promise<GithubCreatedIssue> {
    const result = await this.exec(
      "gh",
      createIssueArgs(this.repo.slug, { title: request.title, labels: request.labels }),
      { stdin: request.body },
    );
    if (!result.ok) {
      const missingLabel = MISSING_LABEL.exec(result.stderr)?.[1];
      return {
        ok: false,
        error: ghError(result),
        ...(missingLabel === undefined ? {} : { missingLabel }),
      };
    }
    const match = /\/issues\/(\d+)\s*$/.exec(result.stdout.trim());
    const issue = match ? Number.parseInt(match[1]!, 10) : Number.NaN;
    return Number.isInteger(issue) && issue > 0
      ? { ok: true, issue }
      : { ok: false, error: "gh issue create printed no issue URL" };
  }

  /** Creates a label; one the repository already has counts as present and is left as is. */
  async createLabel(label: GithubLabelSpec): Promise<boolean> {
    const result = await this.exec("gh", createLabelArgs(this.repo.slug, label));
    return result.ok || LABEL_EXISTS.test(result.stderr);
  }

  /**
   * Open issues carrying a label, with bodies, or null when the read failed. Null is not
   * "none": the audit must not file a duplicate just because a list call errored.
   */
  async issuesWithLabel(label: string): Promise<{ number: number; body: string }[] | null> {
    const result = await this.exec("gh", issuesWithLabelArgs(this.repo.slug, label));
    if (!result.ok) return null;
    try {
      const raw: unknown = JSON.parse(result.stdout.trim() || "[]");
      if (!Array.isArray(raw)) return null;
      return raw.flatMap((entry) => {
        if (typeof entry !== "object" || entry === null) return [];
        const record = entry as { number?: unknown; body?: unknown };
        if (typeof record.number !== "number") return [];
        return [{ number: record.number, body: typeof record.body === "string" ? record.body : "" }];
      });
    } catch {
      return null;
    }
  }

  /** Restores an issue that closed before merged code was verified healthy in production. */
  async reopenIssue(issue: number): Promise<boolean> {
    return (await this.exec("gh", reopenIssueArgs(this.repo.slug, issue))).ok;
  }

  /**
   * The REAL CI verdict for a PR, read from `gh pr checks` structured buckets — never the
   * agent's self-report, and never the bare exit code (see prChecksEvidence). Autoship
   * gates on this fresh reading at ship time; a verdict observed minutes earlier is not
   * trusted.
   */
  async prChecksState(pr: number): Promise<"pass" | "pending" | "fail" | "unknown"> {
    return (await this.prChecksEvidence(pr)).state;
  }

  /**
   * Reads both the verdict and how many checks GitHub reported. Only a check in the `fail`
   * or `cancel` bucket is a failure. The exit code cannot say that: gh exits 1 for a red
   * check, for a transport error, and for a PR with no checks registered yet (#96). That
   * last state is `pending` with `checkCount: 0` — never red, and never `unknown` either:
   * a just-opened PR is in it for seconds, while autoship gives a durable absence its own
   * grace period and then repairs it rather than parking forever (#60).
   */
  async prChecksEvidence(pr: number): Promise<GithubPrChecksEvidence> {
    const result = await this.exec("gh", prChecksArgs(this.repo.slug, pr));
    let checks: unknown;
    try {
      checks = JSON.parse(result.stdout.trim());
    } catch {
      if (NO_CHECKS_REPORTED.test(result.stderr)) return { state: "pending", checkCount: 0 };
      // Exit 8 is a documented pending result even if an older gh omitted JSON.
      return result.code === 8
        ? { state: "pending", checkCount: null }
        : { state: "unknown", checkCount: null };
    }
    if (!Array.isArray(checks)) return { state: "unknown", checkCount: null };
    if (checks.length === 0) return { state: "pending", checkCount: 0 };
    const buckets = checks.map((check: unknown) =>
      typeof check === "object" && check !== null ? (check as { bucket?: unknown }).bucket : undefined,
    );
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
  }

  /**
   * Polls until CI resolves or `timeoutSeconds` pass. No checks yet, pending checks, and an
   * unreadable read all keep it polling: a freshly pushed head commit has no checks for a
   * while, and that is not a failure. Only a real failed or cancelled check returns
   * `fail`; anything still unresolved at the deadline returns `pending`.
   */
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

  /**
   * Every PR whose head is `branch`, or null when GitHub could not answer completely. An
   * empty list means the branch has no PR; a failed or partial read is never reported as
   * "no PR", because reconciliation would then relaunch an agent over finished work (#109).
   */
  async branchPullRequests(branch: string): Promise<GithubBranchPullRequest[] | null> {
    const result = await this.exec("gh", branchPullRequestsArgs(this.repo.slug, branch));
    if (!result.ok) return null;
    let raw: unknown;
    try {
      raw = JSON.parse(result.stdout.trim());
    } catch {
      return null;
    }
    if (!Array.isArray(raw)) return null;
    const prs: GithubBranchPullRequest[] = [];
    for (const entry of raw) {
      const pr = parseBranchPullRequest(entry);
      if (pr === null) return null;
      prs.push(pr);
    }
    return prs;
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
        mergedAt: typeof (raw as { mergedAt?: unknown }).mergedAt === "string"
          ? (raw as { mergedAt: string }).mergedAt
          : null,
      };
    } catch {
      return null;
    }
  }

  /**
   * The PR's unified diff. A refusal as too large is reported apart from a read failure:
   * retrying it can never succeed, while the files API can still describe the change.
   */
  async prDiff(pr: number): Promise<GithubPrDiff> {
    const result = await this.exec("gh", prDiffArgs(this.repo.slug, pr));
    if (result.ok) return { state: "ok", diff: result.stdout };
    const error = ghError(result);
    return DIFF_TOO_LARGE.test(result.stderr)
      ? { state: "too_large", error }
      : { state: "unavailable", error };
  }

  /**
   * Every changed file in the PR, or null when the list could not be read completely. A
   * partial list is never returned: a missing file would read as work never attempted.
   */
  async prFiles(pr: number): Promise<GithubPrFile[] | null> {
    // Up to 30 pages for the largest PRs, so allow longer than a single read.
    const result = await this.exec("gh", prFilesArgs(this.repo.slug, pr), { timeoutMs: 120_000 });
    if (!result.ok) return null;
    const files: GithubPrFile[] = [];
    for (const line of result.stdout.split("\n")) {
      if (line.trim() === "") continue;
      let file: GithubPrFile | null;
      try {
        file = parsePrFile(JSON.parse(line));
      } catch {
        return null;
      }
      if (file === null) return null;
      files.push(file);
    }
    return files;
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
