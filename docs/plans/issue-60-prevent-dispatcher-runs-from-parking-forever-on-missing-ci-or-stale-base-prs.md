# Plan — Issue #60: Prevent runs from parking on missing CI or stale-base PRs

## Problem

Autoship currently treats an absent or unknown CI result as retryable pending work even when the PR is merge-conflicted or no workflow suite exists. A durable condition can therefore be rechecked forever without repairing the existing branch or escalating through the recovery ladder.

## Design

Distinguish genuine pending checks from durable missing-CI and merge-conflict states, preserve the existing issue claim and branch, and route actionable conditions through the existing same-branch recovery policy. Keep merge and deployment gated on green CI and verified mergeability.

## [DONE] Milestone 1: classify CI and PR readiness evidence

Add pure evidence classification for no checks, delayed workflow creation, merge conflicts/stale base, and genuinely pending checks. Cover the acceptance cases with focused tests and preserve unknown GitHub reads as unknown.

## [DONE] Milestone 2: recover durable missing-CI and stale-base conditions

Wire the classification into autoship/dispatcher reconciliation so durable actionable conditions leave `ci_pending`, launch same-branch repair or frontier recovery, and retain the current PR/worktree and claim. Add recovery tests for each path and bounded waiting for delayed workflow creation.

## [DONE] Milestone 3: expose actionable status and preserve shipping gates

Record and surface the actionable cause in issue/PR status and operator notifications, while ensuring no merge/deploy path can proceed without green CI and verified mergeability. Add integration/regression coverage.

## [DONE] Milestone 4: full verification and documentation

Run the complete test and typecheck suites, shell checks if applicable, and document the durable-state/recovery behavior.
