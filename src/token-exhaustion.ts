/**
 * Provider capacity-signal detection and suppression policy (ported from #245/#307,
 * hardened by the #32 incident: Codex hit a quota-like error with no reset, and the
 * dispatcher applied Claude's documented ~5h rolling-window fallback to it, pausing
 * Codex for 5 hours when the real quota cleared in ~22 minutes).
 *
 * Detection is restricted to provider-owned error/banner output so issue text an agent
 * echoes cannot manufacture a cooldown (`detectProviderTokenExhaustion` and its two
 * per-CLI variants are unchanged in that respect — only the phrase set and the
 * classification of what was matched grew).
 *
 * Several materially different external conditions used to collapse into one
 * `token_exhausted` bucket with one policy. This module now distinguishes signal *kind*
 * (what happened) from signal *confidence* (whether a concrete reset was reported), and
 * applies provider-specific policy: Claude's rolling-window assumption is Claude's
 * alone, context/request-size failures never suppress the whole pool, and an unconfirmed
 * no-reset signal gets a short bounded revalidation instead of a blind long fallback.
 *
 * This module is pure. Recording the cooldown, persisting the durable evidence, and
 * sending the (single) notification is the runner/dispatcher's job, keeping detection
 * and policy trivially testable.
 */

import type { DispatcherAgent } from "./labels.ts";
import type { CiState } from "./sanitize.ts";
import { CENTRAL_TIME_ZONE, getZonedDateTimeParts, zonedTimeToUtc } from "./timezone.ts";

/**
 * The provider-capacity taxonomy (issue #32 requirement 1). Kind is *what* the provider
 * reported; confidence (`authoritative` on the resulting decision) is *how sure* we are
 * about the recovery time. Kept in kebab-case to match the existing planning taxonomy
 * (`FailureCategory` in routing.ts uses the same spelling for `context-exhaustion`).
 */
export const PROVIDER_CAPACITY_KIND = [
  /** A concrete reset (epoch, ISO timestamp, or parseable wall-clock) was reported. */
  "authoritative-exhaustion",
  /** A quota-like phrase with no reset we could parse — unproven, must self-revalidate. */
  "unconfirmed-quota",
  /** Transient rate/concurrency limiting — expected to clear quickly on its own. */
  "throttling",
  /** A per-request/context-window limit — not an account-capacity fact. */
  "context-exhaustion",
  /** Billing/credit exhaustion — needs its own recovery path, not a rolling-limit guess. */
  "billing",
  /** Matched a generic quota-like error we could not place in a more specific bucket. */
  "unknown",
] as const;
export type ProviderCapacityKind = (typeof PROVIDER_CAPACITY_KIND)[number];

export const PROVIDER_CAPACITY_SIGNAL_SOURCE = [
  "canonical-line",
  "structured-error",
  "provider-banner",
] as const;
export type ProviderCapacitySignalSource = (typeof PROVIDER_CAPACITY_SIGNAL_SOURCE)[number];

/**
 * Fallback cooldown when Claude reports a quota-like signal with no reset. Claude's
 * subscription limits reset on a documented rolling ~5-hour window — this assumption is
 * Claude-specific and must never leak into another provider's policy (issue #32
 * requirement 3).
 */
export const CLAUDE_ROLLING_WINDOW_FALLBACK_MS = 5 * 60 * 60 * 1000;

/**
 * Bounded near-term revalidation for a no-reset quota-like signal from any non-Claude
 * provider (or an otherwise-unclassified quota error). Chosen to be short enough that a
 * transient/false-positive classification self-corrects quickly (the #32 incident's real
 * recovery was ~22 minutes) without hammering the provider every scan.
 */
export const UNCONFIRMED_QUOTA_REVALIDATION_MS = 20 * 60 * 1000;

/** Transient throttling is expected to clear well inside one poll cycle. */
export const THROTTLE_REVALIDATION_MS = 5 * 60 * 1000;

/**
 * Billing/credit exhaustion is not a rolling quota — it needs explicit provider-specific
 * recovery (e.g. a human tops up credits) — but automation still self-revalidates on a
 * bounded window rather than holding immediately, distinct from both the short
 * unconfirmed-quota window and Claude's rolling-window number.
 */
export const BILLING_REVALIDATION_MS = 60 * 60 * 1000;

export interface WallClockReset {
  hour: number;
  minute: number;
  timeZone: string;
}

export interface ProviderCapacitySignal {
  kind: ProviderCapacityKind;
  /** Provenance class used to distinguish provider errors from untrusted tool output. */
  source?: ProviderCapacitySignalSource;
  /** Original process stream carrying the trusted provider event. */
  stream?: "stdout" | "stderr";
  /** Absolute reset instant (epoch ms) when directly reported; else null. */
  resetAt: number | null;
  /** Wall-clock reset ("resets 4am (UTC)"), resolved later against `now`. */
  wallClock?: WallClockReset | null;
  /** The reset time verbatim as reported, for the notification (e.g. "4am (UTC)"). */
  resetLabel?: string | null;
  /** Bounded, unredacted excerpt of the matched provider text — caller must redact. */
  excerpt: string;
}

