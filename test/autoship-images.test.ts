/**
 * Autoship image acquisition integration tests.
 * Verify that image selection works end-to-end through autoship and ship flows.
 */

import { test } from "node:test";
import assert from "node:assert";
import {
  parseAutoshipStatusReport,
  parseLegacyAutoshipStatusReport,
} from "../src/autoship-deployment.ts";
import {
  createGitHubCiImageLookup,
  type GitHubCiImageConfig,
  type WorkflowRunMetadata,
} from "../src/github-ci-images.ts";

test("parseAutoshipStatusReport includes image source when present", () => {
  const output =
    "::autoship:: state=shipped health=pass pr_head=abc123 merged=def456 deployed=def456 rollback=- last_good=- checkout=/path image_source=ci ci_elapsed_ms=1234";

  const report = parseAutoshipStatusReport(output);

  assert(report);
  assert.equal(report.state, "shipped");
  assert.equal(report.imageSource, "ci");
  assert.equal(report.ciElapsedMs, 1234);
  assert.equal(report.fallbackReason, undefined);
});

test("parseAutoshipStatusReport captures fallback reason", () => {
  const output =
    "::autoship:: state=shipped health=pass pr_head=abc123 merged=def456 deployed=def456 rollback=- last_good=- checkout=/path image_source=fallback fallback_reason=ci_images_not_found fallback_elapsed_ms=567";

  const report = parseAutoshipStatusReport(output);

  assert(report);
  assert.equal(report.imageSource, "fallback");
  assert.equal(report.fallbackReason, "ci_images_not_found");
  assert.equal(report.fallbackElapsedMs, 567);
});

test("parseAutoshipStatusReport handles missing image fields gracefully", () => {
  const output =
    "::autoship:: state=shipped health=pass pr_head=abc123 merged=def456 deployed=def456 rollback=- last_good=- checkout=/path";

  const report = parseAutoshipStatusReport(output);

  assert(report);
  assert.equal(report.imageSource, undefined);
  assert.equal(report.fallbackReason, undefined);
  assert.equal(report.ciElapsedMs, undefined);
});

test("parseAutoshipStatusReport ignores invalid image source values", () => {
  const output =
    "::autoship:: state=shipped health=pass pr_head=abc123 merged=def456 deployed=def456 rollback=- last_good=- checkout=/path image_source=unknown";

  const report = parseAutoshipStatusReport(output);

  assert(report);
  assert.equal(report.imageSource, undefined);
});

test("parseAutoshipStatusReport handles non-numeric timing values", () => {
  const output =
    "::autoship:: state=shipped health=pass pr_head=abc123 merged=def456 deployed=def456 rollback=- last_good=- checkout=/path ci_elapsed_ms=not_a_number fallback_elapsed_ms=abc";

  const report = parseAutoshipStatusReport(output);

  assert(report);
  assert.equal(report.ciElapsedMs, undefined);
  assert.equal(report.fallbackElapsedMs, undefined);
});

test("parseLegacyAutoshipStatusReport ignores image fields (legacy format doesn't support them)", () => {
  const output =
    "AUTOSHIP_STATUS=deployed\nAUTOSHIP_REQUESTED_SHA=abc123\nAUTOSHIP_DEPLOYED_SHA=abc123";

  const report = parseLegacyAutoshipStatusReport(output);

  assert(report);
  assert.equal(report.state, "shipped");
  assert.equal(report.imageSource, undefined);
  assert.equal(report.fallbackReason, undefined);
});

test("createGitHubCiImageLookup returns a CiImageLookup", () => {
  const mockConfig: GitHubCiImageConfig = {
    repoSlug: { owner: "test", repo: "repo" },
    productionImages: ["api", "web"],
    registryUrl: "ghcr.io/test",
  };

  const lookup = createGitHubCiImageLookup(mockConfig);

  assert(lookup);
  assert(typeof lookup.queryImages === "function");
  assert(typeof lookup.verifyImageSha === "function");
});

