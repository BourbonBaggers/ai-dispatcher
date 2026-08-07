import test from "node:test";
import assert from "node:assert/strict";
import { auditShippedIssue, followUpLabels, type AuditDeps } from "../src/acceptance-sweep.ts";
import { AUDIT_FOLLOWUP_LABEL, auditDepthLabel, type CriterionVerdict } from "../src/acceptance-audit.ts";
import { DISPATCH_READY_LABEL } from "../src/labels.ts";

const ISSUE_BODY = ["## Acceptance criteria", "- [ ] A label exists", "- [ ] Tests cover it"].join("\n");

interface Harness {
  deps: AuditDeps;
  created: { title: string; body: string; labels: readonly string[] }[];
  comments: { issue: number; body: string }[];
  marked: (number | null)[];
  pushes: { title: string; priority: number }[];
}

function harness(opts: {
  verdicts?: CriterionVerdict[];
  issueBody?: string | null;
  labels?: string[] | null;
  diff?: string | null;
  openFollowUps?: { number: number; body: string }[] | null;
  createFails?: boolean;
} = {}): Harness {
  const created: Harness["created"] = [];
  const comments: Harness["comments"] = [];
  const marked: Harness["marked"] = [];
  const pushes: Harness["pushes"] = [];
  return {
    created,
    comments,
    marked,
    pushes,
    deps: {
      github: {
        issueBody: async () => (opts.issueBody === undefined ? ISSUE_BODY : opts.issueBody),
        issueLabels: async () => (opts.labels === undefined ? [] : opts.labels),
        prDiff: async () => (opts.diff === undefined ? "+export const x = 1;" : opts.diff),
        comment: async (issue, body) => {
          comments.push({ issue, body });
          return true;
        },
        createIssue: async (request) => {
          if (opts.createFails) return null;
          created.push(request);
          return 91;
        },
        issuesWithLabel: async () => (opts.openFollowUps === undefined ? [] : opts.openFollowUps),
      },
      judge: async () => opts.verdicts ?? [],
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
