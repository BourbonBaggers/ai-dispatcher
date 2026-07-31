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

## Milestone 3: Implement fallback-only routing logic

**Goal:** Modify routing to exclude OpenCode during normal pickup and enable it only after exhaustion.

- Update `routeIssue()` to filter out fallback-only models during normal pickup
- Implement `routeFallbackOpenCode()` function that:
  - Verifies both Codex and Claude are exhausted for the same window
  - Selects OpenCode model by the priority table in the spec
  - Preserves original route tier and effort
  - Records exhaustion evidence in the decision
- Create helper `determineBestOpenCodeModel()` to apply the ordered candidate table
- Handle model eligibility (disabled, unavailable, failed in current sequence)
- Write comprehensive tests for all exhaustion scenarios

## Milestone 4: Update recovery policy and next-attempt planning

**Goal:** Integrate OpenCode fallback into the recovery/escalation ladder.

- Modify `planNextAttempt()` to consider OpenCode fallback when both providers are exhausted
- Track OpenCode fallback attempts to prevent infinite loops
- Implement free-model last-resort logic:
  - Only trigger after paid Zen balance is exhausted
  - Only after both Codex and Claude exhausted for monthly window
  - Try at most one free model per fallback phase
  - Exclude Big Pickle and opaque models
- Record recovery context (provider lane, fallback trigger window, paid vs free)
- Write tests for recovery paths with OpenCode

## Milestone 5: Add telemetry and evidence recording

**Goal:** Record OpenCode usage and capacity evidence for diagnostics and cost tracking.

- Extend telemetry to record for every OpenCode attempt:
  - Provider lane (`opencode-zen`)
  - Selected model
  - Route and effort
  - Fallback trigger window (5-hour/weekly/monthly)
  - Codex and Claude exhaustion evidence
  - Paid vs free last-resort flag
  - Current price snapshot
  - Provider usage and billed amount (if available)
  - Final outcome
- Update telemetry aggregation and reporting
- Write tests for telemetry recording

## Milestone 6: Add configuration and validation

**Goal:** Support OpenCode Zen configuration in environment/config.

- Add OpenCode Zen credentials validation in config.ts (or extend existing provider config)
- Support per-provider capacity pool configuration
- Validate Zen balance availability before fallback selection
- Handle missing/invalid credentials with actionable error messages
- Update documentation in README and ROUTING.md
- Write config validation tests

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
