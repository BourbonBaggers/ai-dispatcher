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

## Milestone 3: Observability and deployment status

**Goal:** Make image acquisition and deployment phases observable.

- [ ] Extend deployment status report with image-acquisition phase
- [ ] Report image source (CI or fallback build)
- [ ] Record elapsed time for CI image pull vs fallback build
- [ ] Add structured logging with acquisition details
- [ ] Update AutoshipStatusReport type if needed
- [ ] Ensure lock ownership/phase/timing are observable
- [ ] Commit: `milestone(3): add image-acquisition observability to deployment status`

## Milestone 4: Regression tests and verification

**Goal:** Ensure image selection works correctly and doesn't regress.

- [ ] Add tests for CI image selection when available
- [ ] Add tests for fallback when CI images unavailable
- [ ] Add tests for SHA mismatch detection
- [ ] Add tests for missing CI evidence/incomplete image sets
- [ ] Add tests for GHCR auth failure handling
- [ ] Test timeout and error conditions
- [ ] Document baseline timing observed (CI pull vs rebuild)
- [ ] Commit: `milestone(4): add image-acquisition regression tests`

## Acceptance criteria checklist

- [ ] CI-image deployment path is preferred when complete image set available
- [ ] Fallback build only when CI images unavailable (with specific reason)
- [ ] No dev-server rebuild when CI images present and verified
- [ ] Image digests verified against merged SHA before production restart
- [ ] Deployment status distinguishes CI vs fallback source
- [ ] Timing recorded separately for image acquisition and fallback
- [ ] Lock state observable (ownership, phase, start time)
- [ ] Stale lock distinguished from active deployment
- [ ] All error paths have specific fallback reasons
- [ ] Tests cover matching images, incomplete set, auth failure, SHA mismatch, fallback, stale lock
- [ ] Baseline timing documented for both paths
- [ ] Normal CI-image deploy requires no manual intervention
- [ ] Rollback mechanism preserved

## Dependencies

- Self-ship or deployment command implementation details
- CI workflow / image registry configuration
- Production image requirements
