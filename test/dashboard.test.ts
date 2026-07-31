import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  capReplayBatch,
  computeNextRunAt,
  dashboardRecentRuns,
  dashboardPayload,
  parseDashboardArgs,
  parseEnvironmentFile,
  parseSystemdCat,
  streamInstance,
  type RecentScan,
} from "../src/dashboard.ts";
import { StateStore } from "../src/state.ts";
import type { StatusJson } from "../src/status.ts";
import { appendRunOutputEntry, type RunOutputEntry } from "../src/run-output.ts";
import type { ExecFn } from "../src/exec.ts";

function outputEntry(seq: number): RunOutputEntry {
  return { version: 1, runId: "run-1", seq, timestamp: seq, type: "output", stream: "stdout", line: `line ${seq}` };
}

function fakeUnitExec(envPath: string): ExecFn {
  return async (file, args) => {
    if (file === "systemctl" && args.includes("cat")) {
      return {
        ok: true,
        stdout: `[Unit]\nDescription=AI Issue Dispatcher\n[Service]\nEnvironmentFile=${envPath}\nExecStart=/node bin/ai-dispatcher.mjs --repo acme/widgets --interval 60\n`,
        stderr: "",
        code: 0,
      };
    }
    if (file === "systemctl" && args.includes("show")) {
      return { ok: true, stdout: "ActiveState=active\nSubState=running\nMainPID=42\n", stderr: "", code: 0 };
    }
    if (file === "journalctl") return { ok: true, stdout: "", stderr: "", code: 0 };
    if (file === "gh") return { ok: true, stdout: "[]", stderr: "", code: 0 };
    return { ok: false, stdout: "", stderr: `unexpected command ${file}`, code: 1 };
  };
}

function fakeStreamRes(): {
  res: { writeHead: () => void; write: (chunk: string) => void; end: () => void; on: (name: string, cb: () => void) => void };
  writes: string[];
  ended: boolean;
  close: () => void;
} {
  const writes: string[] = [];
  let ended = false;
  let closeHandler: (() => void) | null = null;
  const res = {
    writeHead: () => {},
    write: (chunk: string) => {
      writes.push(chunk);
    },
    end: () => {
      ended = true;
    },
    on: (name: string, cb: () => void) => {
      if (name === "close") closeHandler = cb;
    },
  };
  return {
    res,
    writes,
    get ended() {
      return ended;
    },
    close: () => closeHandler?.(),
  };
}

function eventsOf(writes: string[], event: string): unknown[] {
  const out: unknown[] = [];
  for (let i = 0; i < writes.length; i += 1) {
    const chunk = writes[i]!;
    if (!chunk.startsWith("event: ")) continue;
    const name = chunk.slice("event: ".length).trim();
    const dataChunk = writes[i + 1] ?? "";
    const dataLine = dataChunk.split("\n").find((line) => line.startsWith("data: "));
    if (name === event && dataLine) out.push(JSON.parse(dataLine.slice("data: ".length)));
  }
  return out;
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "ai-dispatcher-dashboard-"));
}

test("parseDashboardArgs defaults to a local dashboard port and accepts repeated units", () => {
  const parsed = parseDashboardArgs(["--unit", "ai-dispatcher.service", "--unit", "ai-dispatcher-self.service"]);
  assert.equal(parsed.ok, true);
  if (!parsed.ok || parsed.help) return;
  assert.equal(parsed.host, "127.0.0.1");
  assert.equal(parsed.port, 8787);
  assert.deepEqual(parsed.units, ["ai-dispatcher.service", "ai-dispatcher-self.service"]);
});

test("parseEnvironmentFile reads inert dispatcher assignments", () => {
  assert.deepEqual(
    parseEnvironmentFile(`
# comment
DISPATCHER_REPO=BourbonBaggers/internal-tools
DISPATCHER_STATE_DIR="/home/jayk1/ai-dispatcher/state"
ignored line
`),
    {
      DISPATCHER_REPO: "BourbonBaggers/internal-tools",
      DISPATCHER_STATE_DIR: "/home/jayk1/ai-dispatcher/state",
    },
  );
});

