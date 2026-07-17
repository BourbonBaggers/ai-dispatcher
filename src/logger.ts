/**
 * Tiny leveled logger. One JSON object per line on stdout so a service manager
 * (systemd, pm2, docker) can collect and filter it. No dependency, no transport.
 */

import type { LogLevel } from "./config.ts";

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export function createLogger(level: LogLevel, sink: (line: string) => void = (l) => process.stdout.write(l + "\n")): Logger {
  const threshold = ORDER[level];
  const emit = (lvl: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (ORDER[lvl] < threshold) return;
    const record: Record<string, unknown> = { level: lvl, msg, ...fields };
    // A timestamp is useful, but Date.now() is unavailable in some sandboxed contexts;
    // guard it so the logger never throws.
    try {
      record["ts"] = new Date().toISOString();
    } catch {
      // no timestamp
    }
    sink(JSON.stringify(record));
  };
  return {
    debug: (msg, fields) => emit("debug", msg, fields),
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
  };
}
