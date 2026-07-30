import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeNextRunAt,
  dashboardRecentRuns,
  dashboardPayload,
  parseDashboardArgs,
  parseEnvironmentFile,
  parseSystemdCat,
  type RecentScan,
} from "../src/dashboard.ts";
import { StateStore } from "../src/state.ts";
import type { StatusJson } from "../src/status.ts";

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
