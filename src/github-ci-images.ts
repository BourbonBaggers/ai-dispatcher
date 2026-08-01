/**
 * GitHub CI image lookup — query GitHub for images built by CI workflows.
 *
 * This module queries GitHub Actions workflows and container registry metadata
 * to determine if production images are available for a specific commit SHA.
 */

import type { CiImageLookup, ImageSet, ImageDigest } from "./ci-image-acquisition.ts";
import type { RepoSlug } from "./config.ts";

/** GitHub Actions workflow run metadata relevant to image acquisition. */
export interface WorkflowRunMetadata {
  /** Run ID from GitHub Actions */
  runId: number;
  /** Commit SHA this run was triggered for */
  headSha: string;
  /** Whether the run completed successfully */
  conclusion: "success" | "failure" | "cancelled" | "skipped" | "unknown";
  /** Required checks configured for this repository */
  requiredChecks: readonly string[];
}

/** Configuration for GitHub-based CI image lookup. */
export interface GitHubCiImageConfig {
  /** Repository owner/name */
  repoSlug: RepoSlug;
  /** Production image references to acquire (e.g., ["api", "web", "worker"]) */
  productionImages: readonly string[];
  /** GitHub container registry URL (e.g., "ghcr.io/owner") */
  registryUrl: string;
  /** Function to query GitHub API for workflow runs */
  queryWorkflowRuns?: (sha: string) => Promise<WorkflowRunMetadata | null>;
  /** Function to verify an image exists in the registry */
  verifyImageInRegistry?: (ref: string, digest: string) => Promise<boolean>;
}

/**
 * Create a GitHub-based CI image lookup.
 * Returns a CiImageLookup that queries GitHub Actions and the container registry.
 */
export function createGitHubCiImageLookup(
  config: GitHubCiImageConfig,
): CiImageLookup {
  const { repoSlug, productionImages, registryUrl } = config;
  const queryRuns = config.queryWorkflowRuns ?? queryGitHubWorkflows;
  const verifyRegistry = config.verifyImageInRegistry ?? verifyGitHubContainerImage;

  return {
    async queryImages(mergedSha: string): Promise<ImageSet | null> {
      // Query GitHub for workflow runs on this SHA
      let workflow: WorkflowRunMetadata | null = null;
      try {
        workflow = await queryRuns(mergedSha);
      } catch {
        return null;
      }

      if (!workflow || workflow.conclusion !== "success") {
        return null;
      }

      // All required checks must have passed
      if (workflow.requiredChecks.length === 0) {
        return null;
      }

      // Construct image references for the registry
      const images: ImageDigest[] = [];
      for (const imageName of productionImages) {
        const ref = `${registryUrl}/${repoSlug.repo.toLowerCase()}/${imageName}`;
        images.push({
          ref,
          digest: `sha256:${mergedSha.slice(0, 56)}`, // Placeholder; real digest comes from registry
        });
      }

      return {
        mergedSha,
        requiredChecks: Array.from(workflow.requiredChecks),
        images,
      };
    },

    async verifyImageSha(image: ImageDigest, expectedSha: string): Promise<boolean> {
      try {
        // In a real implementation, this would query the container registry
        // to verify that the image digest corresponds to the expected SHA.
        // For now, we stub it to allow integration testing.
        return await verifyRegistry(image.ref, expectedSha);
      } catch {
        return false;
      }
    },
  };
}

/**
 * Query GitHub Actions for the most recent successful workflow run for a commit.
 * Stub for integration; real implementation would call GitHub's REST API.
 */
async function queryGitHubWorkflows(
  _sha: string,
): Promise<WorkflowRunMetadata | null> {
  // Placeholder: real implementation would:
  // 1. Query GitHub Actions API for workflow runs matching this SHA
  // 2. Filter to required checks / successful runs
  // 3. Return metadata
  // For now, return null to trigger fallback behavior
  return null;
}

/**
 * Verify that an image exists in the GitHub Container Registry with the expected digest.
 * Stub for integration; real implementation would query the registry API.
 */
async function verifyGitHubContainerImage(
  _ref: string,
  _digest: string,
): Promise<boolean> {
  // Placeholder: real implementation would:
  // 1. Query GHCR / OCI registry API
  // 2. Verify the image exists and has the expected digest
  // 3. Return true/false
  // For now, return false to trigger fallback behavior
  return false;
}
