/**
 * The data-loss gate — the one thing autoship must never ship unattended.
 *
 * Autoship merges a green PR and deploys it to production with no human in the loop.
 * Everything reversible is fair game for that. Irreversible data loss is not: a dropped
 * table or column, a truncate, an unfiltered delete, a bulk `deleteMany` in application
 * code. A dropped column is not recoverable from last night's backup without downtime and
 * data reconstruction, so those PRs are HELD for a human even when CI is green.
 *
 * Two precision rules, both learned the hard way in the internal-tools embedded
 * dispatcher, keep this gate worth having:
 *
 *   1. Only ADDED lines matter. An existing `DROP` in an old migration is not this PR's
 *      doing; flagging it would hold every PR that happens to touch a nearby line.
 *   2. Never fire on test files. Tests delete their own fixtures on teardown
 *      (`deleteMany({ where: { deviceId: { startsWith: TEST_PREFIX } } })`) — that is what
 *      a well-written test looks like, not a production risk. A gate that blocks every PR
 *      containing a test gets waved through within a week, and then it is useless when a
 *      real destructive migration arrives. Precision beats zeal.
 *
 * This module is pure: it decides from the diff alone and performs no IO. The caller
 * supplies the PR's changed files (each with its added lines) and acts on the verdict.
 */

/** One changed file from the PR diff, reduced to the lines this PR adds. */
export interface ChangedFile {
  /** Repo-relative path, exactly as git reports it. */
  path: string;
  /** Added lines of the unified diff for this file, with the leading '+' stripped. */
  addedLines: string[];
}

export interface DataLossAssessment {
  /** True when at least one destructive change was found; the PR must not autoship. */
  held: boolean;
  /** Human-readable "<path>: <what>" lines, for the hold comment and the ntfy push. */
  reasons: string[];
}

/**
 * The destructive-pattern set, ported verbatim from the internal-tools autoship gate so
 * behaviour does not drift during the extraction. SQL data-definition drops and bulk data
 * mutations only — dropping an index or a constraint is not data loss and is intentionally
 * absent, to keep the gate precise.
 */
const DESTRUCTIVE_PATTERNS: readonly { re: RegExp; label: string }[] = [
  { re: /\bDROP\s+(TABLE|COLUMN|DATABASE|SCHEMA)\b/i, label: "DROP TABLE/COLUMN/DATABASE/SCHEMA" },
  { re: /\bTRUNCATE\s+TABLE\b/i, label: "TRUNCATE TABLE" },
  { re: /\bTRUNCATE\b(?!\s+TABLE)/i, label: "TRUNCATE" },
  { re: /\bDELETE\s+FROM\b/i, label: "DELETE FROM" },
  { re: /\bALTER\s+TABLE\b[^;]*\bDROP\b/i, label: "ALTER TABLE ... DROP" },
  { re: /\.deleteMany\s*\(/, label: "prisma deleteMany()" },
  { re: /\.executeRawUnsafe\s*\(/, label: "prisma executeRawUnsafe()" },
];

/** Test files are exempt — see rule 2 in the module header. */
export function isTestPath(path: string): boolean {
  return (
    /(^|\/)(test|tests|__tests__|__mocks__)\//.test(path) ||
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(path)
  );
}

/**
 * Decide whether a PR carries irreversible data-loss risk and must be held from autoship.
 * Considers only added lines in non-test files.
 */
export function assessDataLossRisk(files: readonly ChangedFile[]): DataLossAssessment {
  const reasons: string[] = [];

  for (const file of files) {
    if (isTestPath(file.path)) continue;

    for (const line of file.addedLines) {
      for (const { re, label } of DESTRUCTIVE_PATTERNS) {
        if (re.test(line)) {
          reasons.push(`${file.path}: ${label}`);
          break; // one reason per line is enough
        }
      }
    }
  }

  // De-duplicate: the same "<path>: <label>" from several lines is one reason to a human.
  const unique = [...new Set(reasons)];
  return { held: unique.length > 0, reasons: unique };
}

/**
 * Parse a unified `git diff` / `gh pr diff` into per-file added lines. Added lines start
 * with a single '+' but not '+++' (the file header). New-file boundaries are the
 * `diff --git a/... b/...` markers; the b-side path is authoritative.
 */
export function parseUnifiedDiff(diff: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  let current: ChangedFile | null = null;

  for (const raw of diff.split("\n")) {
    const header = raw.match(/^diff --git a\/.+ b\/(.+)$/);
    if (header) {
      current = { path: header[1] as string, addedLines: [] };
      files.push(current);
      continue;
    }
    if (!current) continue;
    if (raw.startsWith("+++") || raw.startsWith("---")) continue;
    if (raw.startsWith("+")) current.addedLines.push(raw.slice(1));
  }

  return files;
}
