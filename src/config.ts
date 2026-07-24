/**
 * Configuration and CLI parsing.
 *
 * Repository identity is explicit and validated before anything else runs. There is
 * no hard-coded fallback repository anywhere in the service — a missing or malformed
 * `--repo owner/repository` fails fast with a useful error (issue #320).
 */

import { parseArgs } from "node:util";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { resolveAuthorAuthConfig, type DispatcherAuthorAuthConfig } from "./author-auth.ts";
import {
  DEFAULT_MAX_GENERATED_CONFLICT_RECOVERIES,
  parseGeneratedConflictAllowlist,
} from "./generated-conflict-recovery.ts";
import { modelByCliModel } from "./models.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";

/** The canonical GitHub repository form: `owner/repository`. */
export interface RepoSlug {
  owner: string;
  repo: string;
  /** `owner/repository`, exactly as gh expects it. */
  slug: string;
}

/**
 * GitHub `owner/name` rules, applied conservatively:
 *   - owner: 1–39 chars, alphanumeric or single hyphens, no leading/trailing hyphen
 *   - repo:  1–100 chars, [A-Za-z0-9._-]
 * A slug that does not match is rejected rather than guessed at.
 */
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const REPO_NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;

export type RepoParseResult = { ok: true; value: RepoSlug } | { ok: false; reason: string };

/** Parses and validates a `owner/repository` string. Never throws. */
export function parseRepoSlug(raw: string | undefined | null): RepoParseResult {
  if (raw === undefined || raw === null || raw.trim() === "") {
    return { ok: false, reason: "a target repository is required (--repo owner/repository)" };
  }
  const value = raw.trim();
  const parts = value.split("/");
  if (parts.length !== 2) {
    return {
      ok: false,
      reason: `"${value}" is not a canonical owner/repository (expected exactly one "/")`,
    };
  }
  const [owner, repo] = parts as [string, string];
  if (!OWNER_RE.test(owner)) {
    return { ok: false, reason: `"${owner}" is not a valid GitHub owner name` };
  }
  if (!REPO_NAME_RE.test(repo)) {
    return { ok: false, reason: `"${repo}" is not a valid GitHub repository name` };
  }
  // Reject the disallowed bare-dot repository names outright.
  if (repo === "." || repo === "..") {
    return { ok: false, reason: `"${repo}" is not a valid GitHub repository name` };
  }
  return { ok: true, value: { owner, repo, slug: `${owner}/${repo}` } };
}

/** Expands a leading `~` to the current user's home directory. */
export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  return p;
}

const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

/** Last-resort model for the one escalation attempt after self-heal is exhausted. */
export const DEFAULT_CI_ESCALATION_MODEL = "claude-opus-4-8";

function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

export interface DispatcherConfig {
  repo: RepoSlug;
  /** Pristine mirror clone kept on origin/main; per-run checkouts are cloned from it. */
  repoDir: string;
  /** Parent directory for per-run agent checkouts. */
  worktreeDir: string;
  /** Optional checkout whose .env seeds each run checkout; null to skip. */
  envSourceDir: string | null;
  pollIntervalSeconds: number;
  maxRuntimeMinutes: number;
  stateDir: string;
  logLevel: LogLevel;
  /** Optional repo-specific autoship command; null when disabled (the default). */
  autoshipCmd: string | null;
  /** Wall-clock ceiling for one merge/deploy/verify/rollback command. */
  autoshipTimeoutMinutes: number;
  /** Dedicated checkout used only by autoship deployment/rollback commands. */
  autoshipDeploymentDir: string;
  /** Exact generated paths the autoship merge-conflict repair may discard/regenerate. */
  generatedConflictAllowlist: string[];
  /** Optional repo-owned command that regenerates allowlisted generated files after repair. */
  generatedConflictRegenCmd: string | null;
  /** Maximum automatic repair attempts during one autoship pass. */
  generatedConflictMaxAttempts: number;
  /** How long autoship waits for CI after pushing a repaired branch. */
  generatedConflictCiWaitSeconds: number;
  /** Assigned-model repair attempts per agent/CI/merge/deploy phase before escalation. */
  ciSelfHealMaxAttempts: number;
  /**
   * Model for the single final automated attempt after a phase's repair budget is spent.
   * A CLI model identifier (models.ts `cliModel`), not a model:* label.
   */
  ciEscalationModel: string;
  authorAuth: DispatcherAuthorAuthConfig;
  ntfyUrl: string | null;
  ntfyTopic: string | null;
  /** Run a single scan and exit, rather than looping. */
  once: boolean;
  /**
   * Validate configuration and readiness, log what WOULD be dispatched, but never
   * launch an agent or mutate GitHub. Used for safe cutover validation.
   */
  dryRun: boolean;
}

