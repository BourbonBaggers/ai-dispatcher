# Plan — Issue #61: Use runtime failure evidence to select the correct recovery action

## Problem

The dispatcher has a capacity-aware recovery planner but currently collapses most failures into broad categories (`implementation-failure`, `test-failure`), preventing evidence-based recovery decisions. Model selection should distinguish transient infrastructure failures, quota exhaustion, context exhaustion, deterministic repair targets, requirements problems, and genuine capability failures.

## Design

The solution introduces a detailed failure-classification layer that sits between run outcomes and recovery decisions:

1. **Failure categories** (8 types: `transient`, `usage-limit`, `requirements-block`, `implementation-failure`, `test-failure`, `context-exhaustion`, `human-intervention`, `unknown`)
2. **Classification logic** that examines agent exit, CI, merge, and deployment evidence
3. **Recovery planner** that maps failure categories to evidence-based actions
4. **Independent ledgers** for agent, CI, merge, and deploy recovery phases

The recovery planner applies:
- `transient` → retry same model where capacity remains
- `usage-limit` → hand off to comparable available capacity
- `context-exhaustion` → hand off to suitable large-context capacity
- `implementation-failure` or `test-failure` → escalate one route tier
- `requirements-block` or `human-intervention` → hold for human action
- `unknown` → park and recheck

## [DONE] Milestone 1: define failure-classification types and pure classification logic

Create `src/failure-classification.ts` with:
- `FailureCategory` type (the 8 categories)
- `FailureClassification` interface (category + evidence summary)
- Pure classification functions for agent, CI, merge, and deploy phases
- Detailed type definitions for observed evidence from each phase

Update related `test/failure-classification.test.ts`.

## [DONE] Milestone 2: update recovery-policy.ts with failure-aware decisions

Enhance `src/recovery-policy.ts`:
- Add `FailureCategory` to `RecoveryState` and `RecoveryLedger`
- Update `decideRecovery` to accept `FailureCategory` and return category-based decisions
- Implement category-to-action mapping (transient→retry, etc.)
- Keep independent attempt ledgers per recovery kind

Update `test/recovery-policy.test.ts` to verify each category produces correct actions.

## [DONE] Milestone 3: wire agent failure classification

Update `src/runner.ts`:
- Import failure-classification functions
- Classify agent-exit outcomes using `classifyAgentFailure`
- Persist failure category and evidence in RunRecord
- Update `test/runner.test.ts` to cover each failure category

## [DONE] Milestone 4: wire CI failure classification

Update `src/dispatcher.ts` CI evaluation:
- Import CI classification function
- Classify CI outcomes using detailed check conclusions/logs
- Distinguish between flaky/infra failures vs. deterministic test failures
- Preserve failure category and evidence across CI retries
- Update tests to verify CI classifications

## [DONE] Milestone 5: wire merge/deployment classification

Update `src/autoship.ts`:
- Classify merge conflicts/failures using `classifyMergeFailure`
- Classify deployment failures using `classifyDeploymentFailure`
- Persist evidence and category in autoship state
- Update tests to verify merge/deploy classifications

## [DONE] Milestone 6: integrate recovery decisions

Update `src/dispatcher.ts` recovery paths:
- Call updated `decideRecovery` with failure category
- Apply category-based recovery actions (retry vs. escalate vs. hold)
- Persist failure category, evidence, and selected recovery action
- Ensure unknown state parks and rechecks without spending budget

Update tests to verify category-driven recovery behaviors.

## [DONE] Milestone 7: full-suite verification and documentation

- `npm test` and `npm run typecheck`
- Update ROUTING.md with failure-classification behavior
- Update relevant docstrings and comments
- Verify frontier exhaustion still applies `autoship-held` correctly
