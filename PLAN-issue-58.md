# Plan: Honor single-agent GitHub labels as pickup-time routing overrides

Issue #58: Allow issues to specify a preferred agent (`agent:codex`, `agent:claude`, or `agent:opencode`) as a pickup-time override. When exactly one agent label is present, the dispatcher must select that agent and compatible model/effort. When multiple agent labels conflict, block the issue and add `blocked` label with explanatory comment.

## Milestone 0: Plan and explore

- [x] Read issue #58 and understand requirements
- [x] Explore routing, models, and dispatcher architecture
- Identify integration points and data structures

## [DONE] Milestone 1: Update AGENT_LABELS and label handling

**Goal:** Add `agent:opencode` to the supported agent labels and update label processing.

- [x] Add `agent:opencode` to AGENT_LABELS in labels.ts
- [x] Ensure OpenCode models are reachable via label lookup
- [x] Write tests for agent label parsing and detection

## [DONE] Milestone 2: Implement agent-override resolution logic

**Goal:** Create pure functions to resolve and validate agent overrides.

- [x] Create agent-override.ts module with:
  - [x] detectAgentOverride() to identify single overrides or conflicts
  - [x] selectAgentModel() to pick compatible model for an agent
  - [x] conflictCommentFor() to generate conflict explanation
- [x] Implement deterministic model selection within each agent:
  - [x] Pick lowest-cost available model for agent
  - [x] Respect capacity exhaustion
  - [x] Respect large-context requirements
- [x] Handle OpenCode as selectable even though fallback-only
- [x] Write comprehensive tests covering all combinations

## [DONE] Milestone 3: Integrate agent overrides into dispatcher pickup

**Goal:** Apply agent overrides at pickup time before normal capacity-aware routing.

- [x] Modify dispatcher.ts assignment callback:
  - [x] Check for agent override (single only, conflicts blocked separately)
  - [x] Call selectAgentModel() if override present
  - [x] Return failure if no eligible model
  - [x] Otherwise proceed with normal routing
- [x] Record agent-override evidence in routing metadata
- [x] Maintain backward compatibility with existing labels

## [DONE] Milestone 4: Implement conflict detection and blocking

**Goal:** Detect conflicting agent labels and block issues appropriately.

- [x] Create handleAgentLabelConflicts() function
- [x] Detect multiple agent labels early in scan
- [x] Apply `blocked` label when conflicts detected
- [x] Post one-time explanatory comment
- [x] Prevent issue from being claimed or launched
- [x] Write tests for all conflict scenarios

## [DONE] Milestone 5: Write acceptance tests

**Goal:** Comprehensive test coverage for all scenarios.

- [x] Test agent:codex override launches Codex model
- [x] Test agent:claude override launches Claude model
- [x] Test agent:opencode override launches OpenCode model
- [x] Test no agent label follows normal routing
- [x] Test 2+ agent labels blocks issue with `blocked` label
- [x] Test conflicting labels prevent launch
- [x] Test agent override works with effort labels
- [x] Test model selection respects tier requirements
- [x] Test backward compatibility
- [x] Created agent-override-acceptance.test.ts with 20+ test cases
- [x] All 591 tests pass

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
