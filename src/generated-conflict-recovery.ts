/**
 * Pure policy for generated-file merge-conflict recovery.
 *
 * The operational repair is intentionally conservative: it may continue only when every
 * conflict path is explicitly allowlisted as generated output, and the attempt count is
 * still under a small cap. Nothing is inferred from names or directories because a false
 * positive here would discard human-authored work during an automatic merge path.
 */

/** The initial generated-file allowlist requested by issue #4. */
export const DEFAULT_GENERATED_CONFLICT_ALLOWLIST = Object.freeze([
  "docs/memory.md",
  "docs/researcher.md",
] as const);

/** One automatic repair is enough to break a stale generated-file conflict cycle. */
export const DEFAULT_MAX_GENERATED_CONFLICT_RECOVERIES = 1;

export interface GeneratedConflictRecoveryPolicy {
  allowlistedPaths: readonly string[];
  maxAttempts: number;
}

export interface GeneratedConflictRecoveryDecision {
  recoverable: boolean;
  recoverablePaths: string[];
  refusedPaths: string[];
  reason: string;
}

function normalizeRepoPath(path: string): string | null {
  const trimmed = path.trim();
  if (trimmed === "" || trimmed.startsWith("/") || trimmed.includes("\0")) return null;
  const parts = trimmed.split("/");
  const normalized: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") return null;
    normalized.push(part);
  }
  return normalized.length > 0 ? normalized.join("/") : null;
}

export function parseGeneratedConflictAllowlist(raw: string | null | undefined): string[] {
  if (!raw || raw.trim() === "") return [...DEFAULT_GENERATED_CONFLICT_ALLOWLIST];
  const paths = raw
    .split(",")
    .map((path) => normalizeRepoPath(path))
    .filter((path): path is string => path !== null);
  return [...new Set(paths)];
}

export function decideGeneratedConflictRecovery(
  conflictPaths: readonly string[],
  policy: GeneratedConflictRecoveryPolicy,
  previousAttempts: number,
): GeneratedConflictRecoveryDecision {
  const normalizedConflicts = [
    ...new Set(
      conflictPaths
        .map((path) => normalizeRepoPath(path))
        .filter((path): path is string => path !== null),
    ),
  ].sort();
  const allowlist = new Set(
    policy.allowlistedPaths
      .map((path) => normalizeRepoPath(path))
      .filter((path): path is string => path !== null),
  );
  const recoverablePaths = normalizedConflicts.filter((path) => allowlist.has(path));
  const refusedPaths = normalizedConflicts.filter((path) => !allowlist.has(path));

  if (previousAttempts >= policy.maxAttempts) {
    return {
      recoverable: false,
      recoverablePaths,
      refusedPaths: normalizedConflicts,
      reason: `automatic generated-file conflict recovery already reached its ${policy.maxAttempts}-attempt limit`,
    };
  }

  if (normalizedConflicts.length === 0) {
    return {
      recoverable: false,
      recoverablePaths: [],
      refusedPaths: [],
      reason: "no merge-conflict paths were reported",
    };
  }

  if (refusedPaths.length > 0) {
    return {
      recoverable: false,
      recoverablePaths,
      refusedPaths,
      reason: "one or more conflicts are not on the generated-file allowlist",
    };
  }

  return {
    recoverable: true,
    recoverablePaths,
    refusedPaths: [],
    reason: "all conflicts are allowlisted generated files",
  };
}
