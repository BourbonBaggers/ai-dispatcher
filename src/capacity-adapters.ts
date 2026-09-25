/**
 * Bounded live-capacity readers for the two subscription-backed CLIs.
 *
 * Raw provider responses and credentials never leave this module. Callers receive only
 * normalized percentages, reset epochs, and sanitized failure messages.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CapacityWindow, LiveCapacitySnapshot } from "./capacity.ts";

const ADAPTER_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function finitePercent(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : null;
}

function resetEpoch(value: unknown): number | null {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return value > 9_999_999_999 ? value : value * 1000;
}

function windowFrom(
  name: string,
  value: unknown,
  usedKey: "utilization" | "usedPercent",
  resetKey: "resets_at" | "resetsAt",
  modelLabels?: readonly string[],
): CapacityWindow | null {
  const raw = object(value);
  if (!raw) return null;
  const usedPercent = finitePercent(raw[usedKey]);
  if (usedPercent === null) return null;
  return {
    name,
    usedPercent,
    resetAt: resetEpoch(raw[resetKey]),
    ...(modelLabels ? { modelLabels } : {}),
  };
}

/** Pure parser for Anthropic's OAuth usage response. */
export function parseClaudeUsage(raw: unknown, observedAt: number): LiveCapacitySnapshot | null {
  const value = object(raw);
  if (!value) return null;
  const windows = [
    windowFrom("five-hour", value.five_hour, "utilization", "resets_at"),
    windowFrom("seven-day", value.seven_day, "utilization", "resets_at"),
    windowFrom(
      "seven-day-sonnet",
      value.seven_day_sonnet,
      "utilization",
      "resets_at",
      ["model:claude-sonnet-5"],
    ),
    windowFrom(
      "seven-day-opus",
      value.seven_day_opus,
      "utilization",
      "resets_at",
      ["model:claude-opus-5-5", "model:claude-opus-5", "model:claude-opus-4.8"],
    ),
  ].filter((window): window is CapacityWindow => window !== null);
  if (windows.length === 0) return null;
  return {
    pool: "claude-subscription",
    confidence: "provider-reported",
    observedAt,
    windows,
    reason: `Anthropic reported ${windows.length} active usage window(s)`,
  };
}

function codexSnapshot(raw: JsonObject): JsonObject | null {
  const byId = object(raw.rateLimitsByLimitId);
  if (byId) {
    const direct = object(byId.codex);
    if (direct) return direct;
    for (const [key, candidate] of Object.entries(byId)) {
      const value = object(candidate);
      if (!value) continue;
      const description = `${key} ${String(value.limitId ?? "")} ${String(value.limitName ?? "")}`.toLowerCase();
      if (description.includes("codex")) return value;
    }
    for (const candidate of Object.values(byId)) {
      const value = object(candidate);
      if (value) return value;
    }
  }
  return object(raw.rateLimits);
}

/** Pure parser for `account/rateLimits/read`. */
export function parseCodexRateLimits(
  raw: unknown,
  observedAt: number,
): LiveCapacitySnapshot | null {
  const root = object(raw);
  const snapshot = root ? codexSnapshot(root) : null;
  if (!snapshot) return null;
  const windows = [
    windowFrom("five-hour", snapshot.primary, "usedPercent", "resetsAt"),
    windowFrom("seven-day", snapshot.secondary, "usedPercent", "resetsAt"),
  ].filter((window): window is CapacityWindow => window !== null);
  if (windows.length === 0) return null;
  return {
    pool: "codex-subscription",
    confidence: "cli-reported",
    observedAt,
    windows,
    reason: `Codex reported ${windows.length} active rate-limit window(s)`,
  };
}

async function boundedText(response: Response): Promise<string> {
  const length = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
    throw new Error("provider response exceeded the size limit");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    bytes += next.value.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("provider response exceeded the size limit");
    }
    text += decoder.decode(next.value, { stream: true });
  }
  return text + decoder.decode();
}

function claudeCredentialPath(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  return join(configDir, ".credentials.json");
}

