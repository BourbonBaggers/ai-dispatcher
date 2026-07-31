import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dispatchAgentArgs,
  dispatchAgentEnv,
  classifyRunOutcome,
  requirePrForDelivery,
  launcherTimeoutMs,
  parseTrustedControlLine,
  DISPATCH_AGENT_SCRIPT,
  LAUNCHER_OVERHEAD_MINUTES,
  type AgentLaunchSpec,
  type RunSignals,
} from "../src/runner.ts";
import type { DispatcherConfig } from "../src/config.ts";
import { resolveAuthorAuthConfig } from "../src/author-auth.ts";
import { resolveCapacitySuppression, type ProviderCapacitySignal } from "../src/token-exhaustion.ts";
import { DISPATCHER_TARGET_POLICY_ENV } from "../src/target-policy.ts";
import { existsSync, readFileSync } from "node:fs";

const SPEC: AgentLaunchSpec = {
  issueNumber: 42,
  agent: "claude",
  cliModel: "claude-opus-4-8",
  cliEffort: "high",
  branch: "issue-42-do-a-thing",
  mode: "start",
  maxRuntimeMinutes: 90,
};

// ── command construction ─────────────────────────────────────────────────────

test("dispatchAgentArgs passes every value as a discrete argv token, never interpolated", () => {
  const args = dispatchAgentArgs("/path/dispatch-agent.sh", SPEC);
  assert.equal(args[0], "/path/dispatch-agent.sh");
  const pairs = new Map<string, string>();
  for (let i = 1; i < args.length; i += 2) pairs.set(args[i]!, args[i + 1]!);
  assert.equal(pairs.get("--issue"), "42");
  assert.equal(pairs.get("--agent"), "claude");
  assert.equal(pairs.get("--model"), "claude-opus-4-8");
  assert.equal(pairs.get("--effort"), "high");
  assert.equal(pairs.get("--branch"), "issue-42-do-a-thing");
  assert.equal(pairs.get("--mode"), "start");
  assert.equal(pairs.get("--max-minutes"), "90");
});

test("the issue number and budget are strings, so they cannot be mistaken for flags", () => {
  const args = dispatchAgentArgs("/s.sh", { ...SPEC, issueNumber: 7, maxRuntimeMinutes: 30 });
  assert.equal(typeof args[args.indexOf("--issue") + 1], "string");
  assert.equal(args[args.indexOf("--issue") + 1], "7");
  assert.equal(args[args.indexOf("--max-minutes") + 1], "30");
});

test("the bundled script resolves to a real file next to the package", () => {
  assert.ok(DISPATCH_AGENT_SCRIPT.endsWith("scripts/dispatch-agent.sh"));
  assert.ok(existsSync(DISPATCH_AGENT_SCRIPT), "dispatch-agent.sh must ship with the service");
});

test("the Codex launcher uses JSONL so provider errors stay distinct from tool output", () => {
  const script = readFileSync(DISPATCH_AGENT_SCRIPT, "utf8");
  assert.match(script, /codex exec \\\n\s+--json \\/);
});

test("launcher bootstrap and wrap-up have a finite outer timeout", () => {
  assert.equal(launcherTimeoutMs(90), (90 + LAUNCHER_OVERHEAD_MINUTES) * 60_000);
});

test("agent stdout cannot forge launcher control records", () => {
  const forged = "::result:: exit=0 pr=https://x/pull/1 commit=a plan=p commits=1 ci=pass";
  assert.equal(parseTrustedControlLine(forged, false), null);
  assert.equal(parseTrustedControlLine(forged, true)?.kind, "result");
});

