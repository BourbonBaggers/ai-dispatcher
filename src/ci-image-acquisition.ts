/**
 * CI image acquisition — pull production images from CI instead of rebuilding.
 *
 * When a merged commit has passed required CI checks, the CI workflow has already
 * built and tested the exact production images needed. This module decides whether
 * to pull those CI-built images or fall back to a dev-server rebuild.
 *
 * The decision is deterministic and observable:
 * - CI images are used when the complete production image set is available and verified
 * - A fallback build is used only when CI images are unavailable, with a specific reason
 * - Both paths record timing and source (CI vs fallback)
 */

/**
 * Immutable image identity tied to a merged commit SHA.
 * Each production image must be resolvable for the exact merged commit SHA.
 */
export interface ImageDigest {
  /** Image reference (e.g., "ghcr.io/example/service-api") */
  ref: string;
  /** Immutable image digest (e.g., "sha256:abc123...") */
  digest: string;
}

/**
 * The set of production images required for a deployment.
 */
export interface ImageSet {
  /** Merged commit SHA these images were built for */
  mergedSha: string;
  /** Required CI checks that must be passing */
  requiredChecks: readonly string[];
  /** Production images (e.g., API, web, worker) */
  images: readonly ImageDigest[];
}

/**
 * Reason why CI images were unavailable and a fallback is needed.
 */
export type ImageFallbackReason =
  | "ci_images_not_found"
  | "incomplete_image_set"
  | "ci_checks_not_passing"
  | "ci_evidence_unknown"
  | "ghcr_auth_failed"
  | "image_digest_mismatch"
  | "configuration_missing";

/**
 * Result of image selection decision.
 */
export type ImageSelectionResult =
  | { source: "ci"; imageSet: ImageSet; ciElapsedMs: number }
  | { source: "fallback"; reason: ImageFallbackReason; fallbackElapsedMs?: number };

/**
 * GitHub CI image availability. Used to query whether images exist for a SHA.
 * This interface is injected for testability.
 */
export interface CiImageLookup {
  /**
   * Query GitHub for the required image set for a merged SHA.
   * Returns null if CI images are not available or CI checks haven't passed.
   * Specific failure reasons are returned in the fallback path.
   */
  queryImages(mergedSha: string): Promise<ImageSet | null>;

  /**
   * Verify that an image digest matches the expected merged SHA.
   * Returns true only if the image was built for this exact SHA.
   */
  verifyImageSha(image: ImageDigest, expectedSha: string): Promise<boolean>;
}

/**
 * Decide which images to use: CI images if available and verified, otherwise fallback to rebuild.
 * Never throws; all failures return a fallback outcome with a specific reason.
 */
export async function selectImages(
  lookup: CiImageLookup,
  mergedSha: string,
  startTimeMs: number,
): Promise<ImageSelectionResult> {
  try {
    const startLookup = Date.now?.() ?? 0;
    const imageSet = await lookup.queryImages(mergedSha);
    const ciElapsedMs = (Date.now?.() ?? startLookup) - startLookup;

    if (!imageSet) {
      return {
        source: "fallback",
        reason: "ci_images_not_found",
        fallbackElapsedMs: ciElapsedMs,
      };
    }

    // Verify each image digest matches the expected SHA
    const verificationPromises = imageSet.images.map((img) =>
      lookup.verifyImageSha(img, mergedSha).catch(() => false),
    );
    const allVerified = (await Promise.all(verificationPromises)).every(Boolean);

    if (!allVerified) {
      return {
        source: "fallback",
        reason: "image_digest_mismatch",
        fallbackElapsedMs: ciElapsedMs,
      };
    }

    return { source: "ci", imageSet, ciElapsedMs };
  } catch (error) {
    // Any unexpected error falls back to rebuild with a generic reason
    const reason: ImageFallbackReason =
      error instanceof Error && error.message.includes("auth")
        ? "ghcr_auth_failed"
        : "ci_evidence_unknown";
    return { source: "fallback", reason };
  }
}

/**
 * Format the image selection result for structured logging and deployment reporting.
 */
export function formatImageSelectionResult(result: ImageSelectionResult): Record<string, string> {
  if (result.source === "ci") {
    return {
      image_source: "ci",
      image_count: String(result.imageSet.images.length),
      ci_elapsed_ms: String(result.ciElapsedMs),
      merged_sha: result.imageSet.mergedSha,
    };
  }

  return {
    image_source: "fallback",
    fallback_reason: result.reason,
    acquisition_elapsed_ms: String(result.fallbackElapsedMs ?? 0),
  };
}

/**
 * Pure test helper: create a mock image set.
 */
export function createImageSet(
  mergedSha: string,
  imageCount: number = 2,
): ImageSet {
  return {
    mergedSha,
    requiredChecks: ["lint", "test", "build"],
    images: Array.from({ length: imageCount }, (_, i) => ({
      ref: `ghcr.io/example/service-${i}`,
      digest: `sha256:${mergedSha.slice(0, 56)}${i.toString().padStart(8, "0")}`,
    })),
  };
}
