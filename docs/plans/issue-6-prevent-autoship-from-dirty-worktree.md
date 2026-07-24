# Issue 6: Prevent Autoship From Dirty Shared Worktrees

> Historical completed plan. Current code and `AGENTS.md` are authoritative. A dirty
> agent or human worktree is never discarded; the dedicated deployment checkout may be
> recreated only through the bounded deployment-checkout recovery path.

## [DONE] Milestone 1: Deployment Workspace Contract

Add pure autoship deployment status/result modeling for clean dedicated checkouts,
dirty-state diagnostics, exact SHA context, rollback truthfulness, and bounded recovery
decisions. Cover the policy with focused unit tests.

## [DONE] Milestone 2: Autoship Handoff Integration

Wire the deployment workspace contract into autoship so the repo-specific ship command
receives exact PR/base SHA context and a deployment checkout path instead of relying on
the agent checkout. Update notifications and logs so merge/deploy/rollback state is
reported deterministically.

## [DONE] Milestone 3: Full Validation and PR

Run the required test and typecheck suite, commit completed milestones, push the issue
branch, and open a draft PR without an auto-close keyword. Issue closure belongs only to
the verified shipped path.