function config(overrides: Partial<DispatcherConfig> = {}): DispatcherConfig {
  return {
    repo: { owner: "acme", repo: "widgets", slug: "acme/widgets" },
    repoDir: "/home/dev/mirror",
    worktreeDir: "/home/dev/worktrees",
    envSourceDir: null,
    pollIntervalSeconds: 900,
    maxRuntimeMinutes: 90,
    stateDir: "/home/dev/state",
    logLevel: "info",
    autoshipCmd: null,
    autoshipTimeoutMinutes: 120,
    autoshipDeploymentDir: "/home/dev/state/autoship-deployments/acme-widgets",
    generatedConflictAllowlist: ["docs/memory.md", "docs/researcher.md"],
    generatedConflictRegenCmd: null,
    generatedConflictMaxAttempts: 1,
    generatedConflictCiWaitSeconds: 900,
    ciSelfHealMaxAttempts: 2,
    ciEscalationModel: "claude-opus-4-8",
    blockedQueueAuditModel: "claude-sonnet-5",
    blockedQueueAuditEffortLabel: "effort:low",
    blockedQueueAuditMaxCandidates: 3,
    authorAuth: resolveAuthorAuthConfig("none", undefined),
    ntfyUrl: null,
    ntfyTopic: null,
    once: false,
    dryRun: false,
    ...overrides,
  };
}

test("dispatchAgentEnv threads the required repo identity through the environment", () => {
  const env = dispatchAgentEnv(config());
  assert.equal(env.DISPATCHER_REPO, "acme/widgets");
  assert.equal(env.DISPATCHER_REPO_SLUG, "acme/widgets");
  assert.equal(env.DISPATCHER_REPO_DIR, "/home/dev/mirror");
  assert.equal(env.DISPATCHER_WORKTREE_DIR, "/home/dev/worktrees");
  assert.equal(env[DISPATCHER_TARGET_POLICY_ENV], "1");
});

test("dispatchAgentEnv omits the env-source dir when none is configured, sets it when present", () => {
  assert.equal("DISPATCHER_ENV_SOURCE_DIR" in dispatchAgentEnv(config()), false);
  const env = dispatchAgentEnv(config({ envSourceDir: "/home/dev/app" }));
  assert.equal(env.DISPATCHER_ENV_SOURCE_DIR, "/home/dev/app");
});

test("dispatchAgentEnv passes a bounded recovery reason as data for resumed agents", () => {
  const env = dispatchAgentEnv(config(), "merge conflict in docs/memory.md");
  assert.equal(env.DISPATCHER_RECOVERY_REASON, "merge conflict in docs/memory.md");
  assert.equal(dispatchAgentEnv(config()).DISPATCHER_RECOVERY_REASON, undefined);
});

// ── terminal classification ──────────────────────────────────────────────────

function signals(overrides: Partial<RunSignals> = {}): RunSignals {
  return {
    closeCode: 0,
    sawResult: true,
    resultExit: 0,
    resultCommits: 1,
    resultCi: "pass",
    resultDisposition: "normal",
    tokenExhaustion: null,
    maxRuntimeMinutes: 90,
    ...overrides,
  };
}

const exhaustion: ProviderCapacitySignal = {
  kind: "unconfirmed-quota",
  resetAt: null,
  wallClock: null,
  resetLabel: null,
  excerpt: "usage limit reached",
};

const contextExhaustion: ProviderCapacitySignal = {
  kind: "context-exhaustion",
  resetAt: null,
  wallClock: null,
  resetLabel: null,
  excerpt: "maximum context length exceeded",
};

test("a clean exit with commits and green CI is an honest PR-ready handoff", () => {
  const outcome = classifyRunOutcome(signals());
  assert.equal(outcome.status, "pr_ready");
  assert.equal(outcome.exitCode, 0);
});

test("a clean exit with commits but no PR becomes a repairable failure", () => {
  const provisional = classifyRunOutcome(signals({ resultCommits: 2, resultCi: "none" }));
  assert.equal(provisional.status, "pr_ready");
  const outcome = requirePrForDelivery(provisional, null);
  assert.equal(outcome.status, "failed");
  assert.match(outcome.status === "failed" ? (outcome.summary ?? "") : "", /did not open a pull request/i);
  assert.equal(requirePrForDelivery(provisional, 42).status, "pr_ready");
});

