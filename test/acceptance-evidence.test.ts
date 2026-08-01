import { test } from "node:test";
import assert from "node:assert/strict";
import {
  acceptanceRepairReason,
  assessAcceptanceEvidence,
  extractAcceptanceCriteria,
} from "../src/acceptance-evidence.ts";

const issue = [
  "## Desired behavior",
  "- The card-paid workflow must deliver an invoice to the customer",
  "- Payment-menu labels must describe the new payment flow",
].join("\n");

test("extracts explicit business criteria from a desired-behavior section", () => {
  assert.deepEqual(extractAcceptanceCriteria(issue), [
    "The card-paid workflow must deliver an invoice to the customer",
    "Payment-menu labels must describe the new payment flow",
  ]);
});

test("regression: catches an explicit omission and an unattempted menu-label criterion", () => {
  const result = assessAcceptanceEvidence(
    issue,
    "The card-paid path does not send an invoice to the customer.\n\nTests for payment processing pass.",
  );
  assert.equal(result.status, "fail");
  assert.deepEqual(result.findings.map((finding) => finding.reason), ["contradicted", "not_attempted"]);
  assert.match(acceptanceRepairReason(result), /invoice/);
  assert.match(acceptanceRepairReason(result), /Payment-menu labels/);
});

test("accepts reasonable implementation evidence without requiring exact prose", () => {
  const result = assessAcceptanceEvidence(
    issue,
    "sendCustomerInvoice(cardPayment);\nconst paymentMenuLabels = createCardPaymentLabels();",
  );
  assert.equal(result.status, "pass");
  assert.equal(result.findings.length, 0);
});

test("does not invent a failure when no explicit criteria or evidence can be read", () => {
  assert.equal(assessAcceptanceEvidence("A short bug report", "some diff").status, "insufficient");
  assert.equal(assessAcceptanceEvidence(issue, "").status, "insufficient");
});

test("ignores generic acceptance prose and bounds issue scanning", () => {
  const result = assessAcceptanceEvidence(
    "## Acceptance criteria\n- The implementation must include tests and support the feature\n" + "x".repeat(100_000),
    "tests and feature support",
  );
  assert.equal(result.status, "insufficient");
});

test("does not turn problem narrative or regression fixtures into criteria", () => {
  const issueWithNarrative = [
    "## Problem",
    "- The issue required customer invoice delivery, but the old implementation omitted it",
    "## Desired behavior",
    "- The card-paid workflow must deliver an invoice to the customer",
    "## Regression test",
    "- The candidate implementation explicitly omits customer invoice delivery",
  ].join("\n");
  assert.deepEqual(extractAcceptanceCriteria(issueWithNarrative), [
    "The card-paid workflow must deliver an invoice to the customer",
  ]);
});

test("ignores business nouns used in evaluator policy prose", () => {
  const issueWithPolicy = [
    "## Desired behavior",
    "- The issue author should describe the business outcome in normal business terms",
    "- Avoid requiring risky external actions, such as sending a real Stripe invoice",
    "- The card-paid workflow must deliver an invoice to the customer",
  ].join("\n");
  assert.deepEqual(extractAcceptanceCriteria(issueWithPolicy), [
    "The card-paid workflow must deliver an invoice to the customer",
  ]);
});
