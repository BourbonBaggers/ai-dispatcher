import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dispatchAgentArgs,
  dispatchAgentEnv,
  classifyRunOutcome,
  tokenExhaustionSummary,
  DISPATCH_AGENT_SCRIPT,
  type AgentLaunchSpec,
  type RunSignals,
} from "../src/runner.ts";
import type { DispatcherConfig } from "../src/config.ts";
import { resolveAuthorAuthConfig } from "../src/author-auth.ts";
import type { TokenExhaustionSignal } from "../src/token-exhaustion.ts";
import { existsSync } from "node:fs";

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
    autoshipDeploymentDir: "/home/dev/state/autoship-deployments/acme-widgets",
    generatedConflictAllowlist: ["docs/memory.md", "docs/researcher.md"],
    generatedConflictRegenCmd: null,
    generatedConflictMaxAttempts: 1,
    generatedConflictCiWaitSeconds: 900,
    ciSelfHealMaxAttempts: 2,
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
});

test("dispatchAgentEnv omits the env-source dir when none is configured, sets it when present", () => {
  assert.equal("DISPATCHER_ENV_SOURCE_DIR" in dispatchAgentEnv(config()), false);
  const env = dispatchAgentEnv(config({ envSourceDir: "/home/dev/app" }));
  assert.equal(env.DISPATCHER_ENV_SOURCE_DIR, "/home/dev/app");
});

// ── terminal classification ──────────────────────────────────────────────────

function signals(overrides: Partial<RunSignals> = {}): RunSignals {
  return {
    closeCode: 0,
    sawResult: true,
    resultExit: 0,
    resultCommits: 1,
    resultCi: "pass",
    tokenExhaustion: null,
    maxRuntimeMinutes: 90,
    ...overrides,
  };
}

const exhaustion: TokenExhaustionSignal = { resetAt: null, wallClock: null, resetLabel: null };

test("a clean exit with commits and green CI succeeds", () => {
  const outcome = classifyRunOutcome(signals());
  assert.equal(outcome.status, "succeeded");
  assert.equal(outcome.exitCode, 0);
});

test("token exhaustion beats a generic non-zero exit and is reported as recoverable", () => {
  const outcome = classifyRunOutcome(
    signals({ resultExit: 1, resultCommits: 0, resultCi: "none", tokenExhaustion: exhaustion }),
  );
  assert.equal(outcome.status, "token_exhausted");
});

test("a stray exhaustion match on a CLEAN exit does NOT trip a cooldown", () => {
  // A non-zero exit is required — a clean run that merely echoed a limit phrase must not
  // pause the provider.
  const outcome = classifyRunOutcome(
    signals({ resultExit: 0, resultCommits: 1, resultCi: "pass", tokenExhaustion: exhaustion }),
  );
  assert.equal(outcome.status, "succeeded");
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

test("a clean exit with commits but red CI is a failure — CI is the deciding vote", () => {
  const outcome = classifyRunOutcome(signals({ resultCi: "fail" }));
  assert.equal(outcome.status, "failed");
});

test("a clean exit with commits and pending CI succeeds but is flagged unverified", () => {
  const outcome = classifyRunOutcome(signals({ resultCi: "pending" }));
  assert.equal(outcome.status, "succeeded");
  assert.match(outcome.status === "succeeded" ? (outcome.summary ?? "") : "", /unverified/i);
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

// ── token-exhaustion summary + cooldown window ────────────────────────────────

test("tokenExhaustionSummary uses a reported future reset verbatim", () => {
  const now = 1_000_000_000_000;
  const resetAt = now + 3_600_000;
  const { summary, until } = tokenExhaustionSummary(
    "claude",
    { resetAt, wallClock: null, resetLabel: "4am (UTC)" },
    now,
  );
  assert.equal(until.getTime(), resetAt);
  assert.match(summary, /Claude is out of tokens/);
  assert.match(summary, /4am \(UTC\)/);
  assert.doesNotMatch(summary, /safety fallback/);
});

test("tokenExhaustionSummary falls back to the safety window when nothing parses", () => {
  const now = 1_000_000_000_000;
  const { summary, until } = tokenExhaustionSummary(
    "codex",
    { resetAt: null, wallClock: null, resetLabel: null },
    now,
  );
  assert.ok(until.getTime() > now);
  assert.match(summary, /Codex is out of tokens/);
  assert.match(summary, /safety fallback/);
});
