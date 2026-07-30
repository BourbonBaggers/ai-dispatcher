import { parseArgs } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import {
  CLAIMING_STATUSES,
  WORKING_LABEL,
  PARKED_STATUSES,
  PR_READY_STATUSES,
  HELD_STATUSES,
  type DispatcherStatus,
} from "./labels.ts";
import {
  StateCorruptionError,
  phaseForStatus,
  readOnlyStateSnapshot,
  type DispatcherLiveness,
  type RunRecord,
} from "./state.ts";
import { readRunOutputEntries, type RunOutputEntry } from "./run-output.ts";
import { expandHome, parseRepoSlug } from "./config.ts";
import { run, type ExecFn } from "./exec.ts";

const STATUS_JSON_VERSION = 1;
const DEFAULT_HISTORY_LIMIT = 20;
const FOLLOW_POLL_MS = 500;
const GITHUB_STATUS_TIMEOUT_MS = 10_000;

type StatusArgs =
  | { ok: true; stateDir: string; json: boolean; follow: boolean; repo: string | null; github: boolean }
  | { ok: false; message: string };

type HistoryArgs =
  | { ok: true; stateDir: string; json: boolean; limit: number }
  | { ok: false; message: string };

export interface StatusJson {
  version: 1;
  service: DispatcherLiveness;
  stateSource: "primary" | "backup" | "empty";
  current: null | ReturnType<typeof runSummary>;
  github: GithubStatusEvidence;
}

export interface HistoryJson {
  version: 1;
  runs: ReturnType<typeof runSummary>[];
}

export type RunSummary = ReturnType<typeof runSummary>;

function stateDirForValue(raw: string | undefined, env: NodeJS.ProcessEnv): string {
  return expandHome(raw ?? env.DISPATCHER_STATE_DIR ?? "./state");
}

function repoForValue(raw: string | undefined): { ok: true; repo: string | null } | { ok: false; message: string } {
  if (raw === undefined || raw.trim() === "") return { ok: true, repo: null };
  const parsed = parseRepoSlug(raw);
  if (!parsed.ok) return { ok: false, message: `Invalid repository: ${parsed.reason}` };
  return { ok: true, repo: parsed.value.slug };
}

