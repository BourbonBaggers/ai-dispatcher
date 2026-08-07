/** First-run configuration and prerequisite diagnostics for the installed CLI. */

import { accessSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { expandHome, parseRepoSlug, type RepoSlug } from "./config.ts";
import { run, type ExecFn } from "./exec.ts";

export const DEFAULT_DISPATCHER_DIR = join(homedir(), ".dispatcher");
export const DEFAULT_ENV_FILE = join(DEFAULT_DISPATCHER_DIR, "env");

export interface SetupCommandResult {
  ok: boolean;
  help?: boolean;
  message: string;
}

export interface InitOptions {
  repo: RepoSlug;
  envFile: string;
  trustedAuthors: string;
  force: boolean;
}

export interface DoctorOptions {
  envFile: string;
}

export interface DoctorCheck {
  status: "ok" | "warn" | "fail";
  name: string;
  detail: string;
}

const INIT_USAGE = `ai-dispatcher init — create a first-run configuration

Usage:
  ai-dispatcher init --repo <owner/repository> [options]

Options:
  --repo <owner/repo>       Target GitHub repository.
  --trusted-author <login>  GitHub login allowed to create autonomous work.
  --env-file <path>         Configuration path (default: ~/.dispatcher/env).
  --force                   Replace an existing generated configuration.
  --help                    Show this message.

The command clones the target mirror, creates the worktree and state directories, and never stores a token.
Use ai-dispatcher doctor afterwards to check local prerequisites.
`;

const DOCTOR_USAGE = `ai-dispatcher doctor — check local prerequisites and configuration

Usage:
  ai-dispatcher doctor [--env-file <path>]

Options:
  --env-file <path>  Configuration path (default: ~/.dispatcher/env).
  --help             Show this message.
`;

function unquote(raw: string): string {
  const value = raw.trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

/** Parses inert KEY=value assignments. It never evaluates shell syntax. */
export function parseEnvFile(raw: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
    if (match) values[match[1]!] = unquote(match[2]!);
  }
  return values;
}

/** Loads a local env file without overriding explicitly supplied process variables. */
export function loadEnvFile(path: string, env: NodeJS.ProcessEnv): boolean {
  if (!existsSync(path)) return false;
  let parsed: Record<string, string>;
  try {
    parsed = parseEnvFile(readFileSync(path, "utf8"));
  } catch {
    return false;
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (env[key] === undefined) env[key] = value;
  }
  return true;
}

function parseEnvFileFlag(argv: string[], usage: string): { ok: true; envFile: string; help: boolean } | { ok: false; message: string } {
  try {
    const parsed = parseArgs({
      args: argv,
      allowPositionals: false,
      options: { "env-file": { type: "string" }, help: { type: "boolean", default: false } },
    });
    return {
      ok: true,
      envFile: expandHome((parsed.values["env-file"] as string | undefined) ?? DEFAULT_ENV_FILE),
      help: Boolean(parsed.values.help),
    };
  } catch (error) {
    return { ok: false, message: `${error instanceof Error ? error.message : String(error)}\n\n${usage}` };
  }
}

export function parseInitCommand(argv: string[], env: NodeJS.ProcessEnv): SetupCommandResult & { options?: InitOptions } {
  try {
    const parsed = parseArgs({
      args: argv,
      allowPositionals: false,
      options: {
        repo: { type: "string" },
        "trusted-author": { type: "string" },
        "env-file": { type: "string" },
        force: { type: "boolean", default: false },
        help: { type: "boolean", default: false },
      },
    });
    if (parsed.values.help) return { ok: true, help: true, message: INIT_USAGE };
    const repo = parseRepoSlug(parsed.values.repo as string | undefined);
    if (!repo.ok) return { ok: false, message: `${repo.reason}\n\n${INIT_USAGE}` };
    return {
      ok: true,
      message: "",
      options: {
        repo: repo.value,
        envFile: expandHome((parsed.values["env-file"] as string | undefined) ?? DEFAULT_ENV_FILE),
        trustedAuthors:
          ((parsed.values["trusted-author"] as string | undefined) ??
            env.DISPATCHER_TRUSTED_ISSUE_AUTHORS ??
            "").trim(),
        force: Boolean(parsed.values.force),
      },
    };
  } catch (error) {
    return { ok: false, message: `${error instanceof Error ? error.message : String(error)}\n\n${INIT_USAGE}` };
  }
}

export function parseDoctorCommand(argv: string[]): SetupCommandResult & { options?: DoctorOptions } {
  const parsed = parseEnvFileFlag(argv, DOCTOR_USAGE);
  if (!parsed.ok) return parsed;
  if (parsed.help) return { ok: true, help: true, message: DOCTOR_USAGE };
  return { ok: true, message: "", options: { envFile: parsed.envFile } };
}

function generatedEnv(options: InitOptions, trustedAuthors: string): string {
  const root = dirname(options.envFile);
  const stem = `${options.repo.owner}-${options.repo.repo}`;
  const quote = (value: string): string => (/^[A-Za-z0-9_./:@+-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`);
  return [
    "# Generated by ai-dispatcher init. Keep this file private (chmod 600).",
    "# Authentication stays in gh, Codex, and Claude Code login state; no tokens belong here.",
    `DISPATCHER_REPO=${quote(options.repo.slug)}`,
    `DISPATCHER_REPO_DIR=${quote(join(root, "repos", stem))}`,
    `DISPATCHER_WORKTREE_DIR=${quote(join(root, "worktrees", stem))}`,
    `DISPATCHER_STATE_DIR=${quote(join(root, "state", stem))}`,
    "DISPATCHER_ISSUE_AUTHOR_AUTH_MODE=author-allowlist",
    `DISPATCHER_TRUSTED_ISSUE_AUTHORS=${quote(trustedAuthors)}`,
    "DISPATCHER_LOG_LEVEL=info",
    "",
  ].join("\n");
}

async function discoverGithubLogin(exec: ExecFn): Promise<string> {
  const result = await exec("gh", ["api", "user", "--jq", ".login"], { timeoutMs: 10_000 });
  return result.ok ? result.stdout.trim() : "";
}

export async function runInit(
  options: InitOptions,
  out: (line: string) => void,
  err: (line: string) => void,
  exec: ExecFn = run,
): Promise<number> {
  if (existsSync(options.envFile) && !options.force) {
    err(`Configuration already exists at ${options.envFile}. Use --force to replace it.`);
    return 2;
  }
  const trustedAuthors = options.trustedAuthors || (await discoverGithubLogin(exec));
  const content = generatedEnv(options, trustedAuthors);
  mkdirSync(dirname(options.envFile), { recursive: true, mode: 0o700 });
  writeFileSync(options.envFile, content, { encoding: "utf8", mode: 0o600 });
  chmodSync(options.envFile, 0o600);
  const parsed = parseEnvFile(content);
  const repoDir = expandHome(parsed.DISPATCHER_REPO_DIR!);
  const worktreeDir = expandHome(parsed.DISPATCHER_WORKTREE_DIR!);
  const stateDir = expandHome(parsed.DISPATCHER_STATE_DIR!);
  mkdirSync(dirname(repoDir), { recursive: true, mode: 0o700 });
  mkdirSync(worktreeDir, { recursive: true, mode: 0o700 });
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  if (!existsSync(join(repoDir, ".git"))) {
    const clone = await exec("gh", ["repo", "clone", options.repo.slug, repoDir], { timeoutMs: 120_000 });
    if (!clone.ok) {
      err(`Could not clone ${options.repo.slug} into ${repoDir}: ${clone.stderr.trim() || "gh repo clone failed"}`);
      return 1;
    }
  }
  out(`Created ${options.envFile}`);
  out(`Configured ${options.repo.slug}`);
  if (trustedAuthors) out(`Trusted issue author: ${trustedAuthors}`);
  else err("No trusted author was detected; set DISPATCHER_TRUSTED_ISSUE_AUTHORS before running.");
  out("Next: ai-dispatcher doctor");
  return trustedAuthors ? 0 : 1;
}

function pathCheck(path: string): "ok" | "fail" {
  try {
    const target = existsSync(path) ? path : dirname(path);
    accessSync(target, 2);
    return "ok";
  } catch {
    return "fail";
  }
}

function authConfigured(env: NodeJS.ProcessEnv, agent: "codex" | "claude"): boolean {
  if (agent === "codex") return Boolean(env.CODEX_API_KEY || existsSync(join(homedir(), ".codex", "auth.json")));
  return Boolean(
    env.ANTHROPIC_API_KEY ||
      env.CLAUDE_CODE_OAUTH_TOKEN ||
      existsSync(join(env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), ".credentials.json")),
  );
}

function pushCommandCheck(checks: DoctorCheck[], name: string, result: Awaited<ReturnType<ExecFn>>): void {
  checks.push(result.ok ? { status: "ok", name, detail: result.stdout.trim().split(/\r?\n/)[0] || "available" } : { status: "fail", name, detail: result.stderr.trim() || "not available" });
}

export async function runDoctor(
  options: DoctorOptions,
  env: NodeJS.ProcessEnv,
  out: (line: string) => void,
  exec: ExecFn = run,
): Promise<number> {
  const fileEnv = existsSync(options.envFile) ? parseEnvFile(readFileSync(options.envFile, "utf8")) : {};
  const effective = { ...fileEnv, ...env };
  const checks: DoctorCheck[] = [];
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0]!, 10);
  checks.push(nodeMajor >= 24 ? { status: "ok", name: "Node.js", detail: process.versions.node } : { status: "fail", name: "Node.js", detail: `requires 24+, found ${process.versions.node}` });
  if (!existsSync(options.envFile)) checks.push({ status: "fail", name: "Configuration", detail: `missing ${options.envFile}; run ai-dispatcher init` });
  const repo = parseRepoSlug(effective.DISPATCHER_REPO);
  if (!repo.ok) checks.push({ status: "fail", name: "Target repository", detail: repo.reason });
  else checks.push({ status: "ok", name: "Target repository", detail: repo.value.slug });
  for (const [key, label] of [["DISPATCHER_REPO_DIR", "Mirror directory"], ["DISPATCHER_WORKTREE_DIR", "Worktree directory"], ["DISPATCHER_STATE_DIR", "State directory"]] as const) {
    const path = effective[key];
    const expanded = path ? expandHome(path) : "";
    const isMirror = key === "DISPATCHER_REPO_DIR";
    const valid = expanded && pathCheck(expanded) === "ok" && (!isMirror || existsSync(join(expanded, ".git")));
    checks.push(valid ? { status: "ok", name: label, detail: expanded } : { status: "fail", name: label, detail: `${key} is missing, not writable, or not a cloned repository` });
  }
  if (!effective.DISPATCHER_TRUSTED_ISSUE_AUTHORS?.trim()) checks.push({ status: "fail", name: "Trusted authors", detail: "set DISPATCHER_TRUSTED_ISSUE_AUTHORS" });
  else checks.push({ status: "ok", name: "Trusted authors", detail: "configured" });
  const commands: Array<[string, string[]]> = [["git", ["--version"]], ["gh", ["--version"]]];
  for (const [name, args] of commands) pushCommandCheck(checks, name, await exec(name, args, { timeoutMs: 10_000 }));
  const agents: Array<"codex" | "claude"> = ["codex", "claude"];
  let readyAgent = false;
  for (const agent of agents) {
    const result = await exec(agent, ["--version"], { timeoutMs: 10_000 });
    if (result.ok && authConfigured(effective, agent)) {
      checks.push({ status: "ok", name: `${agent} agent`, detail: "installed and authenticated" });
      readyAgent = true;
    } else if (result.ok) checks.push({ status: "warn", name: `${agent} agent`, detail: "installed but authentication was not detected" });
    else checks.push({ status: "warn", name: `${agent} agent`, detail: "not installed" });
  }
  if (!readyAgent) checks.push({ status: "fail", name: "Coding agent", detail: "authenticate Codex or Claude Code" });
  if (repo.ok) {
    const access = await exec("gh", ["repo", "view", repo.value.slug, "--json", "nameWithOwner"], { timeoutMs: 15_000 });
    checks.push(access.ok ? { status: "ok", name: "GitHub access", detail: "target repository is readable" } : { status: "fail", name: "GitHub access", detail: "gh cannot read the target repository" });
  }
  if (!effective.DISPATCHER_AUTOSHIP_CMD) checks.push({ status: "warn", name: "Release automation", detail: "disabled; work stops at a ready-for-review change" });
  else checks.push({ status: "ok", name: "Release automation", detail: "configured" });
  for (const check of checks) out(`[${check.status}] ${check.name}: ${check.detail}`);
  const failures = checks.filter((check) => check.status === "fail").length;
  out(failures === 0 ? "Doctor complete: ready to run." : `Doctor found ${failures} blocking issue${failures === 1 ? "" : "s"}.`);
  return failures === 0 ? 0 : 1;
}