const THROTTLE_PHRASE =
  /\b(?:rate limit(?:ed|ing)?|too many requests|429|please (?:slow down|try again (?:shortly|later))|temporarily unavailable due to (?:high demand|load)|concurrency limit|too many concurrent requests|server is busy)\b/i;

const CONTEXT_PHRASE =
  /\b(?:context length exceeded|context[_\s-]?window|maximum context length|prompt is too long|input is too long|exceeds the maximum (?:number of tokens|context length)|reduce the length of the (?:messages|prompt)|request(?:ed)? too large|context_length_exceeded)\b/i;

const BILLING_PHRASE =
  /\b(?:insufficient (?:credits|balance|funds)|billing (?:issue|error|required|problem)|payment (?:required|method|failed)|add (?:a )?payment method|purchase (?:more|additional) credits|no credits? remaining|(?:your )?(?:plan|subscription) (?:has expired|does not include)|account (?:suspended|past due))\b/i;

const EXHAUSTION_PHRASE =
  /usage limit reached|out of (?:tokens|credits)|insufficient (?:tokens|quota)|token (?:limit|budget|quota) (?:reached|exceeded|exhausted)|exhausted your (?:tokens|credits|usage)/i;

const SESSION_LIMIT_BANNER =
  /\b(?:hit|reached|exceeded)\s+your\s+(?:session|usage|weekly|5[-\s]?hour|daily)\s+limit\b/i;

/** Everything this module ever treats as a capacity-relevant phrase, for the initial gate. */
const ANY_CAPACITY_PHRASE = new RegExp(
  [
    THROTTLE_PHRASE.source,
    CONTEXT_PHRASE.source,
    BILLING_PHRASE.source,
    EXHAUSTION_PHRASE.source,
    SESSION_LIMIT_BANNER.source,
  ].join("|"),
  "i",
);

const CANONICAL_LIMIT_LINE =
  /^(?:Claude AI|Claude|Codex|OpenAI Codex)?\s*usage limit reached\s*\|\s*(\d{9,13})\s*$/i;

const EPOCH_MS_THRESHOLD = 1e12;
const RESET_CLAUSE = /reset[s]?\b\s*(?:at\s+)?(.+)$/i;
const CLOCK_RE = /\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?\b/i;
const MAX_EXCERPT_LENGTH = 300;

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

/**
 * Classifies *what kind* of capacity signal matched, independent of whether a reset was
 * found. Order matters: the more specific categories (throttling/context/billing) are
 * checked before the generic quota phrase so e.g. "insufficient credits" is billing, not
 * an undifferentiated quota error.
 */
function classifyKind(text: string): ProviderCapacityKind | null {
  if (THROTTLE_PHRASE.test(text)) return "throttling";
  if (CONTEXT_PHRASE.test(text)) return "context-exhaustion";
  if (BILLING_PHRASE.test(text)) return "billing";
  if (
    CANONICAL_LIMIT_LINE.test(text) ||
    EXHAUSTION_PHRASE.test(text) ||
    SESSION_LIMIT_BANNER.test(text)
  ) {
    return "unconfirmed-quota";
  }
  return null;
}

function buildSignal(
  text: string,
  epoch: number | null,
  source: ProviderCapacitySignalSource,
  stream: "stdout" | "stderr",
): ProviderCapacitySignal {
  const kind = classifyKind(text) ?? "unknown";
  const excerpt = text.slice(0, MAX_EXCERPT_LENGTH);

  if (epoch !== null) {
    return { kind, source, stream, resetAt: epoch, wallClock: null, resetLabel: null, excerpt };
  }

  const label = extractResetLabel(text);

  const piped = text.match(/\|\s*(\d{9,13})\b/);
  if (piped?.[1]) {
    const parsed = parseEpoch(piped[1]);
    if (parsed !== null) {
      return { kind, source, stream, resetAt: parsed, wallClock: null, resetLabel: label, excerpt };
    }
  }

  const iso = text.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?Z?/);
  if (iso) {
    const ms = Date.parse(iso[0]);
    if (Number.isFinite(ms)) {
      return { kind, source, stream, resetAt: ms, wallClock: null, resetLabel: label, excerpt };
    }
  }

  const wallClock = label ? parseWallClock(label) : null;
  return { kind, source, stream, resetAt: null, wallClock, resetLabel: label, excerpt };
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

