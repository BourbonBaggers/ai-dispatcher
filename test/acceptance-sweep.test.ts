import test from "node:test";
import assert from "node:assert/strict";
import { auditShippedIssue, followUpLabels, type AuditDeps } from "../src/acceptance-sweep.ts";
import { AUDIT_FOLLOWUP_LABEL, auditDepthLabel, type CriterionVerdict } from "../src/acceptance-audit.ts";
import { DISPATCH_READY_LABEL } from "../src/labels.ts";
import type { GithubPrDiff, GithubPrFile } from "../src/github.ts";

const ISSUE_BODY = ["## Acceptance criteria", "- [ ] A label exists", "- [ ] Tests cover it"].join("\n");

interface Harness {
  deps: AuditDeps;
  created: { title: string; body: string; labels: readonly string[] }[];
  comments: { issue: number; body: string }[];
  marked: (number | null)[];
  pushes: { title: string; priority: number }[];
  judged: Parameters<AuditDeps["judge"]>[0][];
  /** GitHub reads and judge calls, in the order they started. */
  calls: string[];
}

function harness(opts: {
  verdicts?: CriterionVerdict[];
  issueBody?: string | null;
  labels?: string[] | null;
  /** A string is a readable diff and null an unreadable one; anything else is used as is. */
  diff?: string | null | GithubPrDiff;
  files?: GithubPrFile[] | null;
  openFollowUps?: { number: number; body: string }[] | null;
  createFails?: boolean;
} = {}): Harness {
  const created: Harness["created"] = [];
  const comments: Harness["comments"] = [];
  const marked: Harness["marked"] = [];
  const pushes: Harness["pushes"] = [];
  const judged: Harness["judged"] = [];
  const calls: string[] = [];
  const diff: GithubPrDiff =
    opts.diff === undefined
      ? { state: "ok", diff: "+export const x = 1;" }
      : opts.diff === null
        ? { state: "unavailable", error: "HTTP 502: Bad Gateway" }
        : typeof opts.diff === "string"
          ? { state: "ok", diff: opts.diff }
          : opts.diff;
  return {
    created,
    comments,
    marked,
    pushes,
    judged,
    calls,
    deps: {
      github: {
        issueBody: async () => {
          calls.push("issueBody");
          return opts.issueBody === undefined ? ISSUE_BODY : opts.issueBody;
        },
        issueLabels: async () => {
          calls.push("issueLabels");
          return opts.labels === undefined ? [] : opts.labels;
        },
        prDiff: async () => {
          calls.push("prDiff");
          return diff;
        },
        prFiles: async () => {
          calls.push("prFiles");
          return opts.files === undefined ? [] : opts.files;
        },
        comment: async (issue, body) => {
          comments.push({ issue, body });
          return true;
        },
        createIssue: async (request) => {
          if (opts.createFails) return null;
          created.push(request);
          return 91;
        },
        issuesWithLabel: async () => {
          calls.push("issuesWithLabel");
          return opts.openFollowUps === undefined ? [] : opts.openFollowUps;
        },
      },
      judge: async (request) => {
        calls.push("judge");
        judged.push(request);
        return opts.verdicts ?? [];
      },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      notifier: { send: async (title, _b, priority = 3) => { pushes.push({ title, priority }); } },
      markAudited: (_subject, followUp) => marked.push(followUp),
    },
  };
}

const subject = { issueNumber: 82, issueTitle: "Add a label", prNumber: 83 };

test("a clean audit marks the run and files nothing", async () => {
  const h = harness({
    verdicts: [
      { criterion: "A label exists", result: "addressed" },
      { criterion: "Tests cover it", result: "unclear" },
    ],
  });
  const outcome = await auditShippedIssue(h.deps, subject);
  assert.equal(outcome.action, "clean");
  assert.deepEqual(h.marked, [null]);
  assert.equal(h.created.length, 0);
});

test("an issue with no acceptance criteria is skipped without invoking anything", async () => {
  const h = harness({ issueBody: "## Problem\n- just prose" });
  const outcome = await auditShippedIssue(h.deps, subject);
  assert.equal(outcome.action, "skipped");
  assert.deepEqual(h.marked, [null]);
});

