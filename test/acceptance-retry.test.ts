import test from "node:test";
import assert from "node:assert/strict";
import {
  AUDIT_MAX_ATTEMPTS,
  AUDIT_RETRY_DELAYS_MS,
  auditAfterFailure,
  auditDue,
  auditRetryDelayMs,
  creationFailureSignature,
  type AuditState,
} from "../src/acceptance-retry.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const SHIPPED_AT = 1_000_000;

/** A record exactly as releases before #98 wrote it when a run shipped. */
const legacyPending: AuditState = { status: "pending", at: SHIPPED_AT };

test("backoff grows 5 minutes, 30 minutes, 2 hours, then daily", () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6].map(auditRetryDelayMs),
    [5 * MINUTE, 30 * MINUTE, 2 * HOUR, 24 * HOUR, 24 * HOUR, 24 * HOUR],
  );
  assert.equal(AUDIT_RETRY_DELAYS_MS.at(-1), 24 * HOUR);
  assert.equal(auditRetryDelayMs(0), 5 * MINUTE, "a nonsense count clamps to the first delay");
});

test("a legacy pending record is due at once and nothing is counted as spent", () => {
  assert.equal(auditDue(legacyPending, SHIPPED_AT), true);
  assert.equal(legacyPending.attempts, undefined);
});

test("an audit is not due before its next attempt time and is due from then on", () => {
  const backedOff = auditAfterFailure(legacyPending, { reason: "unreadable" }, SHIPPED_AT);
  assert.equal(backedOff.nextAttemptAt, SHIPPED_AT + 5 * MINUTE);
  assert.equal(auditDue(backedOff, SHIPPED_AT + 1), false);
  assert.equal(auditDue(backedOff, SHIPPED_AT + 5 * MINUTE - 1), false);
  assert.equal(auditDue(backedOff, SHIPPED_AT + 5 * MINUTE), true);
  assert.equal(auditDue(backedOff, SHIPPED_AT + 6 * HOUR), true);
});

test("only pending audits are ever due", () => {
  assert.equal(auditDue(undefined, SHIPPED_AT), false);
  assert.equal(auditDue({ status: "done", at: SHIPPED_AT }, SHIPPED_AT), false);
  assert.equal(
    auditDue({ status: "unavailable", at: SHIPPED_AT, attempts: 6, reason: "x" }, SHIPPED_AT * 10),
    false,
  );
});

// A next time further out than any delay the policy produces was written under a clock
// that has since moved backwards. Waiting for it could strand the audit for months.
test("a next attempt time beyond the longest backoff is treated as due", () => {
  const skewed: AuditState = { status: "pending", attempts: 1, nextAttemptAt: SHIPPED_AT + 30 * 24 * HOUR };
  assert.equal(auditDue(skewed, SHIPPED_AT), true);
  const ordinary: AuditState = { status: "pending", attempts: 4, nextAttemptAt: SHIPPED_AT + 24 * HOUR };
  assert.equal(auditDue(ordinary, SHIPPED_AT), false);
});

test("a failed attempt keeps the audit pending, counts it, and records why", () => {
  const next = auditAfterFailure(legacyPending, { reason: "issue body could not be read" }, 2_000_000);
  assert.deepEqual(next, {
    status: "pending",
    at: SHIPPED_AT,
    attempts: 1,
    nextAttemptAt: 2_000_000 + 5 * MINUTE,
    reason: "issue body could not be read",
  });
});

test("consecutive failures back off with increasing delays and the sixth is terminal", () => {
  let audit: AuditState = legacyPending;
  let now = SHIPPED_AT;
  const waits: number[] = [];
  for (let attempt = 1; attempt < AUDIT_MAX_ATTEMPTS; attempt += 1) {
    audit = auditAfterFailure(audit, { reason: "PR diff could not be read" }, now);
    assert.equal(audit.status, "pending");
    assert.equal(audit.attempts, attempt);
    waits.push(audit.nextAttemptAt! - now);
    now = audit.nextAttemptAt!;
  }
  assert.deepEqual(waits, [5 * MINUTE, 30 * MINUTE, 2 * HOUR, 24 * HOUR, 24 * HOUR]);

  const terminal = auditAfterFailure(audit, { reason: "PR diff could not be read" }, now);
  assert.equal(terminal.status, "unavailable");
  assert.equal(terminal.attempts, AUDIT_MAX_ATTEMPTS);
  assert.equal(terminal.reason, "gave up after 6 attempts: PR diff could not be read");
  assert.equal(terminal.nextAttemptAt, undefined);
  assert.equal(auditDue(terminal, now + 365 * 24 * HOUR), false, "terminal is never retried");
});

test("a signed failure repeated on the next attempt is permanent", () => {
  const failure = { reason: "follow-up issue could not be created", signature: "could not add label" };
  const first = auditAfterFailure(legacyPending, failure, SHIPPED_AT);
  assert.equal(first.status, "pending");
  assert.equal(first.failureSignature, "could not add label");

  const second = auditAfterFailure(first, failure, first.nextAttemptAt!);
  assert.equal(second.status, "unavailable");
  assert.equal(second.attempts, 2);
  assert.equal(second.reason, "failed the same way twice: follow-up issue could not be created");
});

test("a different or unsigned failure in between means it did not fail the same way twice", () => {
  const signed = { reason: "create failed", signature: "a" };
  const first = auditAfterFailure(legacyPending, signed, SHIPPED_AT);

  const different = auditAfterFailure(first, { reason: "create failed", signature: "b" }, SHIPPED_AT + HOUR);
  assert.equal(different.status, "pending");
  assert.equal(different.failureSignature, "b");

  const unsigned = auditAfterFailure(first, { reason: "issue labels could not be read" }, SHIPPED_AT + HOUR);
  assert.equal(unsigned.status, "pending");
  assert.equal(unsigned.failureSignature, undefined, "only the latest failure is compared");
  assert.equal(auditAfterFailure(unsigned, signed, SHIPPED_AT + 2 * HOUR).status, "pending");
});

test("a creation failure signature is gh's normalized error text", () => {
  const signature = creationFailureSignature("could not add label: 'audit-followup' not found\n");
  assert.equal(signature, "could not add label: 'audit-followup' not found");
  assert.equal(
    creationFailureSignature("Could not add label:   'audit-followup'\n not found"),
    signature,
    "case and whitespace differences are the same failure",
  );
  assert.notEqual(creationFailureSignature("could not add label: 'audit:depth-1' not found"), signature);
  assert.ok(creationFailureSignature("x".repeat(1000))!.length <= 300);
});

// Two outages in a row are not proof the request can never succeed; the cap bounds them.
test("transient or empty creation errors never carry a signature", () => {
  for (const error of [
    "",
    "   \n",
    "API rate limit exceeded for user ID 1234.",
    "You have exceeded a secondary rate limit and have been temporarily blocked",
    "HTTP 502: Bad Gateway (https://api.github.com/graphql)",
    "Post \"https://api.github.com/graphql\": net/http: TLS handshake timeout",
    "dial tcp: lookup api.github.com: no such host",
    "read tcp 10.0.0.2:51514->140.82.112.6:443: read: connection reset by peer",
    "unexpected EOF",
  ]) {
    assert.equal(creationFailureSignature(error), undefined, error);
  }
});
