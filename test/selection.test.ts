import { test } from "node:test";
import assert from "node:assert/strict";
import { selectEligibleIssue, type SelectionContext } from "../src/selection.ts";
import { resolveAuthorAuthConfig } from "../src/author-auth.ts";
import type { GithubIssue } from "../src/github.ts";

function issue(
  number: number,
  labels: string[],
  title = `issue ${number}`,
  authorLogin = "BourbonBaggers",
): GithubIssue {
  return { number, title, url: `https://x/${number}`, labels, authorLogin };
}

function ctx(overrides: Partial<SelectionContext> = {}): SelectionContext {
  return {
    providerSuppressed: () => false,
    suppressedReason: (a) => `${a} is out of tokens`,
    claimedByIssue: new Map(),
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

test("author-allowlist permits trusted authors and normalizes usernames", () => {
  const { target } = selectEligibleIssue(
    [issue(1, CODEX, "issue 1", "BourbonBaggers")],
    ctx({ authorAuth: resolveAuthorAuthConfig("author-allowlist", " bourbonbaggers ") }),
  );

  assert.equal(target?.issue.number, 1);
});

test("author-allowlist blocks untrusted authors before labels can make an issue eligible", () => {
  const { target, candidates } = selectEligibleIssue(
    [issue(1, [...CODEX, "queue jump"], "issue 1", "external-user")],
    ctx({ authorAuth: resolveAuthorAuthConfig("author-allowlist", "BourbonBaggers") }),
  );

  assert.equal(target, null);
  assert.match(candidates[0]!.reason, /untrusted issue author/);
});

test("author-allowlist fails closed when trusted authors are missing or malformed", () => {
  for (const authorAuth of [
    resolveAuthorAuthConfig("author-allowlist", undefined),
    resolveAuthorAuthConfig("author-allowlist", "bad login"),
  ]) {
    const { target, candidates } = selectEligibleIssue([issue(1, CODEX)], ctx({ authorAuth }));
    assert.equal(target, null);
    assert.match(candidates[0]!.reason, /trusted GitHub usernames/);
  }
});

test("none author auth mode preserves unrestricted author behavior", () => {
  const { target } = selectEligibleIssue(
    [issue(1, CODEX, "issue 1", "external-user")],
    ctx({ authorAuth: resolveAuthorAuthConfig("none", undefined) }),
  );

  assert.equal(target?.issue.number, 1);
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
  const { target, candidates } = selectEligibleIssue([issue(1, CLAUDE), issue(2, CODEX)], context);
  assert.equal(target?.issue.number, 2); // codex still flows
  assert.match(candidates.find((c) => c.issueNumber === 1)!.reason, /out of tokens/);
});

test("an issue with an existing claiming run is skipped, not restarted", () => {
  const context = ctx({ claimedByIssue: new Map([[1, "interrupted"]]) });
  const { target, candidates } = selectEligibleIssue([issue(1, CLAUDE)], context);
  assert.equal(target, null);
  assert.match(candidates[0]!.reason, /already has a interrupted dispatcher run/);
});

test("staleWorkingLabel is surfaced on the chosen target", () => {
  const { target } = selectEligibleIssue([issue(1, [...CODEX, "agent-working"])], ctx());
  assert.equal(target?.staleWorkingLabel, true);
});
