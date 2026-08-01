import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyCiReadiness,
  classifyMissingChecksAfterGrace,
} from "../src/ci-readiness.ts";

describe("CI readiness classification", () => {
  it("repairs a PR with no checks", () => {
    assert.deepEqual(
      classifyCiReadiness({ checks: "unknown", checkCount: 0, mergeState: "clean" }),
      { kind: "repair", reason: "checks-missing" },
    );
  });

  it("repairs conflicts and stale bases before considering CI", () => {
    assert.deepEqual(
      classifyCiReadiness({ checks: "unknown", checkCount: 0, mergeState: "conflicted" }),
      { kind: "repair", reason: "merge-conflict" },
    );
    assert.deepEqual(
      classifyCiReadiness({ checks: "pending", checkCount: 1, mergeState: "behind" }),
      { kind: "repair", reason: "stale-base" },
    );
  });

  it("keeps a genuinely pending workflow pending", () => {
    assert.deepEqual(
      classifyCiReadiness({ checks: "pending", checkCount: 2, mergeState: "clean" }),
      { kind: "pending", reason: "checks-running" },
    );
  });

  it("allows delayed workflow creation once, then repairs durable absence", () => {
    const observation = { checks: "unknown" as const, checkCount: 0, mergeState: "clean" as const };
    assert.deepEqual(classifyMissingChecksAfterGrace(observation, null, 1000, 300), {
      kind: "pending", reason: "workflow-delayed",
    });
    assert.deepEqual(classifyMissingChecksAfterGrace(observation, 1000, 1301, 300), {
      kind: "repair", reason: "checks-missing",
    });
  });
});
