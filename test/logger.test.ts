import { test } from "node:test";
import assert from "node:assert/strict";
import { createLogger } from "../src/logger.ts";

function capturing(level: Parameters<typeof createLogger>[0]) {
  const lines: string[] = [];
  const logger = createLogger(level, (l) => lines.push(l));
  return { logger, lines };
}

test("a logger at info suppresses debug but emits info/warn/error", () => {
  const { logger, lines } = capturing("info");
  logger.debug("hidden");
  logger.info("shown");
  logger.warn("warned");
  logger.error("failed");
  const levels = lines.map((l) => JSON.parse(l).level);
  assert.deepEqual(levels, ["info", "warn", "error"]);
});

test("a logger at error emits only errors", () => {
  const { logger, lines } = capturing("error");
  logger.debug("no");
  logger.info("no");
  logger.warn("no");
  logger.error("yes");
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]!).level, "error");
});

test("each record is one JSON line carrying the message and any fields", () => {
  const { logger, lines } = capturing("debug");
  logger.info("launching agent", { runId: "r1", issue: 42 });
  const record = JSON.parse(lines[0]!);
  assert.equal(record.level, "info");
  assert.equal(record.msg, "launching agent");
  assert.equal(record.runId, "r1");
  assert.equal(record.issue, 42);
  assert.equal(typeof record.ts, "string");
});
