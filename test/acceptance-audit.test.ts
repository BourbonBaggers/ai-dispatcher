import test from "node:test";
import assert from "node:assert/strict";
import {
  AUDIT_DEPTH_LABEL_PREFIX,
  auditDepth,
  decideAudit,
  followUpIssueBody,
  parseJudgeVerdicts,
  parentClosureComment,
} from "../src/acceptance-audit.ts";

const criteria = ["A label exists", "Migration does not add it", "Tests cover it"];

test("parses a well-formed verdict array", () => {
  const raw = JSON.stringify([
    { index: 0, result: "addressed" },
    { index: 1, result: "not_addressed", citation: "no change to the migration path" },
    { index: 2, result: "unclear" },
  ]);
  assert.deepEqual(parseJudgeVerdicts(raw, criteria), [
    { criterion: "A label exists", result: "addressed" },
    { criterion: "Migration does not add it", result: "not_addressed", citation: "no change to the migration path" },
    { criterion: "Tests cover it", result: "unclear" },
  ]);
});

test("prose or a code fence around the array does not defeat parsing", () => {
  const raw = 'Here you go:\n```json\n[{"index": 0, "result": "addressed"}]\n```\nDone.';
  assert.equal(parseJudgeVerdicts(raw, ["A label exists"])[0]!.result, "addressed");
});

// Every failure mode must land on `unclear`. The judge can only create work by making a
// confident, cited claim — never by emitting malformed output.
test("unparseable, missing, and unknown results all degrade to unclear", () => {
  for (const raw of ["not json at all", "", "[{}]", '[{"index": 0, "result": "definitely_broken"}]']) {
    const verdicts = parseJudgeVerdicts(raw, criteria);
    assert.equal(verdicts.length, 3);
    assert.ok(verdicts.every((v) => v.result === "unclear"), `expected all unclear for ${JSON.stringify(raw)}`);
  }
});

test("a not_addressed verdict without a citation degrades to unclear", () => {
  const raw = JSON.stringify([{ index: 0, result: "not_addressed" }]);
  assert.equal(parseJudgeVerdicts(raw, ["A label exists"])[0]!.result, "unclear");
});

test("a blank citation is not a citation", () => {
  const raw = JSON.stringify([{ index: 0, result: "not_addressed", citation: "   " }]);
  assert.equal(parseJudgeVerdicts(raw, ["A label exists"])[0]!.result, "unclear");
});

test("auditDepth reads the depth label, defaulting to zero", () => {
  assert.equal(auditDepth([]), 0);
  assert.equal(auditDepth(["type:bug", `${AUDIT_DEPTH_LABEL_PREFIX}1`]), 1);
  assert.equal(auditDepth([`${AUDIT_DEPTH_LABEL_PREFIX}nonsense`]), 0);
});

test("no confident omission files nothing", () => {
  const decision = decideAudit({
    parentIssue: 82,
    parentDepth: 0,
    verdicts: [
      { criterion: "a", result: "addressed" },
      { criterion: "b", result: "unclear" },
    ],
  });
  assert.equal(decision.action, "none");
});

test("a confident cited omission files a depth-1 follow-up", () => {
  const decision = decideAudit({
    parentIssue: 82,
    parentDepth: 0,
    verdicts: [{ criterion: "b", result: "not_addressed", citation: "nothing found" }],
  });
  assert.equal(decision.action, "file");
  assert.equal(decision.action === "file" ? decision.depth : null, 1);
});

// Without this the loop files issues forever: every follow-up is itself auditable.
test("depth beyond the cap notifies instead of filing more work", () => {
  const decision = decideAudit({
    parentIssue: 90,
    parentDepth: 1,
    verdicts: [{ criterion: "b", result: "not_addressed", citation: "nothing found" }],
  });
  assert.equal(decision.action, "notify");
});

test("an existing open follow-up is commented on, never duplicated", () => {
  const decision = decideAudit({
    parentIssue: 82,
    parentDepth: 0,
    existingFollowUp: 91,
    verdicts: [{ criterion: "b", result: "not_addressed", citation: "nothing found" }],
  });
  assert.equal(decision.action, "comment_existing");
  assert.equal(decision.action === "comment_existing" ? decision.issue : null, 91);
});

test("dedupe wins over the depth cap, so a capped repeat still cannot duplicate", () => {
  const decision = decideAudit({
    parentIssue: 90,
    parentDepth: 5,
    existingFollowUp: 91,
    verdicts: [{ criterion: "b", result: "not_addressed", citation: "nothing found" }],
  });
  assert.equal(decision.action, "comment_existing");
});

test("the follow-up body carries the marker, the criteria, and permission to close unchanged", () => {
  const body = followUpIssueBody(
    82,
    "Add an interactive-ownership label",
    [{ criterion: "Migration does not add it", result: "not_addressed", citation: "no migration change" }],
    1,
  );
  assert.match(body, /Audit follow-up for #82/);
  assert.match(body, /- \[ \] Migration does not add it/);
  assert.match(body, /no migration change/);
  // The boomerang guard: an agent that finds the work already done must have a sanctioned
  // way to say so, or it will invent changes to justify the run.
  assert.match(body, /close this issue with a comment/i);
  assert.match(body, /make no code changes/i);
  assert.match(body, /Audit depth: 1/);
});

test("the parent closure comment links the follow-up and lists the residual", () => {
  const comment = parentClosureComment(91, [{ criterion: "Migration does not add it", result: "not_addressed" }]);
  assert.match(comment, /#91/);
  assert.match(comment, /Migration does not add it/);
});
