/**
 * Provider token-exhaustion detection and cooldown math (ported from #245/#307).
 *
 * Claude and Codex use different output envelopes, but exhaustion has the same
 * lifecycle: preserve the run as resumable, pause only that provider, notify once, let
 * the other provider continue. Detection is restricted to provider-owned error/banner
 * output so issue text an agent echoes cannot manufacture a cooldown.
 *
 * This module is pure. Recording the cooldown + sending the single notification is the
 * dispatcher loop's job (it owns the state store), keeping detection trivially testable.
 */

import type { DispatcherAgent } from "./labels.ts";
import { CENTRAL_TIME_ZONE, getZonedDateTimeParts, zonedTimeToUtc } from "./timezone.ts";

/**
 * Fallback cooldown when exhaustion is detected but no reset time parses. Claude's
 * subscription limits reset on a rolling ~5-hour window.
 */
export const FALLBACK_SUPPRESSION_MS = 5 * 60 * 60 * 1000;

export interface WallClockReset {
  hour: number;
  minute: number;
  timeZone: string;
}

export interface TokenExhaustionSignal {
  /** Absolute reset instant (epoch ms) when directly reported; else null. */
  resetAt: number | null;
  /** Wall-clock reset ("resets 4am (UTC)"), resolved later against `now`. */
  wallClock?: WallClockReset | null;
  /** The reset time verbatim as reported, for the notification (e.g. "4am (UTC)"). */
  resetLabel?: string | null;
}

const EXHAUSTION_PHRASE =
  /usage limit reached|out of (?:tokens|credits)|insufficient (?:tokens|credits|quota)|token (?:limit|budget|quota) (?:reached|exceeded|exhausted)|exhausted your (?:tokens|credits|usage)/i;

const SESSION_LIMIT_BANNER =
  /\b(?:hit|reached|exceeded)\s+your\s+(?:session|usage|weekly|5[-\s]?hour|daily)\s+limit\b/i;

const CANONICAL_LIMIT = /usage limit reached\s*\|\s*(\d{9,13})/i;

const EPOCH_MS_THRESHOLD = 1e12;
const RESET_CLAUSE = /reset[s]?\b\s*(?:at\s+)?(.+)$/i;
const CLOCK_RE = /\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?\b/i;

const TZ_ABBREVIATIONS: Record<string, string> = {
  UTC: "UTC",
  GMT: "UTC",
  Z: "UTC",
  CT: CENTRAL_TIME_ZONE,
  CST: CENTRAL_TIME_ZONE,
  CDT: CENTRAL_TIME_ZONE,
  ET: "America/New_York",
  EST: "America/New_York",
  EDT: "America/New_York",
  PT: "America/Los_Angeles",
  PST: "America/Los_Angeles",
  PDT: "America/Los_Angeles",
  MT: "America/Denver",
  MST: "America/Denver",
  MDT: "America/Denver",
};

function parseEpoch(raw: string): number | null {
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value < EPOCH_MS_THRESHOLD ? value * 1000 : value;
}

function parseTimeZone(label: string): string {
  const paren = label.match(/\(([^)]+)\)/);
  if (paren?.[1]) {
    const value = paren[1].trim();
    if (value.includes("/")) return value;
    const abbr = TZ_ABBREVIATIONS[value.toUpperCase().replace(/[^A-Z]/g, "")];
    if (abbr) return abbr;
  }
  const rest = label.replace(CLOCK_RE, " ");
  const iana = rest.match(/[A-Za-z]+\/[A-Za-z_]+/);
  if (iana) return iana[0];
  const token = rest.match(/\b[A-Za-z]{2,4}\b/);
  if (token) {
    const abbr = TZ_ABBREVIATIONS[token[0].toUpperCase()];
    if (abbr) return abbr;
  }
  return "UTC";
}

function parseWallClock(label: string): WallClockReset | null {
  const clock = label.match(CLOCK_RE);
  if (!clock) return null;
  let hour = Number.parseInt(clock[1]!, 10);
  const minute = clock[2] ? Number.parseInt(clock[2], 10) : 0;
  const meridiem = clock[3]!.toLowerCase();
  if (hour < 1 || hour > 12 || minute > 59) return null;
  if (hour === 12) hour = 0;
  if (meridiem === "p") hour += 12;
  return { hour, minute, timeZone: parseTimeZone(label) };
}

function extractResetLabel(text: string): string | null {
  const clause = text.match(RESET_CLAUSE);
  const label = clause?.[1]?.trim().replace(/[.\s]+$/, "");
  return label ? label : null;
}

function buildSignal(text: string, epoch: number | null): TokenExhaustionSignal {
  if (epoch !== null) return { resetAt: epoch, wallClock: null, resetLabel: null };

  const label = extractResetLabel(text);

  const piped = text.match(/\|\s*(\d{9,13})\b/);
  if (piped?.[1]) {
    const parsed = parseEpoch(piped[1]);
    if (parsed !== null) return { resetAt: parsed, wallClock: null, resetLabel: label };
  }

  const iso = text.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?Z?/);
  if (iso) {
    const ms = Date.parse(iso[0]);
    if (Number.isFinite(ms)) return { resetAt: ms, wallClock: null, resetLabel: label };
  }

  const wallClock = label ? parseWallClock(label) : null;
  return { resetAt: null, wallClock, resetLabel: label };
}