test("a confident cited omission files a follow-up and comments on the parent", async () => {
  const h = harness({
    verdicts: [{ criterion: "Tests cover it", result: "not_addressed", citation: "no test files in the diff" }],
  });
  const outcome = await auditShippedIssue(h.deps, subject);

  assert.equal(outcome.action, "filed");
  assert.equal(h.created.length, 1);
  assert.match(h.created[0]!.body, /Audit follow-up for #82/);
  assert.deepEqual(h.created[0]!.labels, [AUDIT_FOLLOWUP_LABEL, auditDepthLabel(1), DISPATCH_READY_LABEL]);
  // The parent is closed and stays closed; the residual is queued work, not a hold.
  assert.equal(h.comments[0]!.issue, 82);
  assert.match(h.comments[0]!.body, /#91/);
  // Marked BEFORE the parent comment, and with the created issue recorded for dedupe.
  assert.deepEqual(h.marked, [91]);
});

test("labels on a follow-up are constants, never derived from judge text", () => {
  assert.deepEqual(followUpLabels(1), [AUDIT_FOLLOWUP_LABEL, auditDepthLabel(1), DISPATCH_READY_LABEL]);
});

// Re-running the sweep over the same shipped issue must not multiply queued work.
test("an existing open follow-up is commented on instead of duplicated", async () => {
  const h = harness({
    verdicts: [{ criterion: "Tests cover it", result: "not_addressed", citation: "still missing" }],
    openFollowUps: [{ number: 77, body: "Audit follow-up for #82 — Add a label" }],
  });
  const outcome = await auditShippedIssue(h.deps, subject);
  assert.equal(outcome.action, "commented");
  assert.equal(h.created.length, 0);
  assert.equal(h.comments[0]!.issue, 77);
});

test("a follow-up for a different parent does not suppress filing", async () => {
  const h = harness({
    verdicts: [{ criterion: "Tests cover it", result: "not_addressed", citation: "still missing" }],
    openFollowUps: [{ number: 77, body: "Audit follow-up for #999 — something else" }],
  });
  assert.equal((await auditShippedIssue(h.deps, subject)).action, "filed");
});

// "Could not tell" must never be read as "none exists" — that is how duplicates happen.
test("a failed follow-up search stands down without filing or marking", async () => {
  const h = harness({
    verdicts: [{ criterion: "Tests cover it", result: "not_addressed", citation: "missing" }],
    openFollowUps: null,
  });
  const outcome = await auditShippedIssue(h.deps, subject);
  assert.equal(outcome.action, "unavailable");
  assert.equal(h.created.length, 0);
  assert.deepEqual(h.marked, []);
  // Searched before judging, so the failure costs no verdict a retry would re-buy (#98).
  assert.equal(h.judged.length, 0);
});

test("unreadable issue or PR evidence retries later rather than claiming an omission", async () => {
  for (const opts of [{ issueBody: null }, { labels: null }, { diff: null }]) {
    const h = harness(opts);
    const outcome = await auditShippedIssue(h.deps, subject);
    assert.equal(outcome.action, "unavailable");
    assert.deepEqual(h.marked, [], "an unreadable audit must stay pending");
  }
});

test("a failed issue creation leaves the run pending for the next sweep", async () => {
  const h = harness({
    verdicts: [{ criterion: "Tests cover it", result: "not_addressed", citation: "missing" }],
    createFails: true,
  });
  const outcome = await auditShippedIssue(h.deps, subject);
  assert.equal(outcome.action, "unavailable");
  assert.deepEqual(h.marked, []);
});

// The depth cap is the ONLY path in this design that involves a human.
test("auditing a follow-up that still shows an omission notifies instead of filing", async () => {
  const h = harness({
    verdicts: [{ criterion: "Tests cover it", result: "not_addressed", citation: "still missing" }],
    labels: [AUDIT_FOLLOWUP_LABEL, auditDepthLabel(1)],
  });
  const outcome = await auditShippedIssue(h.deps, subject);
  assert.equal(outcome.action, "notified");
  assert.equal(h.created.length, 0);
  assert.equal(h.pushes.length, 1);
  assert.deepEqual(h.marked, [null]);
});

// ── #98: every read before the judge, and a fallback for a diff GitHub refuses ──

test("no judge call happens when any evidence read fails (#98)", async () => {
  for (const opts of [
    { issueBody: null },
    { labels: null },
    { diff: null },
    { diff: { state: "too_large" as const, error: "HTTP 406" }, files: null },
    { openFollowUps: null },
  ]) {
    const h = harness({
      ...opts,
      verdicts: [{ criterion: "Tests cover it", result: "not_addressed", citation: "missing" }],
    });
    const outcome = await auditShippedIssue(h.deps, subject);
    assert.equal(outcome.action, "unavailable", JSON.stringify(opts));
    assert.equal(h.judged.length, 0, JSON.stringify(opts));
    assert.deepEqual(h.marked, []);
  }
});

test("every read, the follow-up search included, finishes before the judge runs (#98)", async () => {
  const h = harness({ verdicts: [{ criterion: "A label exists", result: "addressed" }] });
  assert.equal((await auditShippedIssue(h.deps, subject)).action, "clean");
  const judgedAt = h.calls.indexOf("judge");
  assert.equal(judgedAt, h.calls.length - 1);
  for (const read of ["issueBody", "issueLabels", "prDiff", "issuesWithLabel"]) {
    assert.ok(h.calls.includes(read), read);
  }
  assert.equal(h.judged[0]!.evidence, "diff");
});

test("an unavailable outcome names what could not be read (#98)", async () => {
  const h = harness({ labels: null, diff: { state: "unavailable", error: "HTTP 404: Not Found" } });
  assert.deepEqual(await auditShippedIssue(h.deps, subject), {
    action: "unavailable",
    reason: "could not read issue labels, PR diff (HTTP 404: Not Found)",
  });
});

test("an issue without criteria is settled before any PR evidence is read (#98)", async () => {
  const h = harness({ issueBody: "## Problem\n- just prose", diff: null });
  assert.equal((await auditShippedIssue(h.deps, subject)).action, "skipped");
  assert.deepEqual(h.marked, [null]);
  assert.deepEqual(h.calls, ["issueBody"]);
});

// #737 in production: GitHub refuses any diff over 300 files, permanently. The files API
// still lists the PR, and its file list is evidence a judge can read.
test("a diff refused as too large is audited from the PR's changed-file list (#98)", async () => {
  const h = harness({
    diff: {
      state: "too_large",
      error: "could not find pull request diff: HTTP 406: Sorry, the diff exceeded the maximum number of files (300).",
    },
    files: [
      {
        filename: "scripts/lib/plan-discovery.sh",
        status: "modified",
        additions: 12,
        deletions: 3,
        patch: "@@ -1,3 +1,12 @@\n+delete_finished_plan() {",
      },
      { filename: "docs/plans/2026-06-12-old.md", status: "removed", additions: 0, deletions: 96 },
    ],
    verdicts: [
      { criterion: "A label exists", result: "addressed" },
      { criterion: "Tests cover it", result: "unclear" },
    ],
  });

  const outcome = await auditShippedIssue(h.deps, subject);

  assert.equal(outcome.action, "clean");
  assert.deepEqual(h.marked, [null]);
  assert.equal(h.judged.length, 1);
  const request = h.judged[0]!;
  assert.equal(request.evidence, "changed-files");
  assert.match(request.diff, /removed \+0\/-96 docs\/plans\/2026-06-12-old\.md/);
  assert.match(request.diff, /diff --git a\/scripts\/lib\/plan-discovery\.sh b\/scripts\/lib\/plan-discovery\.sh\n@@/);
  assert.match(request.diff, /\+delete_finished_plan\(\) \{/);
});

test("an empty changed-file list for a too-large diff is unreadable, not clean (#98)", async () => {
  const h = harness({ diff: { state: "too_large", error: "HTTP 406" }, files: [] });
  const outcome = await auditShippedIssue(h.deps, subject);
  assert.deepEqual(outcome, {
    action: "unavailable",
    reason: "could not read PR changed-file list (its diff is too large)",
  });
  assert.equal(h.judged.length, 0);
});
