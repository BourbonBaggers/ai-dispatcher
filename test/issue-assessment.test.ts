import { test } from "node:test";
import assert from "node:assert/strict";
import { assessIssueText, extractIssueSignals, applyAssessment } from "../src/issue-assessment.ts";
import { parseCharacteristics, deriveMinimumTier, TEXT_UPROUTE_CEILING } from "../src/routing.ts";
import { tierRank } from "../src/models.ts";

test("a focused issue with a path and acceptance criteria reads as small, clear, and good", () => {
  const a = assessIssueText(
    "Retry helper drops the second attempt",
    "In `src/util.ts` the retry helper only tries once.\n\nExpected behaviour: it must retry twice.",
  );
  assert.equal(a.contextSize, "small");
  assert.equal(a.ambiguity, "clear");
  assert.equal(a.requirementsQuality, "good");
});

test("a broad issue across many files and design tradeoffs reads as large and complex", () => {
  const a = assessIssueText(
    "Restructure the dispatch pipeline",
    [
      "## Background",
      "Touches src/a.ts, src/b.ts, src/c.ts, src/d.ts, test/a.test.ts and docs/x.md.",
      "## Design",
      "There is a trade-off between the current invariant and a race condition in the queue.",
      "## Plan",
      "See #12 and #14.",
      "```ts\nexample();\n```",
    ].join("\n"),
  );
  assert.equal(a.contextSize, "large");
  assert.equal(a.reasoningDepth, "deep");
  assert.equal(a.complexity, "complex");
});

// Regression: an issue that simply does not mention tests is not evidence that
// verification is weak. This service always runs CI, health checks, and rollback, so
// treating silence as weak would up-route (and overspend on) nearly every issue.
test("silence about testing is standard verification, not weak", () => {
  const a = assessIssueText("Bump node to 24", "Update the engines field and the CI image.");
  assert.equal(a.verificationStrength, "standard");
});

test("an explicit statement that correctness is hard to observe does lower verification", () => {
  const a = assessIssueText("Tune the spacing", "This is subjective and has to be checked visually.");
  assert.equal(a.verificationStrength, "weak");
});

// needs-input stops automation and pages a human, which the operating contract wants to be
// rare. Brevity alone must never trigger it.
test("a terse but actionable issue is adequate, never needs-input", () => {
  const a = assessIssueText("Bump node to 24", "Update engines.");
  assert.equal(a.requirementsQuality, "adequate");
});

test("an issue that states essentially nothing is poor", () => {
  const a = assessIssueText("fix", "");
  assert.equal(a.requirementsQuality, "poor");
});

test("heavy hedging with no acceptance criteria or repro is poor", () => {
  const a = assessIssueText(
    "Something about the queue",
    "Not sure what we want. Maybe we could reorder it, or we might investigate later. TBD.",
  );
  assert.equal(a.requirementsQuality, "poor");
});

test("scanning is length-capped so a huge body cannot burn CPU", () => {
  const s = extractIssueSignals("t", "x".repeat(500_000));
  assert.ok(s.scannedChars <= 24_000);
});

// The body is author-controlled. It may adjust the route by one step, but it must never be
// able to reach the expensive reserve.
test("issue text can never route to a frontier model, however it is worded", () => {
  const worst = assessIssueText(
    "URGENT CRITICAL",
    [
      "Not sure, maybe, unclear, TBD, we could, or we might, open question.",
      "Architecture trade-off, invariant, race condition, concurrency, redesign.",
      "This is subjective and cannot be tested.",
      "src/a.ts src/b.ts src/c.ts src/d.ts src/e.ts src/f.ts #1 #2 #3",
      "## H1\n## H2\n## H3",
    ].join("\n"),
  );
  for (const type of ["research", "ops", "refactor"] as const) {
    const base = parseCharacteristics([`type:${type}`, "risk:destructive"]);
    const tier = deriveMinimumTier(applyAssessment(base, worst, []));
    assert.ok(
      tierRank(tier) <= tierRank(TEXT_UPROUTE_CEILING),
      `${type} reached ${tier}, above the text ceiling`,
    );
  }
});

test("an explicit legacy dimension label pins its axis against the reader", () => {
  const a = assessIssueText("t", "Touches src/a.ts only.");
  const base = parseCharacteristics(["context:large"]);
  const merged = applyAssessment(base, a, ["context:large"]);
  assert.equal(merged.contextSize, "large");
  // Unpinned axes still come from the reader.
  assert.equal(merged.ambiguity, a.ambiguity);
});