function extractAssistantText(event: Record<string, unknown>): string {
  const message = event["message"] as { content?: unknown[] } | undefined;
  const blocks = Array.isArray(message?.content) ? message.content : [];
  const parts: string[] = [];
  for (const block of blocks) {
    const b = block as Record<string, unknown>;
    if (b["type"] === "text" && typeof b["text"] === "string") parts.push(b["text"]);
  }
  return parts.join(" ");
}

/** Recognizes a Claude token-exhaustion signal in one line of agent output. */
export function detectClaudeTokenExhaustion(
  line: string,
  stream: "stdout" | "stderr",
): TokenExhaustionSignal | null {
  const canonical = line.match(CANONICAL_LIMIT);
  if (canonical?.[1]) return buildSignal(line, parseEpoch(canonical[1]));

  const trimmed = line.trim();

  if (stream === "stdout" && trimmed.startsWith("{")) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return null;
    }

    if (event["type"] === "result" && event["is_error"] === true) {
      const text = [event["result"], event["error"], event["subtype"]]
        .filter((v): v is string => typeof v === "string")
        .join(" ");
      if (EXHAUSTION_PHRASE.test(text) || SESSION_LIMIT_BANNER.test(text)) return buildSignal(text, null);
      return null;
    }

    if (event["type"] === "assistant") {
      const text = extractAssistantText(event);
      if (SESSION_LIMIT_BANNER.test(text)) return buildSignal(text, null);
      return null;
    }

    return null;
  }

  if (stream === "stdout" && SESSION_LIMIT_BANNER.test(line)) return buildSignal(line, null);
  if (stream === "stderr" && (EXHAUSTION_PHRASE.test(line) || SESSION_LIMIT_BANNER.test(line))) {
    return buildSignal(line, null);
  }
  return null;
}

/** Recognizes Codex's provider-owned quota output. */
export function detectCodexTokenExhaustion(
  line: string,
  stream: "stdout" | "stderr",
): TokenExhaustionSignal | null {
  const canonical = line.match(CANONICAL_LIMIT);
  if (canonical?.[1]) return buildSignal(line, parseEpoch(canonical[1]));

  const trimmed = line.trim();
  if (trimmed.startsWith("{")) {
    try {
      const event = JSON.parse(trimmed) as Record<string, unknown>;
      const isError = event["type"] === "error" || event["is_error"] === true;
      if (isError) {
        const text = [event["message"], event["error"], event["result"]]
          .filter((value): value is string => typeof value === "string")
          .join(" ");
        if (EXHAUSTION_PHRASE.test(text) || SESSION_LIMIT_BANNER.test(text)) return buildSignal(text, null);
      }
      return null;
    } catch {
      // fall through to stream checks
    }
  }

  if (stream === "stdout" && SESSION_LIMIT_BANNER.test(line)) return buildSignal(line, null);
  if (stream === "stderr" && (EXHAUSTION_PHRASE.test(line) || SESSION_LIMIT_BANNER.test(line))) {
    return buildSignal(line, null);
  }
  return null;
}

export function detectProviderTokenExhaustion(
  agent: DispatcherAgent,
  line: string,
  stream: "stdout" | "stderr",
): TokenExhaustionSignal | null {
  return agent === "claude"
    ? detectClaudeTokenExhaustion(line, stream)
    : detectCodexTokenExhaustion(line, stream);
}

function resolveWallClock(wc: WallClockReset, nowMs: number): number {
  const today = getZonedDateTimeParts(new Date(nowMs), wc.timeZone);
  const at = (parts: typeof today) =>
    zonedTimeToUtc({ ...parts, hour: wc.hour, minute: wc.minute, second: 0 }, wc.timeZone).getTime();

  const todayMs = at(today);
  if (todayMs > nowMs) return todayMs;
  const tomorrow = getZonedDateTimeParts(new Date(nowMs + 24 * 60 * 60 * 1000), wc.timeZone);
  return at(tomorrow);
}

export interface SuppressionWindow {
  until: Date;
  parseFailed: boolean;
  resetLabel: string | null;
}

/** Turns a detected signal into a concrete suppression deadline. */
export function computeSuppressUntil(signal: TokenExhaustionSignal, nowMs: number): SuppressionWindow {
  const resetLabel = signal.resetLabel ?? null;
  if (signal.resetAt !== null && signal.resetAt > nowMs) {
    return { until: new Date(signal.resetAt), parseFailed: false, resetLabel };
  }
  if (signal.wallClock) {
    const resolved = resolveWallClock(signal.wallClock, nowMs);
    if (resolved > nowMs) return { until: new Date(resolved), parseFailed: false, resetLabel };
  }
  return { until: new Date(nowMs + FALLBACK_SUPPRESSION_MS), parseFailed: true, resetLabel };
}

/** True when a provider is currently held by its cooldown window. */
export function isProviderSuppressed(suppressedUntil: Date | null, nowMs: number): boolean {
  return suppressedUntil !== null && suppressedUntil.getTime() > nowMs;
}

const RESET_TIME_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: CENTRAL_TIME_ZONE,
  weekday: "short",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
});

/** Human-readable reset time for the notification (business timezone). */
export function formatResetTime(until: Date): string {
  return RESET_TIME_FORMATTER.format(until);
}