function parseStatusArgs(argv: string[], env: NodeJS.ProcessEnv): StatusArgs {
  try {
    const parsed = parseArgs({
      args: argv,
      allowPositionals: false,
      options: {
        "state-dir": { type: "string" },
        repo: { type: "string" },
        json: { type: "boolean", default: false },
        follow: { type: "boolean", default: false },
        "no-github": { type: "boolean", default: false },
      },
    });
    const repo = repoForValue((parsed.values.repo as string | undefined) ?? env.DISPATCHER_REPO);
    if (!repo.ok) return { ok: false, message: repo.message };
    return {
      ok: true,
      stateDir: stateDirForValue(parsed.values["state-dir"] as string | undefined, env),
      json: Boolean(parsed.values.json),
      follow: Boolean(parsed.values.follow),
      repo: repo.repo,
      github: !Boolean(parsed.values["no-github"]),
    };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

function parseHistoryArgs(argv: string[], env: NodeJS.ProcessEnv): HistoryArgs {
  try {
    const parsed = parseArgs({
      args: argv,
      allowPositionals: false,
      options: {
        "state-dir": { type: "string" },
        json: { type: "boolean", default: false },
        limit: { type: "string" },
      },
    });
    const rawLimit = parsed.values.limit as string | undefined;
    const limit = rawLimit === undefined ? DEFAULT_HISTORY_LIMIT : Number.parseInt(rawLimit, 10);
    if (!Number.isInteger(limit) || limit <= 0) {
      return { ok: false, message: "--limit must be a positive integer" };
    }
    return {
      ok: true,
      stateDir: stateDirForValue(parsed.values["state-dir"] as string | undefined, env),
      json: Boolean(parsed.values.json),
      limit,
    };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

function activeStatusRun(runs: RunRecord[]): RunRecord | null {
  const claiming = new Set<string>(CLAIMING_STATUSES);
  return (
    runs
      .filter((run) => claiming.has(run.status))
      .sort((a, b) => b.createdAt - a.createdAt)[0] ?? null
  );
}

function ghCommandFor(run: RunRecord): string | null {
  const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\//.exec(run.issueUrl);
  const repo = match?.[1];
  if (!repo) return null;
  if (run.prNumber !== null) {
    return `gh pr view ${run.prNumber} --repo ${repo} --checks`;
  }
  return `gh issue view ${run.issueNumber} --repo ${repo} --comments`;
}

function repoFromIssueUrl(url: string): string | null {
  return /^https:\/\/github\.com\/([^/]+\/[^/]+)\//.exec(url)?.[1] ?? null;
}

function inferRepoFromRuns(runs: RunRecord[]): string | null {
  return (
    runs
      .slice()
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((run) => repoFromIssueUrl(run.issueUrl))
      .find((repo) => repo !== null) ?? null
  );
}

function durationMs(run: RunRecord): number | null {
  const end = run.finishedAt ?? Date.now();
  return Math.max(0, end - run.startedAt);
}

function runSummary(run: RunRecord) {
  return {
    id: run.id,
    issue: {
      number: run.issueNumber,
      title: run.issueTitle,
      url: run.issueUrl,
    },
    pr: run.prNumber === null ? null : { number: run.prNumber, url: run.prUrl },
    branch: run.branch,
    agent: run.agent,
    modelLabel: run.modelLabel,
    cliModel: run.cliModel,
    effortLabel: run.effortLabel,
    cliEffort: run.cliEffort,
    status: run.status,
    phase: run.phase ?? phaseForStatus(run.status),
    trigger: run.trigger,
    timestamps: {
      createdAt: run.createdAt,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      durationMs: durationMs(run),
    },
    lastCommit: run.lastCommit,
    planPath: run.planPath,
    recovery: run.recovery ?? {},
    exhaustion: run.exhaustion ?? null,
    failureSummary: run.failureSummary,
    ghCommand: ghCommandFor(run),
  };
}

const NON_IDLE_RUN_STATUSES = new Set<DispatcherStatus>([
  "claimed",
  "running",
  "pr_ready",
  "shipped",
  "ci_pending",
  "ci_failed",
  "held",
  "failed",
  "timed_out",
  "interrupted",
  "abandoned",
  "token_exhausted",
]);

export function recentNonIdleRunSummaries(runs: RunRecord[], limit: number): RunSummary[] {
  if (!Number.isInteger(limit) || limit <= 0) return [];
  return runs
    .filter((run) => NON_IDLE_RUN_STATUSES.has(run.status))
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit)
    .map((run) => runSummary(run));
}

export interface GithubWorkingIssue {
  number: number;
  title: string;
  url: string;
  labels: string[];
  issueCommand: string;
  prSearchCommand: string;
}

export type GithubStatusEvidence =
  | { state: "not_configured"; repo: null; workingIssues: []; warning: null }
  | { state: "skipped"; repo: string | null; workingIssues: []; warning: null }
  | { state: "unavailable"; repo: string; workingIssues: []; warning: string }
  | { state: "ok"; repo: string; workingIssues: GithubWorkingIssue[]; warning: null };

const NO_GITHUB: GithubStatusEvidence = {
  state: "not_configured",
  repo: null,
  workingIssues: [],
  warning: null,
};

export function statusSnapshot(stateDir: string): StatusJson {
  const snapshot = readOnlyStateSnapshot(stateDir);
  const run = activeStatusRun(snapshot.state.runs);
  return {
    version: STATUS_JSON_VERSION,
    service: snapshot.liveness,
    stateSource: snapshot.source,
    current: run ? runSummary(run) : null,
    github: NO_GITHUB,
  };
}

interface RawGithubIssue {
  number?: unknown;
  title?: unknown;
  url?: unknown;
  labels?: Array<{ name?: unknown }>;
}

async function readGithubWorkingIssues(repo: string, exec: ExecFn): Promise<GithubStatusEvidence> {
  const result = await exec(
    "gh",
    [
      "issue",
      "list",
      "--repo",
      repo,
      "--state",
      "open",
      "--label",
      WORKING_LABEL,
      "--limit",
      "100",
      "--json",
      "number,title,url,labels",
    ],
    { timeoutMs: GITHUB_STATUS_TIMEOUT_MS },
  );
  if (!result.ok) {
    return {
      state: "unavailable",
      repo,
      workingIssues: [],
      warning: result.stderr.trim() || `gh exited ${result.code}`,
    };
  }
  try {
    const raw = JSON.parse(result.stdout.trim() || "[]") as RawGithubIssue[];
    const workingIssues = raw
      .filter(
        (issue) =>
          typeof issue.number === "number" &&
          typeof issue.title === "string" &&
          typeof issue.url === "string",
      )
      .map((issue) => ({
        number: issue.number as number,
        title: issue.title as string,
        url: issue.url as string,
        labels: (issue.labels ?? [])
          .map((label) => label.name)
          .filter((name): name is string => typeof name === "string"),
        issueCommand: `gh issue view ${issue.number as number} --repo ${repo} --comments`,
        prSearchCommand: `gh pr list --repo ${repo} --state all --search "${issue.number as number}"`,
      }))
      .sort((a, b) => a.number - b.number);
    return { state: "ok", repo, workingIssues, warning: null };
  } catch {
    return { state: "unavailable", repo, workingIssues: [], warning: "gh returned unparseable JSON" };
  }
}

export async function statusSnapshotWithGithub(
  stateDir: string,
  repo: string | null,
  exec: ExecFn = run,
): Promise<StatusJson> {
  const snapshot = readOnlyStateSnapshot(stateDir);
  const run = activeStatusRun(snapshot.state.runs);
  const inferredRepo = repo ?? inferRepoFromRuns(snapshot.state.runs);
  const github =
    inferredRepo === null ? NO_GITHUB : await readGithubWorkingIssues(inferredRepo, exec);
  return {
    version: STATUS_JSON_VERSION,
    service: snapshot.liveness,
    stateSource: snapshot.source,
    current: run ? runSummary(run) : null,
    github,
  };
}

function formatIso(ms: number | null): string {
  return ms === null ? "n/a" : new Date(ms).toISOString();
}

function formatDuration(ms: number | null): string {
  if (ms === null) return "n/a";
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

export function renderStatusHuman(snapshot: StatusJson): string {
  if (!snapshot.current) {
    if (snapshot.github.state === "ok" && snapshot.github.workingIssues.length > 0) {
      const lines = [
        "attention:",
        `  service: ${snapshot.service.state}`,
        "  state: no durable claiming run, but GitHub has agent-working",
      ];
      for (const issue of snapshot.github.workingIssues) {
        lines.push(`  issue: #${issue.number} ${issue.title}`);
        lines.push(`  inspect: ${issue.issueCommand}`);
        lines.push(`  pr-search: ${issue.prSearchCommand}`);
      }
      return lines.join("\n");
    }
    const base = snapshot.service.state === "online" ? "idle" : "offline";
    if (snapshot.github.state === "unavailable") {
      return `${base}\n  github: unavailable for ${snapshot.github.repo}: ${snapshot.github.warning}`;
    }
    return base;
  }
  const run = snapshot.current;
  const lines = [
    "active:",
    `  service: ${snapshot.service.state}`,
    `  phase: ${run.phase}`,
    `  status: ${run.status}`,
    `  issue: #${run.issue.number} ${run.issue.title}`,
    `  agent: ${run.agent} (${run.cliModel}, effort ${run.cliEffort})`,
    `  branch: ${run.branch}`,
  ];
  if (run.pr) lines.push(`  pr: #${run.pr.number} ${run.pr.url ?? ""}`.trimEnd());
  if (run.lastCommit) lines.push(`  commit: ${run.lastCommit}`);
  if (run.failureSummary) lines.push(`  summary: ${run.failureSummary}`);
  if (run.ghCommand) lines.push(`  inspect: ${run.ghCommand}`);
  if (snapshot.github.state === "unavailable") {
    lines.push(`  github: unavailable for ${snapshot.github.repo}: ${snapshot.github.warning}`);
  } else if (snapshot.github.state === "ok") {
    const currentHasWorkingLabel = snapshot.github.workingIssues.some(
      (issue) => issue.number === run.issue.number,
    );
    if (!currentHasWorkingLabel) lines.push(`  github: ${WORKING_LABEL} label is absent on current issue`);
    const extras = snapshot.github.workingIssues.filter((issue) => issue.number !== run.issue.number);
    for (const issue of extras) {
      lines.push(`  github-extra: #${issue.number} ${issue.title}`);
      lines.push(`  github-extra-inspect: ${issue.issueCommand}`);
    }
  }
  return lines.join("\n");
}

export function historySnapshot(stateDir: string, limit: number): HistoryJson {
  const snapshot = readOnlyStateSnapshot(stateDir);
  return { version: STATUS_JSON_VERSION, runs: recentNonIdleRunSummaries(snapshot.state.runs, limit) };
}

export function renderHistoryHuman(history: HistoryJson): string {
  if (history.runs.length === 0) return "no runs";
  return history.runs
    .map((run) => {
      const parts = [
        `#${run.issue.number}`,
        run.status,
        run.agent,
        run.cliModel,
        `started ${formatIso(run.timestamps.startedAt)}`,
        `duration ${formatDuration(run.timestamps.durationMs)}`,
      ];
      if (run.pr) parts.push(`PR #${run.pr.number}`);
      if (run.lastCommit) parts.push(`commit ${run.lastCommit}`);
      if (run.exhaustion) parts.push(`exhausted ${run.exhaustion.kind}`);
      if (run.failureSummary) parts.push(run.failureSummary);
      return parts.join(" | ");
    })
    .join("\n");
}

function renderFollowHuman(entry: RunOutputEntry): string {
  if (entry.type === "output") return entry.line;
  if (entry.type === "phase") return `[phase:${entry.phase}] ${entry.message}`;
  return `[${entry.status}] ${entry.message ?? ""}`.trimEnd();
}

function isFollowTerminal(status: DispatcherStatus): boolean {
  return (
    (PARKED_STATUSES as readonly string[]).includes(status) ||
    (PR_READY_STATUSES as readonly string[]).includes(status) ||
    (HELD_STATUSES as readonly string[]).includes(status) ||
    status === "shipped" ||
    status === "failed" ||
    status === "timed_out" ||
    status === "interrupted" ||
    status === "abandoned" ||
    status === "token_exhausted"
  );
}

async function followRun(
  stateDir: string,
  runId: string,
  json: boolean,
  out: (s: string) => void,
): Promise<void> {
  let seq = 0;
  for (;;) {
    for (const entry of readRunOutputEntries(stateDir, runId, seq)) {
      seq = Math.max(seq, entry.seq);
      if (json) out(`${JSON.stringify({ version: STATUS_JSON_VERSION, event: entry })}\n`);
      else out(`${renderFollowHuman(entry)}\n`);
    }
    const snapshot = readOnlyStateSnapshot(stateDir);
    const run = snapshot.state.runs.find((candidate) => candidate.id === runId);
    if (!run || isFollowTerminal(run.status)) {
      for (const entry of readRunOutputEntries(stateDir, runId, seq)) {
        seq = Math.max(seq, entry.seq);
        if (json) out(`${JSON.stringify({ version: STATUS_JSON_VERSION, event: entry })}\n`);
        else out(`${renderFollowHuman(entry)}\n`);
      }
      return;
    }
    await sleep(FOLLOW_POLL_MS);
  }
}

export async function runStatusCommand(
  argv: string[],
  env: NodeJS.ProcessEnv,
  out: (s: string) => void,
  err: (s: string) => void,
): Promise<number> {
  const parsed = parseStatusArgs(argv, env);
  if (!parsed.ok) {
    err(`${parsed.message}\n`);
    return 2;
  }
  try {
    const snapshot = parsed.github
      ? await statusSnapshotWithGithub(parsed.stateDir, parsed.repo)
      : {
          ...statusSnapshot(parsed.stateDir),
          github: { state: "skipped", repo: parsed.repo, workingIssues: [], warning: null } as GithubStatusEvidence,
        };
    if (parsed.json && !parsed.follow) out(`${JSON.stringify(snapshot)}\n`);
    else if (!parsed.follow) out(`${renderStatusHuman(snapshot)}\n`);
    if (parsed.follow && snapshot.current) {
      if (!parsed.json) out(`${renderStatusHuman(snapshot)}\n`);
      await followRun(parsed.stateDir, snapshot.current.id, parsed.json, out);
    } else if (parsed.follow && parsed.json) {
      out(`${JSON.stringify({ version: STATUS_JSON_VERSION, event: { type: "status", status: snapshot } })}\n`);
    } else if (parsed.follow) {
      out(`${renderStatusHuman(snapshot)}\n`);
    }
    return 0;
  } catch (error) {
    const message =
      error instanceof StateCorruptionError
        ? "dispatcher state and backup are unreadable"
        : error instanceof Error
          ? error.message
          : String(error);
    err(`${message}\n`);
    return 1;
  }
}

export function runHistoryCommand(
  argv: string[],
  env: NodeJS.ProcessEnv,
  out: (s: string) => void,
  err: (s: string) => void,
): number {
  const parsed = parseHistoryArgs(argv, env);
  if (!parsed.ok) {
    err(`${parsed.message}\n`);
    return 2;
  }
  try {
    const history = historySnapshot(parsed.stateDir, parsed.limit);
    out(`${parsed.json ? JSON.stringify(history) : renderHistoryHuman(history)}\n`);
    return 0;
  } catch (error) {
    const message =
      error instanceof StateCorruptionError
        ? "dispatcher state and backup are unreadable"
        : error instanceof Error
          ? error.message
          : String(error);
    err(`${message}\n`);
    return 1;
  }
}
