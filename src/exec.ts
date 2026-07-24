/**
 * Thin child-process helper. Everything runs with an argv ARRAY through spawn —
 * no shell string is ever assembled, so issue text (title, body, comment) placed in
 * an argument stays data and can never become shell syntax.
 */

import { execFileSync, spawn } from "node:child_process";

export interface ExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
}

export interface ExecOptions {
  /** Fed to the child's stdin, then closed. Use for free-form/untrusted bodies. */
  stdin?: string;
  /** Kill the child after this many ms. */
  timeoutMs?: number;
  /** Working directory for the child. */
  cwd?: string;
  /** Extra environment on top of process.env. */
  env?: NodeJS.ProcessEnv;
  /** Run in its own process group and terminate the whole group on timeout. */
  killProcessGroup?: boolean;
  /** Grace between process-group SIGTERM and SIGKILL. */
  killGraceMs?: number;
  /** Retained tail per output stream. Output beyond this never kills the child. */
  maxOutputBytes?: number;
}

/** A function with the same shape as `run`, so callers can inject a fake in tests. */
export type ExecFn = (file: string, args: string[], options?: ExecOptions) => Promise<ExecResult>;

function processTree(rootPid: number): number[] {
  try {
    const rows = execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" });
    const children = new Map<number, number[]>();
    for (const row of rows.split(/\r?\n/)) {
      const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(row);
      if (!match) continue;
      const pid = Number.parseInt(match[1]!, 10);
      const parent = Number.parseInt(match[2]!, 10);
      children.set(parent, [...(children.get(parent) ?? []), pid]);
    }
    const found: number[] = [];
    const visit = (pid: number): void => {
      for (const child of children.get(pid) ?? []) {
        visit(child);
        found.push(child);
      }
    };
    visit(rootPid);
    return found;
  } catch {
    return [];
  }
}

function signalProcessTree(rootPid: number, descendants: readonly number[], signal: NodeJS.Signals): void {
  // Explicit descendants are required on platforms where a background shell job creates
  // another process group. Signal leaves first so they cannot outlive/reparent away from
  // the wrapper before we find them.
  for (const pid of descendants) {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
  try {
    // killProcessGroup launches the wrapper as a group leader. This also reaches children
    // created after the process snapshot, while the explicit PID list catches jobs that
    // deliberately moved themselves into another group.
    process.kill(-rootPid, signal);
  } catch {
    // Group already gone or unsupported.
  }
  try {
    process.kill(rootPid, signal);
  } catch {
    // Already gone.
  }
}

/** Runs one command to completion, buffering output. Never rejects. */
export function run(file: string, args: string[], options: ExecOptions = {}): Promise<ExecResult> {
  const {
    stdin,
    timeoutMs = 30_000,
    cwd,
    env,
    killProcessGroup = false,
    killGraceMs = 30_000,
    maxOutputBytes = 32 * 1024 * 1024,
  } = options;
  return new Promise((resolve) => {
    let timedOut = false;
    let timedOutDescendants: number[] = [];
    let timeoutTimer: NodeJS.Timeout | undefined;
    let forceTimer: NodeJS.Timeout | undefined;
    let stdout = "";
    let stderr = "";
    let spawnError: Error | null = null;
    let settled = false;
    const retainTail = (current: string, chunk: string): string => {
      const combined = current + chunk;
      return combined.length > maxOutputBytes
        ? combined.slice(combined.length - maxOutputBytes)
        : combined;
    };
    const child = spawn(file, args, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      detached: killProcessGroup,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = retainTail(stdout, chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = retainTail(stderr, chunk);
    });
    child.on("error", (error) => {
      spawnError = error;
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (forceTimer) {
        clearTimeout(forceTimer);
        // The wrapper may honor SIGTERM and close while a detached/background
        // descendant ignores it. Clearing the grace timer without this final sweep
        // leaked exactly those processes after a timed-out deploy.
        signalProcessTree(child.pid!, timedOutDescendants, "SIGKILL");
      }
      const finalCode = timedOut ? 124 : spawnError ? 1 : code;
      resolve({ ok: finalCode === 0, stdout, stderr, code: finalCode });
    });
    if (stdin !== undefined && child.stdin) {
      child.stdin.end(stdin);
    } else {
      child.stdin.end();
    }
    if (timeoutMs > 0 && child.pid) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        if (killProcessGroup) {
          timedOutDescendants = processTree(child.pid!);
          signalProcessTree(child.pid!, timedOutDescendants, "SIGTERM");
          forceTimer = setTimeout(() => {
            signalProcessTree(child.pid!, timedOutDescendants, "SIGKILL");
          }, killGraceMs);
        } else {
          child.kill("SIGTERM");
          forceTimer = setTimeout(() => child.kill("SIGKILL"), killGraceMs);
        }
      }, timeoutMs);
    }
  });
}
