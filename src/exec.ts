/**
 * Thin child-process helper. Everything runs with an argv ARRAY through execFile —
 * no shell string is ever assembled, so issue text (title, body, comment) placed in
 * an argument stays data and can never become shell syntax.
 */

import { execFile } from "node:child_process";

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
}

/** A function with the same shape as `run`, so callers can inject a fake in tests. */
export type ExecFn = (file: string, args: string[], options?: ExecOptions) => Promise<ExecResult>;

/** Runs one command to completion, buffering output. Never rejects. */
export function run(file: string, args: string[], options: ExecOptions = {}): Promise<ExecResult> {
  const { stdin, timeoutMs = 30_000, cwd, env } = options;
  return new Promise((resolve) => {
    const child = execFile(
      file,
      args,
      {
        cwd,
        env: env ? { ...process.env, ...env } : process.env,
        maxBuffer: 32 * 1024 * 1024,
        timeout: timeoutMs,
      },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as { code?: unknown }).code === "number"
            ? ((error as { code: number }).code)
            : error
              ? 1
              : 0;
        resolve({ ok: !error, stdout: stdout ?? "", stderr: stderr ?? "", code });
      },
    );
    if (stdin !== undefined && child.stdin) {
      child.stdin.end(stdin);
    }
  });
}