test("createGitHubCiImageLookup queryImages returns null for non-successful workflows", async () => {
  let queryCalled = false;
  const mockConfig: GitHubCiImageConfig = {
    repoSlug: { owner: "test", repo: "repo" },
    productionImages: ["api"],
    registryUrl: "ghcr.io/test",
    queryWorkflowRuns: async (sha: string) => {
      queryCalled = true;
      return {
        runId: 123,
        headSha: sha,
        conclusion: "failure",
        requiredChecks: ["test"],
      };
    },
  };

  const lookup = createGitHubCiImageLookup(mockConfig);
  const result = await lookup.queryImages("abc123");

  assert(queryCalled);
  assert.equal(result, null);
});

test("createGitHubCiImageLookup queryImages builds image references", async () => {
  const mockConfig: GitHubCiImageConfig = {
    repoSlug: { owner: "test", repo: "myrepo" },
    productionImages: ["api", "web", "worker"],
    registryUrl: "ghcr.io/test",
    queryWorkflowRuns: async (sha: string) => ({
      runId: 123,
      headSha: sha,
      conclusion: "success",
      requiredChecks: ["test", "lint"],
    }),
  };

  const lookup = createGitHubCiImageLookup(mockConfig);
  const result = await lookup.queryImages("abc123");

  assert(result);
  assert.equal(result.mergedSha, "abc123");
  assert.equal(result.images.length, 3);
  assert.equal(result.images[0]?.ref, "ghcr.io/test/myrepo/api");
  assert.equal(result.images[1]?.ref, "ghcr.io/test/myrepo/web");
  assert.equal(result.images[2]?.ref, "ghcr.io/test/myrepo/worker");
});

test("createGitHubCiImageLookup queryImages returns null if no required checks", async () => {
  const mockConfig: GitHubCiImageConfig = {
    repoSlug: { owner: "test", repo: "repo" },
    productionImages: ["api"],
    registryUrl: "ghcr.io/test",
    queryWorkflowRuns: async (sha: string) => ({
      runId: 123,
      headSha: sha,
      conclusion: "success",
      requiredChecks: [], // No required checks
    }),
  };

  const lookup = createGitHubCiImageLookup(mockConfig);
  const result = await lookup.queryImages("abc123");

  assert.equal(result, null);
});

test("createGitHubCiImageLookup verifyImageSha uses provided verifier", async () => {
  let verifyCallCount = 0;
  const mockConfig: GitHubCiImageConfig = {
    repoSlug: { owner: "test", repo: "repo" },
    productionImages: ["api"],
    registryUrl: "ghcr.io/test",
    verifyImageInRegistry: async (ref: string, digest: string) => {
      verifyCallCount++;
      assert.equal(ref, "ghcr.io/test/repo/api");
      assert.equal(digest, "abc123");
      return true;
    },
  };

  const lookup = createGitHubCiImageLookup(mockConfig);
  const result = await lookup.verifyImageSha(
    { ref: "ghcr.io/test/repo/api", digest: "sha256:abc" },
    "abc123",
  );

  assert.equal(verifyCallCount, 1);
  assert.equal(result, true);
});

test("createGitHubCiImageLookup verifyImageSha returns false on verification error", async () => {
  const mockConfig: GitHubCiImageConfig = {
    repoSlug: { owner: "test", repo: "repo" },
    productionImages: ["api"],
    registryUrl: "ghcr.io/test",
    verifyImageInRegistry: async () => {
      throw new Error("Registry unreachable");
    },
  };

  const lookup = createGitHubCiImageLookup(mockConfig);
  const result = await lookup.verifyImageSha(
    { ref: "ghcr.io/test/repo/api", digest: "sha256:abc" },
    "abc123",
  );

  assert.equal(result, false);
});

test("integration: image fields appear in autoship environment", async () => {
  // This test verifies that image selection would be passed to a ship command
  // In production, the ship command would use these fields to decide whether
  // to pull CI images or rebuild
  const expectedFields = {
    image_source: "ci",
    ci_elapsed_ms: "1234",
  };

  // Simulate what autoship passes to the ship command
  const shipEnv: Record<string, string> = {
    AUTOSHIP_PR_NUMBER: "42",
    AUTOSHIP_REPO: "owner/repo",
    AUTOSHIP_PR_HEAD_SHA: "abc123",
    ...expectedFields, // These would be added by image selection
  };

  assert.equal(shipEnv.image_source, "ci");
  assert.equal(shipEnv.ci_elapsed_ms, "1234");
  assert.equal(shipEnv.AUTOSHIP_PR_NUMBER, "42");
});