test("parseSystemdCat extracts unit display data without sourcing anything", () => {
  const parsed = parseSystemdCat(
    "ai-dispatcher.service",
    `
[Unit]
Description=AI Issue Dispatcher (standalone)
[Service]
WorkingDirectory=%h/ai-dispatcher
EnvironmentFile=%h/ai-dispatcher/.env
Environment=PATH=%h/bin:/usr/bin
ExecStart=%h/.nvm/versions/node/v24.18.0/bin/node bin/ai-dispatcher.mjs --repo BourbonBaggers/internal-tools --interval 900
`,
  );
  assert.equal(parsed.repo, "BourbonBaggers/internal-tools");
  assert.equal(parsed.intervalSeconds, 900);
  assert.match(parsed.workingDirectory ?? "", /ai-dispatcher$/);
  assert.match(parsed.environmentFile ?? "", /ai-dispatcher\/\.env$/);
  assert.match(parsed.environment?.PATH ?? "", /\/bin:\/usr\/bin$/);
});

test("computeNextRunAt reports the next poll only for truly idle online status", () => {
  const recent: RecentScan = { at: 1_000, started: null, message: "No eligible issues." };
  const status: StatusJson = {
    version: 1,
    service: { state: "online", pid: 123 },
    stateSource: "primary",
    current: null,
    github: { state: "ok", repo: "acme/widgets", workingIssues: [], warning: null },
  };
  assert.equal(computeNextRunAt(status, recent, 900, 10_000), 901_000);
  assert.equal(
    computeNextRunAt(
      {
        ...status,
        github: {
          state: "ok",
          repo: "acme/widgets",
          workingIssues: [
            {
              number: 1,
              title: "busy",
              url: "https://github.com/acme/widgets/issues/1",
              labels: ["agent-working"],
              issueCommand: "gh issue view 1",
              prSearchCommand: "gh pr list",
            },
          ],
          warning: null,
        },
      },
      recent,
      900,
      10_000,
    ),
    null,
  );
});

