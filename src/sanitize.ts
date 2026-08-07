/**
 * Output sanitization + rendering.
 *
 * Everything an agent process prints passes through here before it is logged:
 *   1. redact() — strip anything that looks like a credential, because an agent can
 *      `cat` a file or echo an env var.
 *   2. toTerminalLines() — both providers stream structured JSON; render their events
 *      back into readable lines while retaining event provenance for capacity detection.
 *   3. parseControlLine() — recognize the runner's out-of-band ::pid/event/result:: lines.
 */

/** Env vars whose *values* must never appear in output, matched by name. */
const SECRET_KEY_PATTERN = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|DATABASE_URL)/i;
const MIN_SECRET_LENGTH = 8;

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/gh[pousr]_[A-Za-z0-9]{16,}/g, "[REDACTED:github-token]"],
  [/github_pat_[A-Za-z0-9_]{20,}/g, "[REDACTED:github-token]"],
  [/sk-ant-[A-Za-z0-9_-]{20,}/g, "[REDACTED:anthropic-key]"],
  [/sk-[A-Za-z0-9]{20,}/g, "[REDACTED:api-key]"],
  [/(?:AKIA|ASIA)[A-Z0-9]{16}/g, "[REDACTED:aws-key]"],
  [/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi, "[REDACTED:auth-header]"],
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[REDACTED:jwt]"],
  [/(postgres(?:ql)?:\/\/[^:\s]+:)[^@\s]+(@)/gi, "$1[REDACTED]$2"],
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const ENV_SECRETS: Array<[RegExp, string]> = Object.entries(process.env)
  .filter(
    ([key, value]) =>
      SECRET_KEY_PATTERN.test(key) && typeof value === "string" && value.length >= MIN_SECRET_LENGTH,
  )
  .map(([key, value]) => [new RegExp(escapeRegExp(value as string), "g"), `[REDACTED:${key}]`]);

/** Removes credentials from a chunk of agent output. */
export function redact(text: string): string {
  let out = text;
  for (const [pattern, replacement] of ENV_SECRETS) out = out.replace(pattern, replacement);
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

function summarizeToolInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const record = input as Record<string, unknown>;
  for (const field of ["command", "file_path", "pattern", "path", "prompt", "description"]) {
    const value = record[field];
    if (typeof value === "string" && value.trim()) return value.replace(/\s+/g, " ").slice(0, 160);
  }
  return "";
}

const MAX_RESULT_PREVIEW = 200;

function toolResultPreview(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
          ? (part as { text: string }).text
          : "",
      )
      .join(" ");
  }
  return "";
}

/** Renders one line of raw agent stdout into zero or more terminal lines. */
export function toTerminalLines(line: string, agent: "codex" | "claude" | "opencode"): string[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return [line];

  let event: Record<string, unknown>;
  try {
    event = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return [line];
  }

  if (agent === "codex") return renderCodexEvent(event);
  // OpenCode and Claude both use Claude-like JSON format
  return renderClaudeEvent(event);
}

function nestedMessage(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  return typeof record["message"] === "string" ? record["message"] : "";
}

function renderClaudeEvent(event: Record<string, unknown>): string[] {
  switch (event["type"]) {
    case "system": {
      if (event["subtype"] !== "init") return [];
      return [`● session started (model ${String(event["model"] ?? "unknown")})`];
    }
    case "assistant": {
      const message = event["message"] as { content?: unknown[] } | undefined;
      const blocks = Array.isArray(message?.content) ? message.content : [];
      const lines: string[] = [];
      for (const block of blocks) {
        const b = block as Record<string, unknown>;
        if (b["type"] === "text" && typeof b["text"] === "string" && b["text"].trim()) {
          lines.push(b["text"]);
        } else if (b["type"] === "tool_use") {
          const summary = summarizeToolInput(b["input"]);
          lines.push(`● ${String(b["name"] ?? "tool")}${summary ? `: ${summary}` : ""}`);
        }
      }
      return lines;
    }
    case "user": {
      const message = event["message"] as { content?: unknown[] } | undefined;
      const blocks = Array.isArray(message?.content) ? message.content : [];
      const lines: string[] = [];
      for (const block of blocks) {
        const b = block as Record<string, unknown>;
        if (b["type"] !== "tool_result") continue;
        const preview = toolResultPreview(b["content"]).replace(/\s+/g, " ").trim();
        if (!preview) continue;
        const truncated =
          preview.length > MAX_RESULT_PREVIEW ? `${preview.slice(0, MAX_RESULT_PREVIEW)}…` : preview;
        lines.push(`  ⤷ ${truncated}`);
      }
      return lines;
    }
    case "result": {
      const ok = event["subtype"] === "success";
      const seconds = Math.round(Number(event["duration_ms"] ?? 0) / 1000);
      const turns = event["num_turns"] ?? "?";
      return [`● ${ok ? "completed" : `ended (${String(event["subtype"])})`} — ${seconds}s, ${String(turns)} turns`];
    }
    default:
      return [];
  }
}

