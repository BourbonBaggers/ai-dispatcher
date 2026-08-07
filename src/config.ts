/**
 * Configuration and CLI parsing.
 *
 * Repository identity is explicit and validated before anything else runs. There is
 * no hard-coded fallback repository anywhere in the service — a missing or malformed
 * `--repo owner/repository` fails fast with a useful error.
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
import {
  DEFAULT_BLOCKED_QUEUE_AUDIT_EFFORT_LABEL,
  DEFAULT_BLOCKED_QUEUE_AUDIT_MAX_CANDIDATES,
  DEFAULT_BLOCKED_QUEUE_AUDIT_MODEL,
} from "./blocked-queue.ts";

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

type EnvLike = Record<string, string | undefined>;

function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

/**
 * Resolves `DISPATCHER_CI_ESCALATION_MODEL` the same way for every command that reuses
 * the escalation model (the polling loop and `target policy-cleanup`, issue #28) so the
 * validation stays in one place.
 */
export function resolveCiEscalationModel(env: EnvLike): { ok: true; value: string } | { ok: false; reason: string } {
  const ciEscalationModel =
    env.DISPATCHER_CI_ESCALATION_MODEL && env.DISPATCHER_CI_ESCALATION_MODEL.trim() !== ""
      ? env.DISPATCHER_CI_ESCALATION_MODEL.trim()
      : DEFAULT_CI_ESCALATION_MODEL;
  if (!modelByCliModel(ciEscalationModel)) {
    return {
      ok: false,
      reason:
        `Invalid DISPATCHER_CI_ESCALATION_MODEL "${ciEscalationModel}" — not a known model ` +
        "(see MODELS in models.ts).",
    };
  }
  return { ok: true, value: ciEscalationModel };
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
  /** CLI model identifier for conservative stale-blocked-issue audits. */
  blockedQueueAuditModel: string;
  /** effort:* label for stale-blocked-issue audits. */
  blockedQueueAuditEffortLabel: string;
  /** Maximum blocked issues to audit in one otherwise-idle scan. */
  blockedQueueAuditMaxCandidates: number;
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
  ai-dispatcher init --repo <owner/repository> [options]
  ai-dispatcher doctor [--env-file <path>]
  ai-dispatcher --repo <owner/repository> [options]
  ai-dispatcher status [--state-dir <path>] [--repo <owner/repo>] [--json] [--follow] [--no-github]
  ai-dispatcher history [--state-dir <path>] [--json] [--limit <count>]
  ai-dispatcher dashboard [--host <host>] [--port <port>] [--unit <systemd-unit>...]
                             Serve the local web status dashboard.
  ai-dispatcher report [--state-dir <path>]   Print the routing analytics report.
  ai-dispatcher ship --repo <owner/repo> --pr <n> [--issue <n>]
                             Merge, deploy, and verify one ad hoc pull request without a
                             dispatcher issue or agent run. See "ai-dispatcher ship --help".
  ai-dispatcher target policy-cleanup --repo <owner/repo> [--dry-run]
                             Use the escalation model to repair conflicts between a target
                             repo's agent instructions and the canonical dispatcher policy.
                             See "ai-dispatcher target policy-cleanup --help".

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
  --blocked-audit-model <model>
                             Non-frontier CLI model for stale blocked-queue audits
                             (default: DISPATCHER_BLOCKED_QUEUE_AUDIT_MODEL or
                             ${DEFAULT_BLOCKED_QUEUE_AUDIT_MODEL}).
  --blocked-audit-effort <effort:*>
                             Effort label for stale blocked-queue audits (default:
                             DISPATCHER_BLOCKED_QUEUE_AUDIT_EFFORT or
                             ${DEFAULT_BLOCKED_QUEUE_AUDIT_EFFORT_LABEL}).
  --blocked-audit-max <count>
                             Maximum blocked issues audited in one idle scan (default:
                             DISPATCHER_BLOCKED_QUEUE_AUDIT_MAX_CANDIDATES or
                             ${DEFAULT_BLOCKED_QUEUE_AUDIT_MAX_CANDIDATES}).
  --author-auth <mode>       Issue author authorization: author-allowlist | none
                             (default: DISPATCHER_ISSUE_AUTHOR_AUTH_MODE or author-allowlist).
  --trusted-authors <list>   Comma-separated trusted GitHub usernames for author-allowlist
                             (default: DISPATCHER_TRUSTED_ISSUE_AUTHORS).
  --log-level <level>        debug | info | warn | error (default: DISPATCHER_LOG_LEVEL or info).
  --help                     Show this message.

Example:
  ai-dispatcher --repo owner/repo
`;

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
        "blocked-audit-model": { type: "string" },
        "blocked-audit-effort": { type: "string" },
        "blocked-audit-max": { type: "string" },
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

  const ciEscalationModelResult = resolveCiEscalationModel(env);
  if (!ciEscalationModelResult.ok) {
    return { ok: false, message: `${ciEscalationModelResult.reason}\n\n${USAGE}` };
  }
  const ciEscalationModel = ciEscalationModelResult.value;

  const envSource = env.DISPATCHER_ENV_SOURCE_DIR;
  const autoship = env.DISPATCHER_AUTOSHIP_CMD;
  const generatedConflictAllowlist = parseGeneratedConflictAllowlist(
    env.DISPATCHER_GENERATED_CONFLICT_ALLOWLIST,
  );
  const generatedConflictRegen = env.DISPATCHER_GENERATED_CONFLICT_REGEN_CMD;
  const blockedQueueAuditModel =
    ((values["blocked-audit-model"] as string | undefined) ??
      env.DISPATCHER_BLOCKED_QUEUE_AUDIT_MODEL ??
      DEFAULT_BLOCKED_QUEUE_AUDIT_MODEL).trim();
  const blockedQueueAuditEffortLabel =
    ((values["blocked-audit-effort"] as string | undefined) ??
      env.DISPATCHER_BLOCKED_QUEUE_AUDIT_EFFORT ??
      DEFAULT_BLOCKED_QUEUE_AUDIT_EFFORT_LABEL).trim();
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
    blockedQueueAuditModel,
    blockedQueueAuditEffortLabel,
    blockedQueueAuditMaxCandidates: positiveInt(
      (values["blocked-audit-max"] as string | undefined) ??
        env.DISPATCHER_BLOCKED_QUEUE_AUDIT_MAX_CANDIDATES,
      DEFAULT_BLOCKED_QUEUE_AUDIT_MAX_CANDIDATES,
    ),
    authorAuth,
    ntfyUrl: ntfyUrl && ntfyUrl.trim() !== "" ? ntfyUrl : null,
    ntfyTopic: ntfyTopic && ntfyTopic.trim() !== "" ? ntfyTopic : null,
    once: Boolean(values.once),
    dryRun: Boolean(values["dry-run"]),
  };

  return { ok: true, config };
}

// ── `ai-dispatcher ship` — one-shot autoship for an ad hoc PR (issue #27) ──────────────

export interface ShipCliConfig {
  repo: RepoSlug;
  pr: number;
  /** Optional issue to close after verified delivery; null when none was supplied. */
  issue: number | null;
  autoshipCmd: string;
  autoshipTimeoutMinutes: number;
  autoshipDeploymentDir: string;
  logLevel: LogLevel;
}

export interface ShipCliParseResult {
  ok: boolean;
  config?: ShipCliConfig;
  message?: string;
  help?: boolean;
}

export const SHIP_USAGE = `ai-dispatcher ship — merge, deploy, and verify one already-open pull request using
the dispatcher's existing autoship machinery, without a dispatcher issue or agent run.

Usage:
  ai-dispatcher ship --repo <owner/repository> --pr <number> [--issue <number>]

Required:
  --repo <owner/repo>   Target GitHub repository (canonical owner/repository).
                        May also be supplied via DISPATCHER_REPO; the flag wins.
  --pr <number>         The pull request to ship.

Options:
  --issue <number>      Close this issue after verified production delivery.
                        Omit to perform no issue operation at all.
  --autoship-deploy-dir <path>
                        Dedicated autoship deployment checkout (default:
                        DISPATCHER_AUTOSHIP_DEPLOYMENT_DIR or
                        <state-dir>/autoship-deployments/<owner>-<repo>).
  --autoship-timeout-minutes <minutes>
                        Merge/deploy/verify/rollback ceiling (default:
                        DISPATCHER_AUTOSHIP_TIMEOUT_MINUTES or 120).
  --state-dir <path>    Used only to compute the default deployment checkout above
                        (default: DISPATCHER_STATE_DIR or ./state).
  --log-level <level>   debug | info | warn | error (default: DISPATCHER_LOG_LEVEL or info).
  --help                Show this message.

Requires DISPATCHER_AUTOSHIP_CMD to be configured -- ship has nothing to run otherwise.

Example:
  ai-dispatcher ship --repo owner/repo --pr 123 --issue 456
`;

function requiredPositiveInt(raw: string | undefined, flag: string): { ok: true; value: number } | { ok: false; reason: string } {
  if (raw === undefined || raw.trim() === "") {
    return { ok: false, reason: `${flag} is required` };
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n <= 0 || String(n) !== raw.trim()) {
    return { ok: false, reason: `${flag} must be a positive integer, got "${raw}"` };
  }
  return { ok: true, value: n };
}

/** Parses `ai-dispatcher ship ...` args, independent of the polling-loop config. */
export function parseShipCliConfig(argv: string[], env: EnvLike): ShipCliParseResult {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: false,
      options: {
        repo: { type: "string" },
        pr: { type: "string" },
        issue: { type: "string" },
        "state-dir": { type: "string" },
        "autoship-deploy-dir": { type: "string" },
        "autoship-timeout-minutes": { type: "string" },
        "log-level": { type: "string" },
        help: { type: "boolean", default: false },
      },
    });
  } catch (err) {
    return { ok: false, message: `${(err as Error).message}\n\n${SHIP_USAGE}` };
  }

  const values = parsed.values;
  if (values.help) return { ok: true, help: true, message: SHIP_USAGE };

  const repoResult = parseRepoSlug((values.repo as string | undefined) ?? env.DISPATCHER_REPO);
  if (!repoResult.ok) {
    return { ok: false, message: `Invalid repository: ${repoResult.reason}\n\n${SHIP_USAGE}` };
  }

  const prResult = requiredPositiveInt(values.pr as string | undefined, "--pr");
  if (!prResult.ok) {
    return { ok: false, message: `${prResult.reason}\n\n${SHIP_USAGE}` };
  }

  let issue: number | null = null;
  if (values.issue !== undefined) {
    const issueResult = requiredPositiveInt(values.issue as string, "--issue");
    if (!issueResult.ok) {
      return { ok: false, message: `${issueResult.reason}\n\n${SHIP_USAGE}` };
    }
    issue = issueResult.value;
  }

  const autoshipCmd = env.DISPATCHER_AUTOSHIP_CMD;
  if (!autoshipCmd || autoshipCmd.trim() === "") {
    return {
      ok: false,
      message: `DISPATCHER_AUTOSHIP_CMD must be configured to ship anything.\n\n${SHIP_USAGE}`,
    };
  }

  const logLevelRaw =
    (values["log-level"] as string | undefined) ?? env.DISPATCHER_LOG_LEVEL ?? "info";
  if (!isLogLevel(logLevelRaw)) {
    return {
      ok: false,
      message: `Invalid --log-level "${logLevelRaw}" (debug|info|warn|error).\n\n${SHIP_USAGE}`,
    };
  }

  const stateDir = expandHome(
    (values["state-dir"] as string | undefined) ?? env.DISPATCHER_STATE_DIR ?? "./state",
  );
  const autoshipDeploymentDir =
    (values["autoship-deploy-dir"] as string | undefined) ??
    env.DISPATCHER_AUTOSHIP_DEPLOYMENT_DIR;

  const config: ShipCliConfig = {
    repo: repoResult.value,
    pr: prResult.value,
    issue,
    autoshipCmd,
    autoshipTimeoutMinutes: positiveInt(
      (values["autoship-timeout-minutes"] as string | undefined) ??
        env.DISPATCHER_AUTOSHIP_TIMEOUT_MINUTES,
      120,
    ),
    autoshipDeploymentDir:
      autoshipDeploymentDir && autoshipDeploymentDir.trim() !== ""
        ? expandHome(autoshipDeploymentDir)
        : join(stateDir, "autoship-deployments", `${repoResult.value.owner}-${repoResult.value.repo}`),
    logLevel: logLevelRaw,
  };

  return { ok: true, config };
}

// ── `ai-dispatcher target policy-cleanup` — on-demand policy audit (issue #28) ─────────

export interface PolicyCleanupCliConfig {
  repo: RepoSlug;
  dryRun: boolean;
  ciEscalationModel: string;
  logLevel: LogLevel;
}

export interface PolicyCleanupCliParseResult {
  ok: boolean;
  config?: PolicyCleanupCliConfig;
  message?: string;
  help?: boolean;
}

export const POLICY_CLEANUP_USAGE = `ai-dispatcher target policy-cleanup — use the configured escalation model to find and
repair conflicts between a target repository's committed agent-instruction files
(AGENTS.md, CLAUDE.md) and the canonical dispatcher policy, then open a ready PR.

Explicitly invoked only; never runs during a normal scan. A clean repository produces no
branch or PR. Delivery (merge, deploy, verification) is the existing one-shot \`ship\`
command's job (issue #27), not this command's.

Usage:
  ai-dispatcher target policy-cleanup --repo <owner/repository> [--dry-run]

Required:
  --repo <owner/repo>   Target GitHub repository (canonical owner/repository).
                        May also be supplied via DISPATCHER_REPO; the flag wins.

Options:
  --dry-run             Report conflicts without writing, committing, or opening a PR.
  --log-level <level>   debug | info | warn | error (default: DISPATCHER_LOG_LEVEL or info).
  --help                Show this message.

Uses DISPATCHER_CI_ESCALATION_MODEL (same setting the polling loop uses for CI repair
escalation) rather than introducing another model setting.

Example:
  ai-dispatcher target policy-cleanup --repo owner/repo --dry-run
`;

/** Parses `ai-dispatcher target policy-cleanup ...` args, independent of the loop config. */
export function parsePolicyCleanupCliConfig(argv: string[], env: EnvLike): PolicyCleanupCliParseResult {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: false,
      options: {
        repo: { type: "string" },
        "dry-run": { type: "boolean", default: false },
        "log-level": { type: "string" },
        help: { type: "boolean", default: false },
      },
    });
  } catch (err) {
    return { ok: false, message: `${(err as Error).message}\n\n${POLICY_CLEANUP_USAGE}` };
  }

  const values = parsed.values;
  if (values.help) return { ok: true, help: true, message: POLICY_CLEANUP_USAGE };

  const repoResult = parseRepoSlug((values.repo as string | undefined) ?? env.DISPATCHER_REPO);
  if (!repoResult.ok) {
    return { ok: false, message: `Invalid repository: ${repoResult.reason}\n\n${POLICY_CLEANUP_USAGE}` };
  }

  const logLevelRaw =
    (values["log-level"] as string | undefined) ?? env.DISPATCHER_LOG_LEVEL ?? "info";
  if (!isLogLevel(logLevelRaw)) {
    return {
      ok: false,
      message: `Invalid --log-level "${logLevelRaw}" (debug|info|warn|error).\n\n${POLICY_CLEANUP_USAGE}`,
    };
  }

  const ciEscalationModelResult = resolveCiEscalationModel(env);
  if (!ciEscalationModelResult.ok) {
    return { ok: false, message: `${ciEscalationModelResult.reason}\n\n${POLICY_CLEANUP_USAGE}` };
  }

  const config: PolicyCleanupCliConfig = {
    repo: repoResult.value,
    dryRun: Boolean(values["dry-run"]),
    ciEscalationModel: ciEscalationModelResult.value,
    logLevel: logLevelRaw,
  };

  return { ok: true, config };
}
