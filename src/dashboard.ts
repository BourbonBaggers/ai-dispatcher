import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { run, type ExecFn } from "./exec.ts";
import { readRunOutputEntries, type RunOutputEntry } from "./run-output.ts";
import { readOnlyStateSnapshot } from "./state.ts";
import { recentNonIdleRunSummaries, statusSnapshotWithGithub, type RunSummary, type StatusJson } from "./status.ts";

const DASHBOARD_VERSION = 1;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8787;
const STATUS_REFRESH_MS = 15_000;
const STREAM_POLL_MS = 1_000;
const RECENT_RUN_LIMIT = 5;
// A run can already have thousands of recorded lines by the time a browser tab opens
// the accordion. Replaying all of them in one synchronous burst is what freezes the
// page (thousands of DOM appends + forced reflows back to back), so a fresh stream
// attachment only replays the most recent slice; `seq` still advances past the
// omitted entries so later polls only ever send new output.
const STREAM_REPLAY_LIMIT = 200;

type DashboardArgs =
  | { ok: true; host: string; port: number; units: string[]; help: false }
  | { ok: true; host: string; port: number; units: string[]; help: true; message: string }
  | { ok: false; message: string };

export interface DispatcherInstance {
  unit: string;
  description: string;
  repo: string;
  stateDir: string;
  intervalSeconds: number;
  workingDirectory: string | null;
  environmentFile: string | null;
  path: string | null;
}

export interface RecentScan {
  at: number;
  started: string | null;
  message: string;
}

export interface DashboardInstanceStatus {
  unit: string;
  description: string;
  repo: string;
  stateDir: string;
  intervalSeconds: number;
  systemd: {
    activeState: string;
    subState: string;
    mainPid: number | null;
  };
  status: StatusJson;
  recentRuns: RunSummary[];
  recentScan: RecentScan | null;
  nextRunAt: number | null;
  kind: "active" | "attention" | "idle" | "offline";
  warning: string | null;
}

export interface DashboardPayload {
  version: 1;
  updatedAt: number;
  refreshMs: number;
  instances: DashboardInstanceStatus[];
}

export const DASHBOARD_USAGE = `ai-dispatcher dashboard — serve the local dispatcher status dashboard.

Usage:
  ai-dispatcher dashboard [--host <host>] [--port <port>] [--unit <systemd-unit>...]

Options:
  --host <host>             Bind host (default: ${DEFAULT_HOST}).
  --port <port>             Bind port (default: ${DEFAULT_PORT}).
  --unit <systemd-unit>     User systemd unit to show. Repeat to select several.
                            Default: discover ai-dispatcher*.service user units.
  --help                    Show this message.
`;

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_PORT;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : DEFAULT_PORT;
}

export function parseDashboardArgs(argv: string[]): DashboardArgs {
  try {
    const parsed = parseArgs({
      args: argv,
      allowPositionals: false,
      options: {
        host: { type: "string" },
        port: { type: "string" },
        unit: { type: "string", multiple: true },
        help: { type: "boolean", default: false },
      },
    });
    if (parsed.values.help) {
      return { ok: true, host: DEFAULT_HOST, port: DEFAULT_PORT, units: [], help: true, message: DASHBOARD_USAGE };
    }
    return {
      ok: true,
      host: (parsed.values.host as string | undefined) ?? DEFAULT_HOST,
      port: parsePort(parsed.values.port as string | undefined),
      units: (parsed.values.unit as string[] | undefined) ?? [],
      help: false,
    };
  } catch (err) {
    return { ok: false, message: `${(err as Error).message}\n\n${DASHBOARD_USAGE}` };
  }
}

function expandSystemdPath(raw: string): string {
  return raw.replaceAll("%h", homedir());
}

function unquoteSystemdValue(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function parseEnvironmentFile(raw: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
    if (!match) continue;
    env[match[1]!] = unquoteSystemdValue(match[2]!);
  }
  return env;
}

