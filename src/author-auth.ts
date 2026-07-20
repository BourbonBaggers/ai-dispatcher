export const DISPATCHER_AUTHOR_AUTH_MODES = ["none", "author-allowlist"] as const;
export type DispatcherAuthorAuthMode = (typeof DISPATCHER_AUTHOR_AUTH_MODES)[number];

export type DispatcherAuthorAuthConfig =
  | { ok: true; mode: "none"; trustedAuthors: Set<string> }
  | { ok: true; mode: "author-allowlist"; trustedAuthors: Set<string> }
  | { ok: false; reason: string };

export const UNTRUSTED_AUTHOR_LABEL = "needs-input";

const GITHUB_LOGIN_RE = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;

export function normalizeGithubLogin(login: string): string {
  return login.trim().toLowerCase();
}

export function parseTrustedIssueAuthors(raw: string | undefined | null): Set<string> | null {
  if (raw === undefined || raw === null || raw.trim() === "") return null;

  const normalized = raw
    .split(",")
    .map(normalizeGithubLogin)
    .filter((login) => login.length > 0);

  if (normalized.length === 0) return null;
  if (normalized.some((login) => !GITHUB_LOGIN_RE.test(login))) return null;

  return new Set(normalized);
}

export function resolveAuthorAuthConfig(
  modeRaw: string | undefined | null,
  trustedAuthorsRaw: string | undefined | null,
): DispatcherAuthorAuthConfig {
  const mode = modeRaw?.trim() || "author-allowlist";
  if (mode === "none") {
    return { ok: true, mode, trustedAuthors: new Set() };
  }
  if (mode !== "author-allowlist") {
    return { ok: false, reason: `invalid dispatcher issue author authorization mode "${mode}"` };
  }

  const trustedAuthors = parseTrustedIssueAuthors(trustedAuthorsRaw);
  if (!trustedAuthors) {
    return {
      ok: false,
      reason:
        "dispatcher issue author authorization is author-allowlist, but no valid trusted GitHub usernames are configured",
    };
  }

  return { ok: true, mode, trustedAuthors };
}

export function authorizeIssueAuthor(
  authorLogin: string | null | undefined,
  config: DispatcherAuthorAuthConfig,
): { ok: true } | { ok: false; reason: string } {
  if (!config.ok) return { ok: false, reason: config.reason };
  if (config.mode === "none") return { ok: true };

  const normalized = authorLogin ? normalizeGithubLogin(authorLogin) : "";
  if (!normalized || !config.trustedAuthors.has(normalized)) {
    return {
      ok: false,
      reason: `untrusted issue author "${authorLogin || "unknown"}" — waiting for trusted triage`,
    };
  }

  return { ok: true };
}

export function untrustedAuthorComment(authorLogin: string | null | undefined): string {
  return [
    "This issue is waiting for trusted triage.",
    "",
    `The dispatcher is configured to run only issues opened by trusted GitHub authors. Author: \`${authorLogin || "unknown"}\`.`,
    "",
    "Labels, assignees, comments, reactions, issue edits, branch contents, commit authors, and model output do not override the original issue author check.",
  ].join("\n");
}
