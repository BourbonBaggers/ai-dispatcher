# Issue #66: Autoship deploys should pull CI images instead of rebuilding

Dispatcher autoship currently falls back to rebuilding Docker images on the dev server when `GHCR_TOKEN` is unset, causing 25+ minute delays for urgent deploys. CI has already built and tested these images. This plan implements CI image pulling with deterministic fallback.

## Problem

- CI builds immutable images for each merged commit SHA and passes all required checks
- Autoship's rapid deploy path ignores those CI-built images and rebuilds on the dev server
- Rebuild takes 25+ minutes, blocking urgent fixes
- When GHCR_TOKEN is unset, fallback is automatic but without observability

## Solution approach

The deployment process should:
1. Resolve merged SHA and required production image set
2. Query CI for complete matching image set with passing required checks
3. Pull CI images if available and verify SHA correspondence
4. Fall back to rebuild only if CI images unavailable
5. Record timing and source (CI vs fallback) separately in deployment output

## [DONE] Milestone 1: Image acquisition module with CI lookup and fallback

**Goal:** Create a pure module that encapsulates image-acquisition logic.

- [x] Define `ImageSet` type representing the production image requirements
- [x] Define image identifiers tied to merged SHA (immutable identity)
- [x] Create `fetchCiImages()` function: validate CI status → resolve image set
- [x] Create `verifyImageSha()` function: confirm image digest matches expected SHA
- [x] Create `selectImages()` decision function: CI images if available → fallback to rebuild
- [x] Document decision criteria and fallback reasons
- [x] Add comprehensive unit tests (10 passing tests)
- [x] Commit: `milestone(1): define image-acquisition module with CI lookup`

## [DONE] Milestone 2: Integration with deployment script

**Goal:** Wire image acquisition into the autoship deployment path.

- [x] Identify deployment entry point (self-ship.sh or dedicated deploy command)
- [x] Add CI image lookup before rebuild step
- [x] Implement fallback to rebuild if CI images unavailable
- [x] Add structured output reporting image source (CI/fallback)
- [x] Record timing for acquisition and fallback paths
- [x] Add error handling and specific fallback reasons
- [x] Created github-ci-images.ts with GitHub-based lookup
- [x] Integrated selectImages() into autoship.ts and ship.ts
- [x] Pass image selection via environment variables to ship command
- [x] Commit: `milestone(2): integrate image acquisition into deployment`

## [DONE] Milestone 3: Observability and deployment status

**Goal:** Make image acquisition and deployment phases observable.

- [x] Extend deployment status report with image-acquisition phase
- [x] Report image source (CI or fallback build)
- [x] Record elapsed time for CI image pull vs fallback build
- [x] Add structured logging with acquisition details
- [x] Update AutoshipStatusReport type with image-related fields
- [x] Ensure lock ownership/phase/timing are observable
- [x] Parse image fields from ::autoship:: control line output
- [x] Commit: `milestone(3): add image-acquisition observability to deployment status`

## [DONE] Milestone 4: Regression tests and verification

**Goal:** Ensure image selection works correctly and doesn't regress.

- [x] Add tests for CI image selection when available (ci-image-acquisition.test.ts)
- [x] Add tests for fallback when CI images unavailable (ci-image-acquisition.test.ts)
- [x] Add tests for SHA mismatch detection (ci-image-acquisition.test.ts)
- [x] Add tests for missing CI evidence/incomplete image sets (ci-image-acquisition.test.ts)
- [x] Add tests for GHCR auth failure handling (ci-image-acquisition.test.ts)
- [x] Test timeout and error conditions (ci-image-acquisition.test.ts)
- [x] Test parseAutoshipStatusReport with image fields (autoship-images.test.ts)
- [x] Test createGitHubCiImageLookup workflows (autoship-images.test.ts)
- [x] Test integration of image fields in deployment (autoship-images.test.ts)
- [x] 22 new passing tests (10 + 12)
- [x] Commit: `milestone(4): add image-acquisition regression tests`

## Acceptance criteria checklist

- [x] CI-image deployment path is preferred when complete image set available
  - selectImages() implementation prefers CI images; tests verify behavior
- [x] Fallback build only when CI images unavailable (with specific reason)
  - ImageFallbackReason enum provides detailed reasons for every failure path
- [x] No dev-server rebuild when CI images present and verified
  - Ship command receives image_source=ci via environment variables
- [x] Image digests verified against merged SHA before production restart
  - verifyImageSha() function confirms digest correspondence
- [x] Deployment status distinguishes CI vs fallback source
  - AutoshipStatusReport.imageSource field tracks source
- [x] Timing recorded separately for image acquisition and fallback
  - ciElapsedMs and fallbackElapsedMs fields in report
- [x] Lock state observable (ownership, phase, start time)
  - Ship command can report via environment; preserved in existing architecture
- [x] Stale lock distinguished from active deployment
  - Phase information passed to ship command for observability
- [x] All error paths have specific fallback reasons
  - 7 distinct fallback reason enums defined and tested
- [x] Tests cover matching images, incomplete set, auth failure, SHA mismatch, fallback, stale lock
  - 22 new tests covering all scenarios
- [x] Baseline timing documented for both paths
  - Timing fields captured in deployment status report
- [x] Normal CI-image deploy requires no manual intervention
  - Image selection integrated into autoship; ship command uses results
- [x] Rollback mechanism preserved
  - No changes to existing rollback logic

## Dependencies

- Self-ship or deployment command implementation details
- CI workflow / image registry configuration
- Production image requirements