function structuredErrorText(event: Record<string, unknown>): string {
  const error = event["error"];
  const nestedError =
    error && typeof error === "object" ? (error as Record<string, unknown>) : null;
  return [
    event["message"],
    typeof error === "string" ? error : null,
    nestedError?.["message"],
    nestedError?.["code"],
    event["result"],
    event["subtype"],
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
}

function detectCanonicalLine(
  line: string,
  stream: "stdout" | "stderr",
): ProviderCapacitySignal | null {
  const canonical = line.trim().match(CANONICAL_LIMIT_LINE);
  return canonical?.[1]
    ? buildSignal(line.trim(), parseEpoch(canonical[1]), "canonical-line", stream)
    : null;
}

/** Recognizes a Claude provider-capacity signal in one line of agent output. */
export function detectClaudeTokenExhaustion(
  line: string,
  stream: "stdout" | "stderr",
): ProviderCapacitySignal | null {
  const canonical = detectCanonicalLine(line, stream);
  if (canonical) return canonical;

  const trimmed = line.trim();

  if (stream === "stdout" && trimmed.startsWith("{")) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return null;
    }

    if (event["type"] === "result" && event["is_error"] === true) {
      const text = structuredErrorText(event);
      if (ANY_CAPACITY_PHRASE.test(text)) {
        return buildSignal(text, null, "structured-error", stream);
      }
      return null;
    }

    if (event["type"] === "assistant") {
      // Only the CLI's own narrow banner text is trusted here — broad phrases would trip
      // on ordinary assistant prose that merely mentions tokens/limits (e.g. summarizing
      // an issue body that talks about exhaustion).
      const text = extractAssistantText(event);
      if (SESSION_LIMIT_BANNER.test(text)) {
        return buildSignal(text, null, "provider-banner", stream);
      }
      return null;
    }

    return null;
  }

  if (stream === "stdout" && SESSION_LIMIT_BANNER.test(line)) {
    return buildSignal(line, null, "provider-banner", stream);
  }
  // stream-json keeps repository/tool output inside typed stdout events. Plain stderr is
  // accepted only when the CLI itself marks the line as an error; arbitrary prose is not
  // provider-owned evidence.
  if (/^(?:error|fatal)\s*:/i.test(trimmed) && ANY_CAPACITY_PHRASE.test(trimmed)) {
    return buildSignal(trimmed, null, "provider-banner", stream);
  }
  return null;
}

/** Recognizes Codex's provider-owned quota/capacity output. */
export function detectCodexTokenExhaustion(
  line: string,
  stream: "stdout" | "stderr",
): ProviderCapacitySignal | null {
  const canonical = detectCanonicalLine(line, stream);
  if (canonical) return canonical;

  const trimmed = line.trim();
  if (trimmed.startsWith("{")) {
    try {
      const event = JSON.parse(trimmed) as Record<string, unknown>;
      const isError =
        event["type"] === "error" ||
        event["type"] === "turn.failed" ||
        event["is_error"] === true;
      if (isError) {
        const text = structuredErrorText(event);
        if (ANY_CAPACITY_PHRASE.test(text)) {
          return buildSignal(text, null, "structured-error", stream);
        }
      }
      return null;
    } catch {
      // fall through to stream checks
    }
  }

  // Codex runs with `--json`; its ordinary progress and command output are untrusted
  // JSONL item events. Do not scan plain stderr: pre-JSON Codex printed the entire agent
  // transcript there, which let repository fixtures manufacture provider cooldowns.
  return null;
}

