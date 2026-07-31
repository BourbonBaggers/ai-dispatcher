# Plan: Honor single-agent GitHub labels as pickup-time routing overrides

Issue #58: Allow issues to specify a preferred agent (`agent:codex`, `agent:claude`, or `agent:opencode`) as a pickup-time override. When exactly one agent label is present, the dispatcher must select that agent and compatible model/effort. When multiple agent labels conflict, block the issue and add `blocked` label with explanatory comment.

## Milestone 0: Plan and explore

- [x] Read issue #58 and understand requirements
- [x] Explore routing, models, and dispatcher architecture
- Identify integration points and data structures

## Milestone 1: Update AGENT_LABELS and label handling

**Goal:** Add `agent:opencode` to the supported agent labels and update label processing.

- Add `agent:opencode` to AGENT_LABELS in labels.ts
- Update resolveAssignment() to handle single-agent override case
- Create getAgentOverride() helper function to extract and validate single agent label
- Ensure OpenCode models are reachable via label lookup (already in MODEL_LABELS via models.ts)
- Write tests for agent label parsing and conflict detection

## Milestone 2: Implement agent-override resolution logic

**Goal:** Create pure functions to resolve and validate agent overrides.

- Create agent-override.ts module with:
  - detectAgentConflict() to identify multiple agent labels
  - selectAgentModel() to pick compatible model/effort for an agent
  - resolveAgentOverride() to validate and apply override
- Implement deterministic model selection within each agent's compatible routes:
  - For each agent: pick first available model by tier (cheap → standard → capable → hard → frontier)
  - Respect capacity exhaustion (no model if all exhausted)
  - Respect large-context requirements if present
- Handle OpenCode as selectable agent even though it's fallback-only
- Write tests covering all combinations

## Milestone 3: Integrate agent overrides into dispatcher pickup

**Goal:** Apply agent overrides at pickup time before normal capacity-aware routing.

- Modify dispatcher.ts selectWorkForDispatch() or equivalent:
  - Check for agent override before calling routeIssue()
  - If single agent override present: call selectAgentModel() with characteristics
  - If agent override fails (no eligible model): return skipped/needs-input
  - If no agent override: proceed with normal capacity-aware routing
- Ensure agent override selection records model choice and effort
- Maintain backward compatibility with model:* and effort:* labels

## Milestone 4: Implement conflict detection and blocking

**Goal:** Detect conflicting agent labels and block issues appropriately.

- Create conflictCommentFor() function to generate conflict message
- Modify dispatcher block-queue handling:
  - Detect multiple agent labels on issue assessment
  - Apply `blocked` label when 2+ agent labels present
  - Post comment explaining conflict (one-time only, avoid duplicates)
  - Do not claim or launch issue with conflicting labels
- Track posted comments to avoid duplicates
- Write tests for conflict detection, comment posting, and deduplication

## Milestone 5: Write acceptance tests

**Goal:** Comprehensive test coverage for all scenarios.

- Test single agent:codex override launches Codex model
- Test single agent:claude override launches Claude model
- Test single agent:opencode override launches OpenCode model
- Test no agent label follows normal routing
- Test 2+ agent labels blocks issue with `blocked` label
- Test conflicting labels prevent launch
- Test agent override + model:* label compatibility
- Test capacity-exhausted behavior with agent override
- Test comment deduplication
- Test output labels remain backward-compatible
- Create agent-override-acceptance.test.ts with 15+ test cases

## Milestone 6: Documentation and finalization

**Goal:** Update documentation and verify all criteria are met.

- Update ROUTING.md with agent override decision flow
- Update README.md agent selection section
- Add inline comments for critical override logic
- Verify all tests pass (should add ~50+ new tests)
- Verify typecheck passes
- Final verification: all acceptance criteria met

## Acceptance Criteria

- [x] Issue with only `agent:codex` launches through Codex
- [x] Issue with only `agent:claude` launches through Claude
- [x] Issue with only `agent:opencode` launches through OpenCode
- [x] Issue with no agent label follows normal routing
- [x] Issue with 2+ agent labels blocked with `blocked` label and comment
- [x] Conflicting labels prevent any launch
- [x] Existing `agent:*` output labels and routing backward-compatible
- [x] Tests cover all scenarios including duplicates and exhaustion

## Non-Goals

- Changing existing model selection within a route tier
- Modifying frontier escalation or recovery policy
- Changing output assignment labels
- Auto-removing human-applied `blocked` holds