test("dashboardPayload combines systemd, state, GitHub, and journal evidence", async () => {
  const dir = tmp();
  try {
    const stateDir = join(dir, "state");
    const envPath = join(dir, "dispatcher.env");
    writeFileSync(
      envPath,
      `DISPATCHER_REPO=acme/widgets\nDISPATCHER_STATE_DIR=${stateDir}\nDISPATCHER_POLL_INTERVAL_SECONDS=60\n`,
      "utf8",
    );
    const store = StateStore.open(stateDir);

    const payload = await dashboardPayload(["ai-dispatcher.service"], async (file, args) => {
      if (file === "systemctl" && args.includes("cat")) {
        return {
          ok: true,
          stdout: `
[Unit]
Description=AI Issue Dispatcher
[Service]
EnvironmentFile=${envPath}
ExecStart=/node bin/ai-dispatcher.mjs --repo acme/widgets --interval 60
`,
          stderr: "",
          code: 0,
        };
      }
      if (file === "systemctl" && args.includes("show")) {
        return { ok: true, stdout: "ActiveState=active\nSubState=running\nMainPID=42\n", stderr: "", code: 0 };
      }
      if (file === "journalctl") {
        return {
          ok: true,
          stdout: JSON.stringify({
            level: "info",
            msg: "scan complete",
            started: null,
            message: "No eligible issues.",
            ts: "2026-07-30T05:00:00.000Z",
          }),
          stderr: "",
          code: 0,
        };
      }
      if (file === "gh") {
        return { ok: true, stdout: "[]", stderr: "", code: 0 };
      }
      return { ok: false, stdout: "", stderr: "unexpected command", code: 1 };
    });

    assert.equal(payload.version, 1);
    assert.equal(payload.instances.length, 1);
    assert.equal(payload.instances[0]?.kind, "idle");
    assert.deepEqual(payload.instances[0]?.recentRuns, []);
    assert.equal(payload.instances[0]?.systemd.mainPid, 42);
    assert.ok((payload.instances[0]?.nextRunAt ?? 0) >= Date.parse("2026-07-30T05:01:00.000Z"));
    store.releaseLock();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dashboardRecentRuns returns the five newest non-idle runs", () => {
  const dir = tmp();
  try {
    const store = StateStore.open(dir);
    for (let issue = 1; issue <= 6; issue += 1) {
      const run = store.createRun({
        issueNumber: issue,
        issueTitle: `issue ${issue}`,
        issueUrl: `https://github.com/acme/widgets/issues/${issue}`,
        agent: "codex",
        modelLabel: "model:gpt-5.5",
        cliModel: "gpt-5.5",
        effortLabel: "effort:medium",
        cliEffort: "medium",
        branch: `issue-${issue}`,
        checkoutPath: `/tmp/issue-${issue}`,
        planPath: null,
        trigger: "poll",
      });
      store.updateRun(run.id, {
        status: issue === 3 ? "interrupted" : "shipped",
        createdAt: issue * 1000,
        finishedAt: issue * 1000 + 500,
      });
    }

    const recent = dashboardRecentRuns(dir);
    assert.deepEqual(
      recent.map((run) => run.issue.number),
      [6, 5, 4, 3, 2],
    );
    assert.equal(recent[3]?.status, "interrupted");
    store.releaseLock();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("capReplayBatch passes small batches through untouched", () => {
  const entries = [outputEntry(1), outputEntry(2), outputEntry(3)];
  const batch = capReplayBatch(entries, 200, 0);
  assert.deepEqual(batch.toSend, entries);
  assert.equal(batch.omitted, 0);
  assert.equal(batch.nextSeq, 3);
});

test("capReplayBatch caps a large backlog but still advances seq past every omitted entry", () => {
  const entries = Array.from({ length: 5000 }, (_, i) => outputEntry(i + 1));
  const batch = capReplayBatch(entries, 200, 0);
  assert.equal(batch.toSend.length, 200);
  assert.equal(batch.omitted, 4800);
  assert.equal(batch.toSend[0]?.seq, 4801);
  assert.equal(batch.toSend[199]?.seq, 5000);
  assert.equal(batch.nextSeq, 5000);
});

test("capReplayBatch on an empty batch keeps the caller's resume point", () => {
  const batch = capReplayBatch([], 200, 42);
  assert.deepEqual(batch, { toSend: [], omitted: 0, nextSeq: 42 });
});

test("streamInstance caps a large output backlog and emits a truncation notice on first connect", async () => {
  const dir = tmp();
  try {
    const stateDir = join(dir, "state");
    const envPath = join(dir, "dispatcher.env");
    writeFileSync(envPath, `DISPATCHER_REPO=acme/widgets\nDISPATCHER_STATE_DIR=${stateDir}\n`, "utf8");
    const store = StateStore.open(stateDir);
    const run = store.createRun({
      issueNumber: 7,
      issueTitle: "big verbose run",
      issueUrl: "https://github.com/acme/widgets/issues/7",
      agent: "codex",
      modelLabel: "model:gpt-5.5",
      cliModel: "gpt-5.5",
      effortLabel: "effort:medium",
      cliEffort: "medium",
      branch: "issue-7",
      checkoutPath: "/tmp/issue-7",
      planPath: null,
      trigger: "poll",
    });
    store.updateRun(run.id, { status: "running" });
    for (let seq = 1; seq <= 5000; seq += 1) {
      appendRunOutputEntry(stateDir, { ...outputEntry(seq), runId: run.id });
    }
    store.releaseLock();

    const { res, writes, close } = fakeStreamRes();
    const stream = streamInstance("ai-dispatcher.service", ["ai-dispatcher.service"], res as never, fakeUnitExec(envPath));
    // A single poll tick is enough to observe the capped replay; close right after it.
    setTimeout(close, 50);
    await stream;

    const entries = eventsOf(writes, "entry") as RunOutputEntry[];
    const notices = eventsOf(writes, "notice") as { message: string }[];
    assert.equal(entries.length, 200);
    assert.equal(entries[0]?.seq, 4801);
    assert.equal(entries[199]?.seq, 5000);
    assert.equal(notices.length, 1);
    assert.match(notices[0]!.message, /4800 earlier output line/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("streamInstance closes the response cleanly for an unknown unit instead of hanging it open", async () => {
  const fake = fakeStreamRes();
  await streamInstance("ai-dispatcher-does-not-exist.service", ["ai-dispatcher.service"], fake.res as never, fakeUnitExec("/nonexistent/env"));
  const errors = eventsOf(fake.writes, "error") as { message: string }[];
  assert.equal(errors.length, 1);
  assert.match(errors[0]!.message, /unknown dispatcher unit/);
  assert.equal(fake.ended, true);
});

test("compact dashboard markup keeps dispatcher tabs visible", () => {
  const html = readFileSync("dashboard/dispatcher-status.html", "utf8");
  assert.doesNotMatch(html, /body\.compact \.tabs,\s*body\.compact \.side/);
  assert.doesNotMatch(html, /if \(compact\) return;/);
  assert.match(html, /aria-label="Dispatcher instances"/);
});