export interface CliParseResult {
  ok: boolean;
  config?: DispatcherConfig;
  /** Populated on failure, or when --help was requested. */
  message?: string;
  /** True when the caller asked for --help (message is the usage text). */
  help?: boolean;
}

export const USAGE = `ai-dispatcher — poll a GitHub repo and run Codex / Claude Code on labelled issues.

Usage:
  ai-dispatcher --repo <owner/repository> [options]
  ai-dispatcher report [--state-dir <path>]   Print the routing analytics report.

Required:
  --repo <owner/repo>        Target GitHub repository (canonical owner/repository).
                             May also be supplied via DISPATCHER_REPO; the flag wins.

Options:
  --once                     Run a single scan and exit (default: poll forever).
  --dry-run                  Validate + report the next dispatch without launching or
                             mutating anything. Safe for cutover validation.
  --interval <seconds>       Poll interval (default: DISPATCHER_POLL_INTERVAL_SECONDS or 900).
  --max-minutes <minutes>    Per-run wall-clock budget (default: DISPATCHER_MAX_RUNTIME_MINUTES or 90).
  --state-dir <path>         Durable state directory (default: DISPATCHER_STATE_DIR or ./state).
  --repo-dir <path>          Mirror checkout of the target repo (default: DISPATCHER_REPO_DIR).
  --worktree-dir <path>      Parent dir for per-run checkouts (default: DISPATCHER_WORKTREE_DIR).
  --autoship-deploy-dir <path>
                             Dedicated autoship deployment checkout (default:
                             DISPATCHER_AUTOSHIP_DEPLOYMENT_DIR or
                             <state-dir>/autoship-deployments/<owner>-<repo>).
  --autoship-timeout-minutes <minutes>
                             Merge/deploy/verify/rollback ceiling (default:
                             DISPATCHER_AUTOSHIP_TIMEOUT_MINUTES or 120).
  --author-auth <mode>       Issue author authorization: author-allowlist | none
                             (default: DISPATCHER_ISSUE_AUTHOR_AUTH_MODE or author-allowlist).
  --trusted-authors <list>   Comma-separated trusted GitHub usernames for author-allowlist
                             (default: DISPATCHER_TRUSTED_ISSUE_AUTHORS).
  --log-level <level>        debug | info | warn | error (default: DISPATCHER_LOG_LEVEL or info).
  --help                     Show this message.

Example:
  ai-dispatcher --repo BourbonBaggers/internal-tools
`;

type EnvLike = Record<string, string | undefined>;

function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * Resolves CLI args + environment into a validated config. Precedence is CLI flag,
 * then environment, then a documented default. Repository identity is the one value
 * with no default — it must be supplied and must be valid.
 */