export function parseSystemdCat(unit: string, raw: string): Partial<DispatcherInstance> & { environment?: Record<string, string> } {
  const parsed: Partial<DispatcherInstance> & { environment?: Record<string, string> } = { unit };
  const environment: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("Description=")) {
      parsed.description = line.slice("Description=".length).trim();
    } else if (line.startsWith("WorkingDirectory=")) {
      parsed.workingDirectory = expandSystemdPath(line.slice("WorkingDirectory=".length).trim());
    } else if (line.startsWith("EnvironmentFile=")) {
      parsed.environmentFile = expandSystemdPath(line.slice("EnvironmentFile=".length).trim());
    } else if (line.startsWith("Environment=")) {
      const assignment = line.slice("Environment=".length);
      const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(assignment);
      if (match) environment[match[1]!] = unquoteSystemdValue(expandSystemdPath(match[2]!));
    } else if (line.startsWith("ExecStart=")) {
      const execStart = expandSystemdPath(line.slice("ExecStart=".length));
      const repo = /(?:^|\s)--repo\s+(\S+)/.exec(execStart)?.[1];
      const interval = /(?:^|\s)--interval\s+(\d+)/.exec(execStart)?.[1];
      if (repo) parsed.repo = repo;
      if (interval) parsed.intervalSeconds = Number.parseInt(interval, 10);
    }
  }
  if (Object.keys(environment).length > 0) parsed.environment = environment;
  return parsed;
}

export function computeNextRunAt(
  status: StatusJson,
  recentScan: RecentScan | null,
  intervalSeconds: number,
  now = Date.now(),
): number | null {
  const githubWorking =
    status.github.state === "ok" && status.github.workingIssues.length > 0;
  const idle = status.service.state === "online" && status.current === null && !githubWorking;
  if (!idle || recentScan === null) return null;
  return Math.max(now, recentScan.at + intervalSeconds * 1000);
}

export function classifyDashboardStatus(status: StatusJson): DashboardInstanceStatus["kind"] {
  if (status.current !== null) return "active";
  if (status.github.state === "ok" && status.github.workingIssues.length > 0) return "attention";
  return status.service.state === "online" ? "idle" : "offline";
}

async function discoverUnitNames(exec: ExecFn, explicit: string[]): Promise<string[]> {
  if (explicit.length > 0) return explicit;
  const result = await exec("systemctl", [
    "--user",
    "list-units",
    "--type=service",
    "--all",
    "--no-legend",
    "--plain",
    "ai-dispatcher*.service",
  ]);
  if (!result.ok) return ["ai-dispatcher.service", "ai-dispatcher-self.service"];
  const units = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/)[0])
    .filter((unit): unit is string => Boolean(unit?.startsWith("ai-dispatcher") && unit.endsWith(".service")));
  return units.length > 0 ? units : ["ai-dispatcher.service", "ai-dispatcher-self.service"];
}

async function readInstance(unit: string, exec: ExecFn): Promise<DispatcherInstance | null> {
  const cat = await exec("systemctl", ["--user", "cat", unit]);
  if (!cat.ok) return null;
  const fromUnit = parseSystemdCat(unit, cat.stdout);
  let fileEnv: Record<string, string> = {};
  if (fromUnit.environmentFile) {
    try {
      fileEnv = parseEnvironmentFile(readFileSync(fromUnit.environmentFile, "utf8"));
    } catch {
      fileEnv = {};
    }
  }
  const repo = fileEnv.DISPATCHER_REPO ?? fromUnit.repo;
  const stateDir = fileEnv.DISPATCHER_STATE_DIR;
  if (!repo || !stateDir) return null;
  const intervalSeconds = Number.parseInt(
    fileEnv.DISPATCHER_POLL_INTERVAL_SECONDS ?? String(fromUnit.intervalSeconds ?? 900),
    10,
  );
  return {
    unit,
    description: fromUnit.description ?? unit,
    repo,
    stateDir,
    intervalSeconds: Number.isInteger(intervalSeconds) && intervalSeconds > 0 ? intervalSeconds : 900,
    workingDirectory: fromUnit.workingDirectory ?? null,
    environmentFile: fromUnit.environmentFile ?? null,
    path: fromUnit.environment?.PATH ?? null,
  };
}

