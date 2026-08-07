import test from "node:test";
import assert from "node:assert/strict";
import { extractAcceptanceCriteria } from "../src/acceptance-criteria.ts";

test("extracts every checklist item under an acceptance heading", () => {
  const issue = [
    "# Title",
    "",
    "## Problem",
    "- this is context, not a criterion",
    "",
    "## Acceptance criteria",
    "",
    "- [ ] A label exists and is exported",
    "- [x] Migration does not add `dispatch:ready` to it",
    "1. Tests cover the audit path",
    "",
    "## Notes",
    "- not a criterion either",
  ].join("\n");

  assert.deepEqual(extractAcceptanceCriteria(issue), [
    "A label exists and is exported",
    "Migration does not add `dispatch:ready` to it",
    "Tests cover the audit path",
  ]);
});

test("a deeper sub-heading stays inside the section; a sibling closes it", () => {
  const issue = [
    "## Acceptance criteria",
    "- one",
    "### Sub-group",
    "- two",
    "## Notes",
    "- three",
  ].join("\n");
  assert.deepEqual(extractAcceptanceCriteria(issue), ["one", "two"]);
});

test("definition of done and success criteria are recognized headings", () => {
  assert.deepEqual(extractAcceptanceCriteria("## Definition of done\n- ship it"), ["ship it"]);
  assert.deepEqual(extractAcceptanceCriteria("### Success criteria\n- measure it"), ["measure it"]);
});

test("prose under the heading is context, not a criterion", () => {
  const issue = ["## Acceptance criteria", "All of the following must hold:", "- the real one"].join("\n");
  assert.deepEqual(extractAcceptanceCriteria(issue), ["the real one"]);
});

test("an issue with no acceptance section yields nothing", () => {
  assert.deepEqual(extractAcceptanceCriteria("## Problem\n- a bullet\n\n## Proposal\n- another"), []);
});

// The removed pre-merge gate (#84) filtered criteria down to those containing "business"
// nouns, because a verdict could block a merge and the set had to be kept small. The audit
// files follow-up work instead of blocking, so it looks at every stated criterion —
// including the operational ones that filter used to discard.
test("operational criteria are extracted, not filtered out", () => {
  const issue = [
    "## Acceptance criteria",
    "- [ ] Autoship no longer calls the acceptance check before merge",
    "- [ ] The dispatcher never adds or removes it in any code path",
  ].join("\n");
  assert.equal(extractAcceptanceCriteria(issue).length, 2);
});

test("duplicates collapse and whitespace is normalized", () => {
  const issue = ["## Acceptance criteria", "- same    item", "- same item", "- other"].join("\n");
  assert.deepEqual(extractAcceptanceCriteria(issue), ["same item", "other"]);
});
