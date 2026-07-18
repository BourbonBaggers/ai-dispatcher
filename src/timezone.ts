/**
 * Minimal DST-safe timezone helpers, ported from the monorepo's timezone.ts (only the
 * parts token-exhaustion needs: parts-in-zone and zoned-wall-clock → UTC).
 */

export const CENTRAL_TIME_ZONE = "America/Chicago";

const ZONED_UTC_CONVERSION_PASSES = 3;
const DATE_PART_FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>();

export interface ZonedDateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = DATE_PART_FORMATTER_CACHE.get(timeZone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  DATE_PART_FORMATTER_CACHE.set(timeZone, formatter);
  return formatter;
}

export function getZonedDateTimeParts(date: Date, timeZone = CENTRAL_TIME_ZONE): ZonedDateTimeParts {
  const entries = formatterFor(timeZone)
    .formatToParts(date)
    .filter((part) => part.type !== "literal")
    .map((part) => [part.type, Number(part.value)] as const);
  const parts = Object.fromEntries(entries) as Record<string, number>;
  return {
    year: parts["year"] ?? date.getUTCFullYear(),
    month: parts["month"] ?? date.getUTCMonth() + 1,
    day: parts["day"] ?? date.getUTCDate(),
    hour: parts["hour"] ?? date.getUTCHours(),
    minute: parts["minute"] ?? date.getUTCMinutes(),
    second: parts["second"] ?? date.getUTCSeconds(),
  };
}

function partsUtcMs(parts: ZonedDateTimeParts): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
}

/** Interprets wall-clock parts as a time in `timeZone` and returns the UTC instant. */
export function zonedTimeToUtc(parts: ZonedDateTimeParts, timeZone = CENTRAL_TIME_ZONE): Date {
  let candidate = new Date(partsUtcMs(parts));
  for (let i = 0; i < ZONED_UTC_CONVERSION_PASSES; i++) {
    const actual = getZonedDateTimeParts(candidate, timeZone);
    const delta = partsUtcMs(actual) - partsUtcMs(parts);
    if (delta === 0) return candidate;
    candidate = new Date(candidate.getTime() - delta);
  }
  return candidate;
}