async function discoverInstances(exec: ExecFn, explicitUnits: string[]): Promise<DispatcherInstance[]> {
  const units = await discoverUnitNames(exec, explicitUnits);
  const instances = await Promise.all(units.map((unit) => readInstance(unit, exec)));
  return instances.filter((instance): instance is DispatcherInstance => instance !== null);
}

async function readSystemdStatus(unit: string, exec: ExecFn): Promise<DashboardInstanceStatus["systemd"]> {
  const result = await exec("systemctl", [
    "--user",
    "show",
    unit,
    "-p",
    "ActiveState",
    "-p",
    "SubState",
    "-p",
    "MainPID",
  ]);
  const fallback = { activeState: "unknown", subState: "unknown", mainPid: null };
  if (!result.ok) return fallback;
  const fields = new Map<string, string>();
  for (const line of result.stdout.split(/\r?\n/)) {
    const idx = line.indexOf("=");
    if (idx > 0) fields.set(line.slice(0, idx), line.slice(idx + 1));
  }
  const pid = Number.parseInt(fields.get("MainPID") ?? "", 10);
  return {
    activeState: fields.get("ActiveState") ?? "unknown",
    subState: fields.get("SubState") ?? "unknown",
    mainPid: Number.isInteger(pid) && pid > 0 ? pid : null,
  };
}

function parseRecentScan(raw: string): RecentScan | null {
  let latest: RecentScan | null = null;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.includes('"msg":"scan complete"')) continue;
    try {
      const parsed = JSON.parse(line) as { msg?: unknown; ts?: unknown; started?: unknown; message?: unknown };
      if (parsed.msg !== "scan complete" || typeof parsed.ts !== "string") continue;
      const at = Date.parse(parsed.ts);
      if (!Number.isFinite(at)) continue;
      latest = {
        at,
        started: typeof parsed.started === "string" ? parsed.started : null,
        message: typeof parsed.message === "string" ? parsed.message : "",
      };
    } catch {
      // Journal lines can include non-JSON service output; ignore them.
    }
  }
  return latest;
}

async function readRecentScan(unit: string, exec: ExecFn): Promise<RecentScan | null> {
  const result = await exec("journalctl", [
    "--user",
    "-u",
    unit,
    "--since",
    "24 hours ago",
    "--no-pager",
    "-o",
    "cat",
  ], { timeoutMs: 10_000, maxOutputBytes: 1024 * 1024 });
  return result.ok ? parseRecentScan(result.stdout) : null;
}

export function dashboardRecentRuns(stateDir: string): RunSummary[] {
  const snapshot = readOnlyStateSnapshot(stateDir);
  return recentNonIdleRunSummaries(snapshot.state.runs, RECENT_RUN_LIMIT);
}

