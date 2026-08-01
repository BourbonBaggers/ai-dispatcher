import { test } from "node:test";
import assert from "node:assert";
import {
  selectImages,
  formatImageSelectionResult,
  createImageSet,
  type CiImageLookup,
  type ImageSet,
} from "../src/ci-image-acquisition.ts";

test("selectImages — CI images available", async () => {
  const mergedSha = "abc1234567890abcdef";
  const imageSet = createImageSet(mergedSha, 2);

  const lookup: CiImageLookup = {
    queryImages: async () => imageSet,
    verifyImageSha: async () => true,
  };

  const result = await selectImages(lookup, mergedSha, 0);

  assert.equal(result.source, "ci");
  assert(result.source === "ci");
  assert.equal(result.imageSet.mergedSha, mergedSha);
  assert.equal(result.imageSet.images.length, 2);
  assert(result.ciElapsedMs >= 0);
});

test("selectImages — CI images not found", async () => {
  const lookup: CiImageLookup = {
    queryImages: async () => null,
    verifyImageSha: async () => true,
  };

  const result = await selectImages(lookup, "abc1234567890abcdef", 0);

  assert.equal(result.source, "fallback");
  assert(result.source === "fallback");
  assert.equal(result.reason, "ci_images_not_found");
});

test("selectImages — image digest mismatch", async () => {
  const mergedSha = "abc1234567890abcdef";
  const imageSet = createImageSet(mergedSha, 1);

  const lookup: CiImageLookup = {
    queryImages: async () => imageSet,
    verifyImageSha: async () => false, // Verification fails
  };

  const result = await selectImages(lookup, mergedSha, 0);

  assert.equal(result.source, "fallback");
  assert(result.source === "fallback");
  assert.equal(result.reason, "image_digest_mismatch");
});

test("selectImages — partial verification failure", async () => {
  const mergedSha = "abc1234567890abcdef";
  const imageSet = createImageSet(mergedSha, 3);

  let callCount = 0;
  const lookup: CiImageLookup = {
    queryImages: async () => imageSet,
    verifyImageSha: async () => {
      callCount++;
      return callCount === 2; // Second image fails verification
    },
  };

  const result = await selectImages(lookup, mergedSha, 0);

  assert.equal(result.source, "fallback");
  assert(result.source === "fallback");
  assert.equal(result.reason, "image_digest_mismatch");
});

test("selectImages — lookup throws error", async () => {
  const lookup: CiImageLookup = {
    queryImages: async () => {
      throw new Error("Network error");
    },
    verifyImageSha: async () => true,
  };

  const result = await selectImages(lookup, "abc1234567890abcdef", 0);

  assert.equal(result.source, "fallback");
  assert(result.source === "fallback");
  assert.equal(result.reason, "ci_evidence_unknown");
});

test("selectImages — GHCR auth error", async () => {
  const lookup: CiImageLookup = {
    queryImages: async () => {
      throw new Error("GHCR authentication failed");
    },
    verifyImageSha: async () => true,
  };

  const result = await selectImages(lookup, "abc1234567890abcdef", 0);

  assert.equal(result.source, "fallback");
  assert(result.source === "fallback");
  assert.equal(result.reason, "ghcr_auth_failed");
});

test("formatImageSelectionResult — CI source", () => {
  const imageSet = createImageSet("abc1234567890abcdef", 2);
  const result = { source: "ci" as const, imageSet, ciElapsedMs: 1234 };

  const formatted = formatImageSelectionResult(result);

  assert.equal(formatted.image_source, "ci");
  assert.equal(formatted.image_count, "2");
  assert.equal(formatted.ci_elapsed_ms, "1234");
  assert.equal(formatted.merged_sha, "abc1234567890abcdef");
});

test("formatImageSelectionResult — fallback source", () => {
  const result = { source: "fallback" as const, reason: "ci_images_not_found" as const, fallbackElapsedMs: 567 };

  const formatted = formatImageSelectionResult(result);

  assert.equal(formatted.image_source, "fallback");
  assert.equal(formatted.fallback_reason, "ci_images_not_found");
  assert.equal(formatted.acquisition_elapsed_ms, "567");
  assert.equal(Object.keys(formatted).length, 3);
});

test("createImageSet — default image count", () => {
  const imageSet = createImageSet("abc1234567890abcdef");

  assert.equal(imageSet.mergedSha, "abc1234567890abcdef");
  assert.equal(imageSet.images.length, 2);
  assert.equal(imageSet.requiredChecks.length, 3);
});

test("createImageSet — custom image count", () => {
  const imageSet = createImageSet("abc1234567890abcdef", 5);

  assert.equal(imageSet.images.length, 5);
  imageSet.images.forEach((img, i) => {
    assert(img.ref.includes(`service-${i}`));
    assert(img.digest.startsWith("sha256:"));
  });
});
