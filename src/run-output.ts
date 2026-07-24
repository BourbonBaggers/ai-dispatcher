import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { runOutputPath, type RunPhase } from "./state.ts";

export type RunOutputStream = "stdout" | "stderr" | "control";

export type RunOutputEntry =
  | {
      version: 1;
      runId: string;
      seq: number;
      timestamp: number;
      type: "output";
      stream: Exclude<RunOutputStream, "control">;
      line: string;
    }
  | {
      version: 1;
      runId: string;
      seq: number;
      timestamp: number;
      type: "phase";
      stream: "control";
      phase: RunPhase;
      message: string;
    }
  | {
      version: 1;
      runId: string;
      seq: number;
      timestamp: number;
      type: "lifecycle";
      stream: "control";
      status: string;
      message: string | null;
    };

export function appendRunOutputEntry(stateDir: string, entry: RunOutputEntry): void {
  const path = runOutputPath(stateDir, entry.runId);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(entry)}\n`, { encoding: "utf8", flag: "a" });
}

export function readRunOutputEntries(stateDir: string, runId: string, afterSeq = 0): RunOutputEntry[] {
  const path = runOutputPath(stateDir, runId);
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8");
  const entries: RunOutputEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as Partial<RunOutputEntry>;
      if (
        parsed.version === 1 &&
        parsed.runId === runId &&
        typeof parsed.seq === "number" &&
        parsed.seq > afterSeq
      ) {
        entries.push(parsed as RunOutputEntry);
      }
    } catch {
      // A reader can catch the writer between bytes. Ignore the partial tail this poll.
    }
  }
  return entries.sort((a, b) => a.seq - b.seq);
}