export function parseCliConfig(argv: string[], env: EnvLike): CliParseResult {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: false,
      options: {
        repo: { type: "string" },
        once: { type: "boolean", default: false },
        "dry-run": { type: "boolean", default: false },
        interval: { type: "string" },
        "max-minutes": { type: "string" },
        "state-dir": { type: "string" },
        "repo-dir": { type: "string" },
        "worktree-dir": { type: "string" },
        "autoship-deploy-dir": { type: "string" },
        "autoship-timeout-minutes": { type: "string" },
        "author-auth": { type: "string" },
        "trusted-authors": { type: "string" },
        "log-level": { type: "string" },
        help: { type: "boolean", default: false },
      },
    });
  } catch (err) {
    return { ok: false, message: `${(err as Error).message}\n\n${USAGE}` };
  }

  const values = parsed.values;
  if (values.help) return { ok: true, help: true, message: USAGE };

  const repoResult = parseRepoSlug((values.repo as string | undefined) ?? env.DISPATCHER_REPO);
  if (!repoResult.ok) {
    return { ok: false, message: `Invalid repository: ${repoResult.reason}\n\n${USAGE}` };
  }

  const repoDir = (values["repo-dir"] as string | undefined) ?? env.DISPATCHER_REPO_DIR;
  const worktreeDir = (values["worktree-dir"] as string | undefined) ?? env.DISPATCHER_WORKTREE_DIR;
  if (!repoDir || repoDir.trim() === "") {
    return {
      ok: false,
      message: `A mirror checkout is required (--repo-dir or DISPATCHER_REPO_DIR).\n\n${USAGE}`,
    };
  }
  if (!worktreeDir || worktreeDir.trim() === "") {
    return {
      ok: false,
      message: `A worktree directory is required (--worktree-dir or DISPATCHER_WORKTREE_DIR).\n\n${USAGE}`,
    };
  }

  const logLevelRaw =
    (values["log-level"] as string | undefined) ?? env.DISPATCHER_LOG_LEVEL ?? "info";
  if (!isLogLevel(logLevelRaw)) {
    return {
      ok: false,
      message: `Invalid --log-level "${logLevelRaw}" (debug|info|warn|error).\n\n${USAGE}`,
    };
  }

  const ciEscalationModel =
    env.DISPATCHER_CI_ESCALATION_MODEL && env.DISPATCHER_CI_ESCALATION_MODEL.trim() !== ""
      ? env.DISPATCHER_CI_ESCALATION_MODEL.trim()
      : DEFAULT_CI_ESCALATION_MODEL;
  if (!modelByCliModel(ciEscalationModel)) {
    return {
      ok: false,
      message:
        `Invalid DISPATCHER_CI_ESCALATION_MODEL "${ciEscalationModel}" — not a known model ` +
        `(see MODELS in models.ts).\n\n${USAGE}`,
    };
  }

  const envSource = env.DISPATCHER_ENV_SOURCE_DIR;
  const autoship = env.DISPATCHER_AUTOSHIP_CMD;
  const generatedConflictAllowlist = parseGeneratedConflictAllowlist(
    env.DISPATCHER_GENERATED_CONFLICT_ALLOWLIST,
  );
  const generatedConflictRegen = env.DISPATCHER_GENERATED_CONFLICT_REGEN_CMD;
  const authorAuth = resolveAuthorAuthConfig(
    (values["author-auth"] as string | undefined) ?? env.DISPATCHER_ISSUE_AUTHOR_AUTH_MODE,
    (values["trusted-authors"] as string | undefined) ?? env.DISPATCHER_TRUSTED_ISSUE_AUTHORS,
  );
  const ntfyUrl = env.NTFY_URL;
  const ntfyTopic = env.NTFY_TOPIC;
  const stateDir = expandHome(
    (values["state-dir"] as string | undefined) ?? env.DISPATCHER_STATE_DIR ?? "./state",
  );
  const autoshipDeploymentDir =
    (values["autoship-deploy-dir"] as string | undefined) ??
    env.DISPATCHER_AUTOSHIP_DEPLOYMENT_DIR;

  const config: DispatcherConfig = {
    repo: repoResult.value,
    repoDir: expandHome(repoDir),
    worktreeDir: expandHome(worktreeDir),
    envSourceDir: envSource && envSource.trim() !== "" ? expandHome(envSource) : null,
    pollIntervalSeconds: positiveInt(
      (values.interval as string | undefined) ?? env.DISPATCHER_POLL_INTERVAL_SECONDS,
      900,
    ),
    maxRuntimeMinutes: positiveInt(
      (values["max-minutes"] as string | undefined) ?? env.DISPATCHER_MAX_RUNTIME_MINUTES,
      90,
    ),
    stateDir,
    logLevel: logLevelRaw,
    autoshipCmd: autoship && autoship.trim() !== "" ? autoship : null,
    autoshipTimeoutMinutes: positiveInt(
      (values["autoship-timeout-minutes"] as string | undefined) ??
        env.DISPATCHER_AUTOSHIP_TIMEOUT_MINUTES,
      120,
    ),
    autoshipDeploymentDir:
      autoshipDeploymentDir && autoshipDeploymentDir.trim() !== ""
        ? expandHome(autoshipDeploymentDir)
        : join(stateDir, "autoship-deployments", `${repoResult.value.owner}-${repoResult.value.repo}`),
    generatedConflictAllowlist,
    generatedConflictRegenCmd:
      generatedConflictRegen && generatedConflictRegen.trim() !== ""
        ? generatedConflictRegen
        : null,
    generatedConflictMaxAttempts: positiveInt(
      env.DISPATCHER_GENERATED_CONFLICT_MAX_ATTEMPTS,
      DEFAULT_MAX_GENERATED_CONFLICT_RECOVERIES,
    ),
    generatedConflictCiWaitSeconds: positiveInt(
      env.DISPATCHER_GENERATED_CONFLICT_CI_WAIT_SECONDS,
      900,
    ),
    ciSelfHealMaxAttempts: positiveInt(env.DISPATCHER_CI_SELF_HEAL_MAX_ATTEMPTS, 2),
    ciEscalationModel,
    authorAuth,
    ntfyUrl: ntfyUrl && ntfyUrl.trim() !== "" ? ntfyUrl : null,
    ntfyTopic: ntfyTopic && ntfyTopic.trim() !== "" ? ntfyTopic : null,
    once: Boolean(values.once),
    dryRun: Boolean(values["dry-run"]),
  };

  return { ok: true, config };
}