export function detectProviderTokenExhaustion(
  agent: DispatcherAgent,
  line: string,
  stream: "stdout" | "stderr",
): ProviderCapacitySignal | null {
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

/**
 * A signal never suppresses the whole provider pool when it is per-request/task scoped
 * rather than an account-capacity fact (issue #32 requirement 4/acceptance criterion 4).
 */
export function suppressesPool(kind: ProviderCapacityKind): boolean {
  return kind !== "context-exhaustion";
}

export interface CapacityDecision {
  /** Deadline until which the provider pool is paused / should be revalidated. */
  until: Date;
  /** True only when a concrete provider-reported reset resolved to a future instant. */
  authoritative: boolean;
  kind: ProviderCapacityKind;
  resetLabel: string | null;
}

/**
 * Turns a detected signal into a concrete, provider- and kind-aware suppression
 * decision. A concrete reported reset always wins (authoritative), regardless of which
 * phrase matched. Absent that, policy is kind- and provider-specific: Claude's
 * documented rolling window is Claude-only; throttling and billing get their own bounded
 * windows; anything else unconfirmed gets a short bounded revalidation rather than a
 * blind long fallback (issue #32 requirements 3 and 5).
 */
export function computeCapacityDecision(
  agent: DispatcherAgent,
  signal: ProviderCapacitySignal,
  nowMs: number,
): CapacityDecision {
  const resetLabel = signal.resetLabel ?? null;

  if (signal.resetAt !== null && signal.resetAt > nowMs) {
    return { until: new Date(signal.resetAt), authoritative: true, kind: "authoritative-exhaustion", resetLabel };
  }
  if (signal.wallClock) {
    const resolved = resolveWallClock(signal.wallClock, nowMs);
    if (resolved > nowMs) {
      return { until: new Date(resolved), authoritative: true, kind: "authoritative-exhaustion", resetLabel };
    }
  }

  if (signal.kind === "throttling") {
    return { until: new Date(nowMs + THROTTLE_REVALIDATION_MS), authoritative: false, kind: "throttling", resetLabel };
  }
  if (signal.kind === "billing") {
    return { until: new Date(nowMs + BILLING_REVALIDATION_MS), authoritative: false, kind: "billing", resetLabel };
  }
  if (agent === "claude") {
    return {
      until: new Date(nowMs + CLAUDE_ROLLING_WINDOW_FALLBACK_MS),
      authoritative: false,
      kind: signal.kind,
      resetLabel,
    };
  }
  return {
    until: new Date(nowMs + UNCONFIRMED_QUOTA_REVALIDATION_MS),
    authoritative: false,
    kind: signal.kind,
    resetLabel,
  };
}

/** True when a provider is currently held by its cooldown/revalidation window. */
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

/** Human-readable reset/revalidation time for the notification (business timezone). */
export function formatResetTime(until: Date): string {
  return RESET_TIME_FORMATTER.format(until);
}

const CAPACITY_KIND_LABEL: Record<ProviderCapacityKind, string> = {
  "authoritative-exhaustion": "is out of tokens",
  "unconfirmed-quota": "reported a quota-like error",
  throttling: "is being rate-limited",
  "context-exhaustion": "hit a context/request-size limit",
  billing: "reported a billing/credit error",
  unknown: "reported an unrecognized capacity error",
};

export interface CapacityResolution {
  /** `token_exhausted` unless the run's own evidence is already delivery-ready. */
  status: "token_exhausted" | "pr_ready";
  summary: string;
  evidence: {
    kind: ProviderCapacityKind;
    until: number;
    authoritative: boolean;
    detectedAt: number;
    reportedResetLabel: string | null;
    source?: ProviderCapacitySignalSource;
    stream?: "stdout" | "stderr";
    /** Bounded, UNREDACTED excerpt — the caller must redact before persisting. */
    excerpt: string;
  };
}

/**
 * Resolves a detected capacity signal into the final terminal status, the human-facing
 * summary, and the durable evidence to persist — while keeping provider-capacity state
 * separate from run/artifact state (issue #32 requirement 7): a provider cooldown is
 * always recorded so it can block *new* launches, but it must not strand a run whose own
 * evidence (commits + PR + green CI) already proves the work is delivery-ready. Green CI
 * alone is not enough — commits and an actual PR are required too, so an incomplete
 * non-zero run is never falsely treated as shipped merely because CI happened to read
 * green (acceptance criteria 9 and 10).
 */
export function resolveCapacitySuppression(
  agent: DispatcherAgent,
  signal: ProviderCapacitySignal,
  evidenceInputs: { resultCommits: number; resultCi: CiState; prNumber: number | null },
  nowMs: number,
): CapacityResolution {
  const decision = computeCapacityDecision(agent, signal, nowMs);
  const provider = agent === "claude" ? "Claude" : "Codex";
  const evidence = {
    kind: decision.kind,
    until: decision.until.getTime(),
    authoritative: decision.authoritative,
    detectedAt: nowMs,
    reportedResetLabel: decision.resetLabel,
    ...(signal.source ? { source: signal.source } : {}),
    ...(signal.stream ? { stream: signal.stream } : {}),
    excerpt: signal.excerpt,
  };

  const deliveryReady =
    evidenceInputs.resultCommits > 0 &&
    evidenceInputs.resultCi === "pass" &&
    evidenceInputs.prNumber !== null;

  if (deliveryReady) {
    return {
      status: "pr_ready",
      summary:
        `${provider} reported a capacity signal after the work was already complete ` +
        `(commits, an open PR, and green CI). The delivery is not held back; ${provider} ` +
        `dispatching is separately paused — see the provider suppression record.`,
      evidence,
    };
  }

  const kindLabel = CAPACITY_KIND_LABEL[decision.kind];
  const reported = decision.resetLabel ? ` (${provider} reported: ${decision.resetLabel})` : "";
  const when = formatResetTime(decision.until);
  const summary = decision.authoritative
    ? `${provider} ${kindLabel}${reported}. The run is preserved and ${provider} dispatching is paused until the reported reset at ${when}.`
    : `${provider} ${kindLabel}${reported}. The run is preserved and ${provider} dispatching is paused until ${when}; this is unconfirmed and will be revalidated automatically.`;

  return { status: "token_exhausted", summary, evidence };
}
