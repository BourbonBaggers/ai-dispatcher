import { test } from "node:test";
import assert from "node:assert/strict";
import { selectEligibleIssue, type SelectionContext } from "../src/selection.ts";
import type { GithubIssue } from "../src/github.ts";

function issue(number: number, labels: string[], title = `issue ${number}`): GithubIssue {
  return { number, title, url: `https://x/${number}`, labels };
}

function ctx(overrides: Partial<SelectionContext> = {}): SelectionContext {
  return {
    providerSuppressed: () => false,
    suppressedReason: (a) => `${a} is out of tokens`,
    claimedByIssue: new Map(),
    deferredByIssue: new Map(),
    ...overrides,
  };
}

const CLAUDE = ["agent:claude", "model:claude-opus-4.8"];
const CODEX = ["agent:codex", "model:gpt-5.5"];

test("picks the oldest eligible issue when tiers are equal", () => {
  const { target } = selectEligibleIssue([issue(3, CLAUDE), issue(5, CODEX)], ctx());
  assert.equal(target?.issue.number, 3);
});

test("queue-jump beats regular beats technical-debt regardless of age", () => {
  const issues = [
    issue(1, [...CLAUDE, "technical debt"]),
    issue(2, CODEX), // regular
    issue(3, [...CLAUDE, "queue jump"]),
  ];
  const { target } = selectEligibleIssue(issues, ctx());
  assert.equal(target?.issue.number, 3); // queue jump first

  // Remove the queue-jump issue: the regular one wins over technical debt.
  const { target: t2 } = selectEligibleIssue(issues.slice(0, 2), ctx());
  assert.equal(t2?.issue.number, 2);
});

test("an ineligible high-priority issue does not block a lower tier", () => {
  const issues = [
    issue(1, [...CLAUDE, "queue jump", "needs-input"]), // held
    issue(2, CODEX), // regular, eligible
  ];
  const { target, candidates } = selectEligibleIssue(issues, ctx());
  assert.equal(target?.issue.number, 2);
  assert.equal(candidates.find((c) => c.issueNumber === 1)?.eligible, false);
});

test("unlabelled / conflicting issues are ineligible with a reason", () => {
  const { target, candidates } = selectEligibleIssue(
    [issue(1, []), issue(2, ["agent:claude", "agent:codex", "model:gpt-5.5"])],
    ctx(),
  );
  assert.equal(target, null);
  assert.equal(candidates[0]!.reason, "no agent:* label");
  assert.match(candidates[1]!.reason, /conflicting agent labels/);
});

test("held (needs-input / blocked) issues are skipped", () => {
  for (const hold of ["needs-input", "blocked"]) {
    const { target, candidates } = selectEligibleIssue([issue(1, [...CLAUDE, hold])], ctx());
    assert.equal(target, null);
    assert.match(candidates[0]!.reason, /held for a human/);
  }
});

test("a suppressed provider makes its issues ineligible but not the other provider's", () => {
  const context = ctx({
    providerSuppressed: (a) => a === "claude",
    suppressedReason: () => "Claude is out of tokens — paused until 4am",
  });
  const { target, candidates } = selectEligibleIssue(
    [issue(1, CLAUDE), issue(2, CODEX)],
    context,
  );
  assert.equal(target?.issue.number, 2); // codex still flows
  assert.match(candidates.find((c) => c.issueNumber === 1)!.reason, /out of tokens/);
});

test("an issue with an existing claiming run is skipped, not restarted", () => {
  const context = ctx({ claimedByIssue: new Map([[1, "interrupted"]]) });
  const { target, candidates } = selectEligibleIssue([issue(1, CLAUDE)], context);
  assert.equal(target, null);
  assert.match(candidates[0]!.reason, /already has a interrupted dispatcher run/);
});

test("a deferred issue is skipped with the supplied reason", () => {
  const context = ctx({ deferredByIssue: new Map([[1, "deferred after 3 matching failures"]]) });
  const { target, candidates } = selectEligibleIssue([issue(1, CODEX)], context);
  assert.equal(target, null);
  assert.equal(candidates[0]!.reason, "deferred after 3 matching failures");
});

test("staleWorkingLabel is surfaced on the chosen target", () => {
  const { target } = selectEligibleIssue([issue(1, [...CODEX, "agent-working"])], ctx());
  assert.equal(target?.staleWorkingLabel, true);
});