function renderCodexEvent(event: Record<string, unknown>): string[] {
  const type = String(event["type"] ?? "");
  if (type === "thread.started") {
    return [`● session started (${String(event["thread_id"] ?? "unknown")})`];
  }
  if (type === "turn.started" || type === "item.started") return [];
  if (type === "turn.completed") {
    const usage =
      event["usage"] && typeof event["usage"] === "object"
        ? (event["usage"] as Record<string, unknown>)
        : null;
    const input = usage?.["input_tokens"];
    const output = usage?.["output_tokens"];
    return [
      `● completed${typeof input === "number" && typeof output === "number" ? ` — ${input} input, ${output} output tokens` : ""}`,
    ];
  }
  if (type === "turn.failed" || type === "error") {
    const message =
      nestedMessage(event["error"]) ||
      nestedMessage(event["message"]) ||
      "provider reported an unspecified error";
    return [`● failed: ${message}`];
  }
  if (type !== "item.completed") return [];

  const item =
    event["item"] && typeof event["item"] === "object"
      ? (event["item"] as Record<string, unknown>)
      : null;
  if (!item) return [];

  switch (item["type"]) {
    case "agent_message":
    case "reasoning": {
      return typeof item["text"] === "string" && item["text"].trim() ? [item["text"]] : [];
    }
    case "command_execution": {
      const command = typeof item["command"] === "string" ? item["command"] : "command";
      const status = typeof item["status"] === "string" ? ` (${item["status"]})` : "";
      const lines = [`● exec${status}: ${command}`];
      if (typeof item["aggregated_output"] === "string") {
        lines.push(...item["aggregated_output"].split(/\r?\n/).filter(Boolean));
      }
      return lines;
    }
    case "file_change":
      return [`● file change${typeof item["status"] === "string" ? ` (${item["status"]})` : ""}`];
    case "mcp_tool_call": {
      const server = typeof item["server"] === "string" ? `${item["server"]}.` : "";
      const tool = typeof item["tool"] === "string" ? item["tool"] : "tool";
      return [`● MCP: ${server}${tool}`];
    }
    case "web_search":
      return [`● web search: ${String(item["query"] ?? "")}`.trim()];
    case "plan_update":
      return ["● plan updated"];
    default:
      return [];
  }
}

/** The real CI verdict on the run's PR, as observed by the runner — not self-reported. */
export type CiState = "pass" | "fail" | "pending" | "none";

const CI_STATES: CiState[] = ["pass", "fail", "pending", "none"];

export interface ControlResult {
  exit: number;
  pr: string;
  commit: string;
  plan: string;
  commits: number;
  ci: CiState;
  disposition: "normal" | "abandoned" | "already-satisfied";
}

export interface ParsedControlLine {
  kind: "pid" | "event" | "result";
  pid?: number;
  message?: string;
  result?: ControlResult;
}

/** Recognizes the runner's out-of-band control lines. Returns null for ordinary output. */
export function parseControlLine(line: string): ParsedControlLine | null {
  if (line.startsWith("::pid:: ")) {
    const pid = Number.parseInt(line.slice("::pid:: ".length).trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? { kind: "pid", pid } : null;
  }

  if (line.startsWith("::event:: ")) {
    const rest = line.slice("::event:: ".length).trim();
    const spaceIndex = rest.indexOf(" ");
    return { kind: "event", message: spaceIndex === -1 ? rest : rest.slice(spaceIndex + 1) };
  }

  if (line.startsWith("::result:: ")) {
    const fields = new Map<string, string>();
    for (const token of line.slice("::result:: ".length).trim().split(/\s+/)) {
      const eq = token.indexOf("=");
      if (eq > 0) fields.set(token.slice(0, eq), token.slice(eq + 1));
    }
    return {
      kind: "result",
      result: {
        exit: Number.parseInt(fields.get("exit") ?? "1", 10),
        pr: fields.get("pr") ?? "",
        commit: fields.get("commit") ?? "",
        plan: fields.get("plan") ?? "",
        commits: Number.parseInt(fields.get("commits") ?? "0", 10),
        ci: (CI_STATES as string[]).includes(fields.get("ci") ?? "")
          ? (fields.get("ci") as CiState)
          : "none",
        disposition:
          fields.get("disposition") === "abandoned"
            ? "abandoned"
            : fields.get("disposition") === "already-satisfied"
              ? "already-satisfied"
              : "normal",
      },
    };
  }

  return null;
}