export async function dashboardPayload(
  explicitUnits: string[] = [],
  exec: ExecFn = run,
): Promise<DashboardPayload> {
  const instances = await discoverInstances(exec, explicitUnits);
  const statuses = await Promise.all(
    instances.map(async (instance): Promise<DashboardInstanceStatus> => {
      const [systemd, status, recentScan] = await Promise.all([
        readSystemdStatus(instance.unit, exec),
        statusSnapshotWithGithub(instance.stateDir, instance.repo, exec),
        readRecentScan(instance.unit, exec),
      ]);
      const recentRuns = dashboardRecentRuns(instance.stateDir);
      return {
        unit: instance.unit,
        description: instance.description,
        repo: instance.repo,
        stateDir: instance.stateDir,
        intervalSeconds: instance.intervalSeconds,
        systemd,
        status,
        recentRuns,
        recentScan,
        nextRunAt: computeNextRunAt(status, recentScan, instance.intervalSeconds),
        kind: classifyDashboardStatus(status),
        warning: status.github.state === "unavailable" ? status.github.warning : null,
      };
    }),
  );
  return {
    version: DASHBOARD_VERSION,
    updatedAt: Date.now(),
    refreshMs: STATUS_REFRESH_MS,
    instances: statuses,
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(`${JSON.stringify(body)}\n`);
}

function sendHtml(res: ServerResponse): void {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(DASHBOARD_HTML);
}

function sseSend(res: ServerResponse, event: string, payload: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export interface ReplayBatch {
  /** Entries to actually emit, oldest first, capped to the replay limit. */
  toSend: RunOutputEntry[];
  /** How many older entries were dropped from this batch. */
  omitted: number;
  /** The seq a caller should resume polling from, even when entries were omitted. */
  nextSeq: number;
}

/** Pure so the "never flood the client, never lose the resume point" rule is unit-tested directly. */
export function capReplayBatch(entries: RunOutputEntry[], limit: number, previousSeq: number): ReplayBatch {
  if (entries.length === 0) return { toSend: [], omitted: 0, nextSeq: previousSeq };
  const omitted = Math.max(0, entries.length - limit);
  const toSend = omitted > 0 ? entries.slice(-limit) : entries;
  const nextSeq = entries[entries.length - 1]!.seq;
  return { toSend, omitted, nextSeq };
}

async function streamInstance(
  unit: string,
  explicitUnits: string[],
  res: ServerResponse,
  exec: ExecFn,
): Promise<void> {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  let stopped = false;
  res.on("close", () => {
    stopped = true;
  });
  let seq = 0;
  let runId: string | null = null;
  while (!stopped) {
    const payload = await dashboardPayload(explicitUnits, exec);
    const instance = payload.instances.find((candidate) => candidate.unit === unit);
    if (!instance) {
      sseSend(res, "error", { message: `unknown dispatcher unit ${unit}` });
      res.end();
      return;
    }
    sseSend(res, "status", instance);
    const currentRun = instance.status.current;
    if (currentRun?.id && currentRun.id !== runId) {
      runId = currentRun.id;
      seq = 0;
    }
    if (runId) {
      const entries = readRunOutputEntries(instance.stateDir, runId, seq);
      const batch = capReplayBatch(entries, STREAM_REPLAY_LIMIT, seq);
      seq = batch.nextSeq;
      if (batch.omitted > 0) {
        sseSend(res, "notice", { message: `${batch.omitted} earlier output line(s) omitted from this stream.` });
      }
      for (const entry of batch.toSend) {
        sseSend(res, "entry", entry);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, STREAM_POLL_MS));
  }
}

export async function runDashboardCommand(
  argv: string[],
  out: (s: string) => void,
  err: (s: string) => void,
  exec: ExecFn = run,
): Promise<number> {
  const parsed = parseDashboardArgs(argv);
  if (!parsed.ok) {
    err(`${parsed.message}\n`);
    return 2;
  }
  if (parsed.help) {
    out(`${parsed.message}\n`);
    return 0;
  }
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      if (url.pathname === "/" || url.pathname === "/compact") return sendHtml(res);
      if (url.pathname === "/api/instances") {
        return sendJson(res, 200, await dashboardPayload(parsed.units, exec));
      }
      if (url.pathname === "/api/stream") {
        const unit = url.searchParams.get("unit");
        if (!unit) return sendJson(res, 400, { error: "unit is required" });
        return await streamInstance(unit, parsed.units, res, exec);
      }
      return sendJson(res, 404, { error: "not found" });
    })().catch((error) => {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });

  await new Promise<void>((resolve) => server.listen(parsed.port, parsed.host, resolve));
  out(`dispatcher dashboard listening on http://${parsed.host}:${parsed.port}/\n`);
  await new Promise<void>((resolve) => {
    const stop = () => {
      server.close(() => resolve());
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return 0;
}

const DASHBOARD_HTML = readFileSync(new URL("../dashboard/dispatcher-status.html", import.meta.url), "utf8");
