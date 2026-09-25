import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseClaudeTokenFromEnvFile,
  parseClaudeUsage,
  parseCodexRateLimits,
} from "../src/capacity-adapters.ts";

const NOW = 1_800_000_000_000;

test("parseClaudeUsage normalizes generic and model-specific windows", () => {
  const parsed = parseClaudeUsage(
    {
      five_hour: { utilization: 25, resets_at: "2027-01-15T10:00:00Z" },
      seven_day: { utilization: 60, resets_at: "2027-01-20T10:00:00Z" },
      seven_day_opus: { utilization: 90, resets_at: "2027-01-20T10:00:00Z" },
    },
    NOW,
  );
  assert.equal(parsed?.confidence, "provider-reported");
  assert.equal(parsed?.windows.length, 3);
  assert.deepEqual(parsed?.windows[2]?.modelLabels, [
    "model:claude-opus-5-5",
    "model:claude-opus-5",
    "model:claude-opus-4.8",
  ]);
  assert.equal(parsed?.windows[0]?.usedPercent, 25);
});

test("parseCodexRateLimits selects the Codex snapshot and converts reset seconds", () => {
  const parsed = parseCodexRateLimits(
    {
      rateLimitsByLimitId: {
        other: { primary: { usedPercent: 1, resetsAt: 1_900_000_000 } },
        codex: {
          limitId: "codex",
          primary: { usedPercent: 35, resetsAt: 1_900_000_000 },
          secondary: { usedPercent: 70, resetsAt: 1_900_100_000 },
        },
      },
    },
    NOW,
  );
  assert.equal(parsed?.confidence, "cli-reported");
  assert.equal(parsed?.windows[0]?.usedPercent, 35);
  assert.equal(parsed?.windows[0]?.resetAt, 1_900_000_000_000);
  assert.equal(parsed?.windows[1]?.usedPercent, 70);
});

test("capacity parsers reject malformed or out-of-range utilization", () => {
  assert.equal(parseClaudeUsage({ five_hour: { utilization: 101 } }, NOW), null);
  assert.equal(
    parseCodexRateLimits({ rateLimits: { primary: { usedPercent: -1 } } }, NOW),
    null,
  );
});

test("Claude credential-file parser accepts inert assignments only", () => {
  assert.equal(
    parseClaudeTokenFromEnvFile(
      "# private\nexport CLAUDE_CODE_OAUTH_TOKEN='oauth-example-token'\n",
    ),
    "oauth-example-token",
  );
  assert.equal(
    parseClaudeTokenFromEnvFile("CLAUDE_CODE_OAUTH_TOKEN=$(steal-secret)"),
    null,
  );
  assert.equal(parseClaudeTokenFromEnvFile("OTHER_TOKEN=value"), null);
});
