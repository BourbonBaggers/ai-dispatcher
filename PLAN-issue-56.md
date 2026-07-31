# Plan: Make OpenCode Zen a quota-exhaustion fallback with deterministic model selection

Issue #56: OpenCode Zen becomes a fallback-only provider, used only after both Codex and Claude are exhausted for the same quota window (5-hour, weekly, or monthly).

## Milestone 0: Plan and explore

- [x] Read issue #56 and understand requirements
- [x] Explore current routing, model registry, and token-exhaustion architecture
- Identify integration points and data structures needed

## Milestone 1: Add OpenCode models to registry

**Goal:** Add explicit OpenCode fallback-only model entries to models.ts, replacing the normal lane.

- Add OpenCode model entries for each route tier with correct model names
- Mark OpenCode models with a new `fallbackOnly: boolean` flag
- Disable or remove the existing `model:opencode-zen → opencode/big-pickle` normal lane
- Implement `modelsForRoute()` filtering to exclude fallback-only models from normal pickup
- Add helper functions to identify and select OpenCode models
- Update cost scoring for OpenCode models (pricing metadata per spec)
- Write tests for model registry changes

## [DONE] Milestone 2: Detect and classify provider exhaustion

**Goal:** Track exhaustion state per provider and quota window, distinguishing from other capacity issues.

- [x] Add exhaustion tracking in exhaustion-state.ts:
  - Per-provider (Codex, Claude) exhaustion status
  - Per quota window (5-hour, weekly, monthly)
  - Timestamp of exhaustion detection
  - Evidence (capacity signal kind, reset time if available)
- [x] Create functions to detect "both primary providers exhausted" for a given window
- [x] Track OpenCode Zen balance state (paid/free, remaining balance)
- [x] Export exhaustion signals for routing decisions
- [x] Write comprehensive tests for exhaustion classification (10+ cases)

## [DONE] Milestone 3: Implement fallback-only routing logic

**Goal:** Modify routing to exclude OpenCode during normal pickup and enable it only after exhaustion.

- [x] Create `opencode-fallback.ts` with `planOpenCodeFallback()` function
- [x] Implement deterministic model selection per spec table
- [x] Verify both Codex and Claude are exhausted for the same window
- [x] Preserve original route tier and effort
- [x] Record exhaustion evidence (window, paid vs free, model selected)
- [x] Implement helper for ordered candidate table
- [x] Handle model eligibility (disabled, unavailable, failed in sequence)
- [x] Add support for free-model last resort with bounded attempts
- [x] Write 17 comprehensive tests covering all scenarios

## [DONE] Milestone 4: Update recovery policy and next-attempt planning

**Goal:** Integrate OpenCode fallback into the recovery/escalation ladder.

- [x] Separate OpenCode recovery from escalation ladder (not in planNextAttempt)
- [x] Created planOpenCodeFallback() as independent recovery path
- [x] Tracks window preference (5-hour → weekly → monthly)
- [x] Tracks failed models to prevent infinite loops
- [x] Implements free-model last-resort logic with guards:
  - Only after paid balance exhausted
  - Only after both providers exhausted for monthly window
  - At most one free model per fallback phase
  - Excludes Big Pickle and opaque models
- [x] Records recovery context in decision output

## [DONE] Milestone 5: Add telemetry and evidence recording

**Goal:** Record OpenCode usage and capacity evidence for diagnostics and cost tracking.

- [x] Create opencode-telemetry.ts for attempt-specific metrics
- [x] Define OpenCodeAttemptTelemetry interface capturing:
  - Provider lane, selected model, route, effort
  - Fallback trigger window (5-hour/weekly/monthly)
  - Codex and Claude exhaustion evidence
  - Paid vs free-model flag
  - Price snapshot at attempt time
  - Zen balance state (paid/free balance, source)
  - Provider-reported usage and billed amount
  - Bypass flag for later analysis
- [x] Define ExhaustionRecoveryEvent for trigger logging
- [x] Write tests for telemetry structures

## [DONE] Milestone 6: Add configuration and validation

**Goal:** Support OpenCode Zen configuration in environment/config.

- [x] Create opencode-config.ts for provider configuration
- [x] Define OpenCodeZenConfig with API key, enabled flag, balance info
- [x] Implement validateOpenCodeConfig() with environment parsing
- [x] Validate Zen balance before fallback selection
- [x] Handle missing/invalid credentials with actionable errors
- [x] Implement updateBalance() for API-fetched balance info
- [x] Implement isOpenCodeFallbackUsable() eligibility check
- [x] Implement shouldRefreshBalance() for cache staleness
- [x] Write config validation tests (15 test cases)

## Milestone 7: Implement tests for all acceptance criteria

**Goal:** Comprehensive test coverage for the fallback feature.

- Test normal pickup never selects OpenCode (all routes)
- Test single-provider exhaustion doesn't trigger OpenCode
- Test both exhausted + 5-hour window → OpenCode eligible
- Test both exhausted + weekly window → OpenCode eligible
- Test both exhausted + monthly window → OpenCode eligible
- Test deterministic within-route model order (per the table)
- Test disabled model filtering
- Test paid Zen balance exhaustion handling
- Test free-model last resort (payment limit + both exhausted)
- Test free-model failure doesn't escalate route
- Test route preservation through fallback
- Test bounded fallback attempt count
- Test telemetry recording for all scenarios
- Test missing Zen credentials with clear error

## Milestone 8: Update documentation and finalize

**Goal:** Update repository documentation and prepare for deployment.

- Update ROUTING.md with OpenCode fallback decision table
- Update README.md with OpenCode integration overview
- Add inline code comments for critical invariants
- Verify all tests pass (npm test, npm run typecheck, shellcheck)
- Prepare PR with clear description of fallback mechanism
- Add migration notes if needed

## Non-Goals

- Automatic free-model rotation or learning from free-model success
- OpenCode during normal pickup (remains fallback-only)
- Changing Codex/Claude selection or escalation ladder
- UI updates for dashboard (telemetry records are sufficient)
