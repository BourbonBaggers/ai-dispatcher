import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_BLOCKED_QUEUE_AUDIT_EFFORT_LABEL,
  DEFAULT_BLOCKED_QUEUE_AUDIT_MAX_CANDIDATES,
  DEFAULT_BLOCKED_QUEUE_AUDIT_MODEL,
  blockedQueueAuditPrompt,
  decideBlockedQueueAudit,
  parseModelAuditVerdict,
  referencedIssueNumbers,
  resolveBlockedQueueAuditConfig,
  selectBlockedQueueAuditCandidates,
} from "../src/blocked-queue.ts";
import { resolveAuthorAuthConfig } from "../src/author-auth.ts";
import type { GithubIssue } from "../src/github.ts";

function issue(number: number, labels: string[], title = `issue ${number}`): GithubIssue {
  return { number, title, url: `https://x/${number}`, labels, authorLogin: "BourbonBaggers" };
}

const queued = [
  "blocked",
  "task:feature",
  "complexity:moderate",
  "risk:medium",
  "context:medium",
  "ambiguity:clear",
  "requirements:good",
  "reasoning:moderate",
  "verification:strong",
  "recoverability:high",
];

test("resolveBlockedQueueAuditConfig defaults to a non-frontier low-effort model", () => {
  const resolved = resolveBlockedQueueAuditConfig(
    DEFAULT_BLOCKED_QUEUE_AUDIT_MODEL,
    DEFAULT_BLOCKED_QUEUE_AUDIT_EFFORT_LABEL,
    DEFAULT_BLOCKED_QUEUE_AUDIT_MAX_CANDIDATES,
  );
  assert.equal(resolved.ok, true);
  if (resolved.ok) {
    assert.equal(resolved.value.model.cliModel, "claude-sonnet-5");
    assert.equal(resolved.value.model.frontier, false);
    assert.equal(resolved.value.effortLabel, "effort:low");
    assert.equal(resolved.value.cliEffort, "low");
  }
});

test("resolveBlockedQueueAuditConfig rejects frontier or unsupported audit configuration", () => {
  const frontier = resolveBlockedQueueAuditConfig("claude-opus-4-8", "effort:low", 1);
  assert.equal(frontier.ok, false);
  if (!frontier.ok) assert.match(frontier.reason, /frontier/);

  const unknown = resolveBlockedQueueAuditConfig("no-such-model", "effort:low", 1);
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.match(unknown.reason, /not known/);

  const effort = resolveBlockedQueueAuditConfig("claude-sonnet-5", "effort:extreme", 1);
  assert.equal(effort.ok, false);
  if (!effort.ok) assert.match(effort.reason, /effort/);
});

test("selectBlockedQueueAuditCandidates is deterministic and skips stronger holds", () => {
  const candidates = selectBlockedQueueAuditCandidates(
    [
      issue(2, queued),
      issue(3, [...queued, "needs-input"]),
      issue(4, [...queued, "autoship-held"]),
      issue(5, ["blocked"]),
      issue(6, queued),
      issue(7, [...queued, "interactive"]),
    ],
    { claimedByIssue: new Map(), maxCandidates: 2 },
  );

  assert.deepEqual(
    candidates.map((candidate) => candidate.issue.number),
    [2, 6],
  );
});

test("selectBlockedQueueAuditCandidates honors author auth and existing claims", () => {
  const candidates = selectBlockedQueueAuditCandidates(
    [
      { ...issue(2, queued), authorLogin: "external" },
      issue(3, queued),
      issue(4, queued),
    ],
    {
      claimedByIssue: new Map([[3, "running"]]),
      maxCandidates: 5,
      authorAuth: resolveAuthorAuthConfig("author-allowlist", "BourbonBaggers"),
    },
  );

  assert.deepEqual(
    candidates.map((candidate) => candidate.issue.number),
    [4],
  );
});

test("referencedIssueNumbers extracts stable unique dependency references", () => {
  assert.deepEqual(
    referencedIssueNumbers("Blocked by #27 and duplicate #27; see #26. Not self #42.", 42),
    [26, 27],
  );
});

test("parseModelAuditVerdict accepts only structured JSON with a rationale", () => {
  assert.deepEqual(parseModelAuditVerdict('{"workable":true,"rationale":"deps closed"}'), {
    ok: true,
    workable: true,
    rationale: "deps closed",
  });
  assert.equal(parseModelAuditVerdict("workable").ok, false);
  assert.equal(parseModelAuditVerdict('{"workable":true}').ok, false);
});

test("decideBlockedQueueAudit requires closed dependency evidence before unblocking", () => {
  const yes = { ok: true as const, workable: true, rationale: "all named blockers are closed" };

  assert.equal(decideBlockedQueueAudit([], yes).action, "keep-blocked");
  assert.equal(
    decideBlockedQueueAudit([{ issueNumber: 26, state: "UNKNOWN" }], yes).action,
    "keep-blocked",
  );
  assert.equal(
    decideBlockedQueueAudit([{ issueNumber: 26, state: "OPEN" }], yes).action,
    "keep-blocked",
  );
  assert.equal(
    decideBlockedQueueAudit([{ issueNumber: 26, state: "CLOSED" }], {
      ok: true,
      workable: false,
      rationale: "body still asks for input",
    }).action,
    "keep-blocked",
  );
  assert.equal(
    decideBlockedQueueAudit([{ issueNumber: 26, state: "CLOSED" }], yes).action,
    "unblock",
  );
});

test("blockedQueueAuditPrompt carries issue data and dependency states as data", () => {
  const prompt = blockedQueueAuditPrompt({
    issue: issue(42, queued, "Recover queue"),
    body: "Depends on #26",
    dependencies: [{ issueNumber: 26, state: "CLOSED" }],
  });
  assert.match(prompt, /Return only minified JSON/);
  assert.match(prompt, /"number":42/);
  assert.match(prompt, /"issueNumber":26/);
});