/** Reads one simple shell assignment as data; it never evaluates the credentials file. */
export function parseClaudeTokenFromEnvFile(contents: string): string | null {
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(
      /^\s*(?:export\s+)?CLAUDE_CODE_OAUTH_TOKEN\s*=\s*(.*?)\s*$/,
    );
    if (!match) continue;
    let value = match[1]!;
    if (
      value.length >= 2 &&
      ((value.startsWith("\"") && value.endsWith("\"")) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    // Shell expressions are deliberately unsupported: credentials remain inert data.
    if (!value || value.includes("$") || value.includes("`")) return null;
    return value;
  }
  return null;
}

function claudeToken(): string | null {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return process.env.CLAUDE_CODE_OAUTH_TOKEN;
  try {
    const credentials = object(JSON.parse(readFileSync(claudeCredentialPath(), "utf8")));
    const oauth = object(credentials?.claudeAiOauth);
    if (typeof oauth?.accessToken === "string" && oauth.accessToken) {
      return oauth.accessToken;
    }
  } catch {
    // The long-lived dispatcher host uses the launcher credential file instead.
  }
  try {
    return parseClaudeTokenFromEnvFile(
      readFileSync(join(homedir(), ".dispatcher", "env"), "utf8"),
    );
  } catch {
    return null;
  }
}

export async function readClaudeCapacity(
  nowMs = Date.now(),
  fetchFn: typeof fetch = fetch,
): Promise<LiveCapacitySnapshot> {
  const token = claudeToken();
  if (!token) throw new Error("Claude OAuth credentials are unavailable");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ADAPTER_TIMEOUT_MS);
  try {
    const response = await fetchFn("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Claude usage endpoint returned HTTP ${response.status}`);
    const parsed = JSON.parse(await boundedText(response)) as unknown;
    const snapshot = parseClaudeUsage(parsed, nowMs);
    if (!snapshot) throw new Error("Claude usage response had no valid windows");
    return snapshot;
  } catch (error) {
    if ((error as Error).name === "AbortError") throw new Error("Claude usage read timed out");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

type SpawnAppServer = () => ChildProcessWithoutNullStreams;

function defaultSpawnAppServer(): ChildProcessWithoutNullStreams {
  return spawn("codex", ["app-server", "--listen", "stdio://"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
}

export function readCodexCapacity(
  nowMs = Date.now(),
  spawnAppServer: SpawnAppServer = defaultSpawnAppServer,
): Promise<LiveCapacitySnapshot> {
  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnAppServer();
    } catch {
      reject(new Error("Codex app-server could not start"));
      return;
    }
    let settled = false;
    let stdout = "";

    const finish = (error: Error | null, value?: LiveCapacitySnapshot): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      // A broken app-server must not survive a capacity probe and accumulate every poll.
      const forceKill = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 250);
      forceKill.unref();
      if (error) reject(error);
      else resolve(value!);
    };

    child.on("error", () => finish(new Error("Codex app-server could not start")));
    child.on("exit", () => {
      if (!settled) finish(new Error("Codex app-server exited before reporting rate limits"));
    });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (Buffer.byteLength(stdout, "utf8") > MAX_RESPONSE_BYTES) {
        finish(new Error("Codex app-server response exceeded the size limit"));
        return;
      }
      for (;;) {
        const newline = stdout.indexOf("\n");
        if (newline < 0) break;
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        if (!line) continue;
        let message: JsonObject | null = null;
        try {
          message = object(JSON.parse(line));
        } catch {
          continue;
        }
        if (message?.id !== 2) continue;
        if (message.error) {
          finish(new Error("Codex app-server rejected the rate-limit request"));
          return;
        }
        const snapshot = parseCodexRateLimits(message.result, nowMs);
        finish(
          snapshot ? null : new Error("Codex rate-limit response had no valid windows"),
          snapshot ?? undefined,
        );
        return;
      }
    });
    child.stdin.on("error", () => undefined);
    // Never let diagnostics fill the pipe and deadlock the bounded request.
    child.stderr.resume();

    const timer = setTimeout(
      () => finish(new Error("Codex app-server rate-limit read timed out")),
      ADAPTER_TIMEOUT_MS,
    );
    const send = (message: JsonObject): void => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "ai-dispatcher", version: "1" },
        capabilities: { experimentalApi: true },
      },
    });
    send({ jsonrpc: "2.0", method: "initialized", params: {} });
    send({
      jsonrpc: "2.0",
      id: 2,
      method: "account/rateLimits/read",
      params: null,
    });
  });
}

export interface CapacityReadResult {
  snapshots: Map<string, LiveCapacitySnapshot>;
  errors: Map<string, string>;
}

/** Reads both independent pools concurrently; one failure never hides the other. */
export async function readLiveCapacity(nowMs = Date.now()): Promise<CapacityReadResult> {
  const [claude, codex] = await Promise.allSettled([
    readClaudeCapacity(nowMs),
    readCodexCapacity(nowMs),
  ]);
  const snapshots = new Map<string, LiveCapacitySnapshot>();
  const errors = new Map<string, string>();
  if (claude.status === "fulfilled") snapshots.set(claude.value.pool, claude.value);
  else errors.set("claude-subscription", claude.reason instanceof Error ? claude.reason.message : "Claude capacity read failed");
  if (codex.status === "fulfilled") snapshots.set(codex.value.pool, codex.value);
  else errors.set("codex-subscription", codex.reason instanceof Error ? codex.reason.message : "Codex capacity read failed");
  return { snapshots, errors };
}