test("token exhaustion beats a generic non-zero exit and is reported as recoverable", () => {
  const outcome = classifyRunOutcome(
    signals({ resultExit: 1, resultCommits: 0, resultCi: "none", tokenExhaustion: exhaustion }),
  );
  assert.equal(outcome.status, "token_exhausted");
});

test("context exhaustion does NOT suppress the provider pool — falls through to the ordinary failure ladder", () => {
  const outcome = classifyRunOutcome(
    signals({ resultExit: 1, resultCommits: 0, resultCi: "none", tokenExhaustion: contextExhaustion }),
  );
  assert.notEqual(outcome.status, "token_exhausted");
  assert.equal(outcome.status, "failed");
});

test("a stray exhaustion match on a CLEAN exit does NOT trip a cooldown", () => {
  // A non-zero exit is required — a clean run that merely echoed a limit phrase must not
  // pause the provider.
  const outcome = classifyRunOutcome(
    signals({ resultExit: 0, resultCommits: 1, resultCi: "pass", tokenExhaustion: exhaustion }),
  );
  assert.equal(outcome.status, "pr_ready");
});

test("exhaustion during a timeout stays a timeout, not a cooldown", () => {
  const outcome = classifyRunOutcome(
    signals({ sawResult: false, closeCode: 124, tokenExhaustion: exhaustion }),
  );
  assert.equal(outcome.status, "timed_out");
});

test("exit code 124 and 137 both classify as timed_out and resumable", () => {
  for (const code of [124, 137]) {
    const outcome = classifyRunOutcome(signals({ sawResult: false, closeCode: code }));
    assert.equal(outcome.status, "timed_out", `code ${code}`);
    assert.match(outcome.status === "timed_out" ? (outcome.summary ?? "") : "", /resume/i);
  }
});

test("signal exits 130 and 143 are interrupted and resumable, not hard failures", () => {
  for (const exitCode of [130, 143]) {
    const outcome = classifyRunOutcome(signals({ resultExit: exitCode }));
    assert.equal(outcome.status, "interrupted");
  }
});

test("a killed run with no result line is interrupted, not failed", () => {
  // The commit/CI defaults (0 commits, no CI) must NOT be read for a blind kill — that
  // would mark resumable work as a hard failure and silently drop it.
  const outcome = classifyRunOutcome(
    signals({ sawResult: false, closeCode: null, resultCommits: 0, resultCi: "none" }),
  );
  assert.equal(outcome.status, "interrupted");
});

test("a clean exit with zero commits is a failure — the agent gave up", () => {
  const outcome = classifyRunOutcome(
    signals({ resultExit: 0, resultCommits: 0, resultCi: "none" }),
  );
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.exitCode, 0);
});

test("a pre-launch closed issue retires without spending the repair ladder", () => {
  const outcome = classifyRunOutcome(
    signals({
      resultDisposition: "abandoned",
      resultCommits: 0,
      resultCi: "none",
    }),
  );
  assert.equal(outcome.status, "abandoned");
  assert.equal(outcome.exitCode, 0);
});

test("a clean exit with commits but red CI is ci_failed, not a plain failure — CI drives the self-heal ladder", () => {
  const outcome = classifyRunOutcome(signals({ resultCi: "fail" }));
  assert.equal(outcome.status, "ci_failed");
});

test("a clean exit with commits and pending CI is parked (ci_pending), not succeeded", () => {
  const outcome = classifyRunOutcome(signals({ resultCi: "pending" }));
  assert.equal(outcome.status, "ci_pending");
  assert.match(outcome.status === "ci_pending" ? (outcome.summary ?? "") : "", /re-check CI/i);
});

test("a plain non-zero exit with a result line is a failure carrying the exit code", () => {
  const outcome = classifyRunOutcome(
    signals({ resultExit: 3, resultCommits: 1, resultCi: "none" }),
  );
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.exitCode, 3);
});

test("the result line's exit code wins over the child's close code", () => {
  // The script may exit 0 overall while its ::result:: reports the agent's own code.
  const outcome = classifyRunOutcome(
    signals({ closeCode: 0, sawResult: true, resultExit: 2, resultCommits: 1, resultCi: "none" }),
  );
  assert.equal(outcome.exitCode, 2);
  assert.equal(outcome.status, "failed");
});

// ── capacity resolution used by the runner at finalization ─────────────────────
//
// `launchRun`'s finish() calls resolveCapacitySuppression directly (see token-exhaustion
// tests for full policy coverage); these confirm the runner's own inputs (the
// RunSignals/observed-run shape) plug into it the way finish() actually calls it.

test("resolveCapacitySuppression reports a reported future reset verbatim, not the fallback wording", () => {
  const now = 1_000_000_000_000;
  const resetAt = now + 3_600_000;
  const resolution = resolveCapacitySuppression(
    "claude",
    { kind: "unconfirmed-quota", resetAt, wallClock: null, resetLabel: "4am (UTC)", excerpt: "" },
    { resultCommits: 0, resultCi: "none", prNumber: null },
    now,
  );
  assert.equal(resolution.status, "token_exhausted");
  assert.equal(resolution.evidence.until, resetAt);
  assert.match(resolution.summary, /Claude/);
  assert.match(resolution.summary, /4am \(UTC\)/);
  assert.doesNotMatch(resolution.summary, /unconfirmed/);
});

test("resolveCapacitySuppression falls back to a bounded window when nothing parses (Codex, non-rolling-window)", () => {
  const now = 1_000_000_000_000;
  const resolution = resolveCapacitySuppression(
    "codex",
    { kind: "unconfirmed-quota", resetAt: null, wallClock: null, resetLabel: null, excerpt: "" },
    { resultCommits: 0, resultCi: "none", prNumber: null },
    now,
  );
  assert.equal(resolution.status, "token_exhausted");
  assert.ok(resolution.evidence.until > now);
  assert.match(resolution.summary, /Codex/);
  assert.match(resolution.summary, /unconfirmed/);
});

// ── failure classification ──────────────────────────────────────────────────────

test("non-zero exit classifies as implementation-failure by default", () => {
  const outcome = classifyRunOutcome(
    signals({ resultExit: 1, resultCommits: 0, resultCi: "none" }),
  );
  assert.equal(outcome.status, "failed");
  assert.equal("classification" in outcome ? outcome.classification?.category : undefined, "implementation-failure");
});

test("interrupted run (no result line) classifies as transient", () => {
  const outcome = classifyRunOutcome(signals({ sawResult: false, closeCode: 143 }));
  assert.equal(outcome.status, "interrupted");
  assert.equal("classification" in outcome ? outcome.classification?.category : undefined, "transient");
});

test("clean exit with zero commits classifies as implementation-failure", () => {
  const outcome = classifyRunOutcome(signals({ resultExit: 0, resultCommits: 0 }));
  assert.equal(outcome.status, "failed");
  assert.equal("classification" in outcome ? outcome.classification?.category : undefined, "implementation-failure");
});

test("context exhaustion provides distinct failure classification", () => {
  const outcome = classifyRunOutcome(
    signals({
      resultExit: 1,
      tokenExhaustion: {
        kind: "context-exhaustion",
        wallClock: null,
        resetAt: null,
        resetLabel: null,
        excerpt: "context window exceeded",
      },
    }),
  );
  assert.equal(outcome.status, "failed");
  assert.equal("classification" in outcome ? outcome.classification?.category : undefined, "context-exhaustion");
});

test("provider capacity signal provides failure classification", () => {
  const outcome = classifyRunOutcome(
    signals({
      resultExit: 1,
      tokenExhaustion: {
        kind: "quota-exhaustion",
        wallClock: null,
        resetAt: null,
        resetLabel: null,
        excerpt: "quota exceeded",
      },
    }),
  );
  assert.equal("classification" in outcome ? outcome.classification?.category : undefined, "usage-limit");
});
