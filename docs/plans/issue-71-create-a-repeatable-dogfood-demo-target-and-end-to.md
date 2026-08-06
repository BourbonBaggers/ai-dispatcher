# Issue #71: Create a repeatable dogfood demo target and end-to-end runbook

Make it easy to demonstrate the dispatcher end to end without depending on a private
production repository or tribal knowledge. The deliverable is a small local fixture
repository plus a runbook that shows the safe path from intake to PR-ready handoff.

## Problem

- There is no small, documented target repo that can be used to rehearse the dispatcher
  flow in a repeatable way.
- The existing README explains how to run the dispatcher, but it does not yet describe a
  concrete dogfood/demo target, the labels it needs, or the exact safe sequence to use.
- The first dogfood pass should not use autoship; the demo should stop at the ready-PR
  handoff.

## Solution approach

1. Add a tiny local fixture repository under the repo's documentation/test surface that
   represents a minimal target repo with one intentionally simple issue and the labels it
   needs for intake.
2. Document the repeatable demo path in the main README: setup, labels/configuration,
   dry-run, one-scan, expected artifacts, and troubleshooting.
3. Add regression coverage that keeps the documented demo target and commands in place.

## [DONE] Milestone 1: Local demo fixture repository

**Goal:** A checked-in tiny fixture target exists and is described well enough to follow
without private context.

- [ ] Add a local fixture repository or fixture repository blueprint with one simple issue
      and the intake labels/configuration called out explicitly.
- [ ] Keep the demo path safe by default: the fixture docs should make it clear that the
      first pass uses `--dry-run` or `--once` without autoship.
- [ ] Add tests that verify the fixture and its documentation include the required demo
      details.
- [ ] Commit: `milestone(1): add a repeatable dogfood demo fixture`

## [DONE] Milestone 2: End-to-end runbook

**Goal:** README documents the safe repeatable demo path end to end.

- [ ] Document the exact commands for dry-run, one-scan, and follow-up inspection.
- [ ] Document the labels/configuration needed for intake.
- [ ] Document expected artifacts or representative terminal output.
- [ ] Add a short troubleshooting section for missing `gh`, missing agent auth, and
      failed CI.
- [ ] Keep autoship explicitly out of the first dogfood pass.
- [ ] Commit: `milestone(2): document the dogfood demo runbook`

## [PENDING] Milestone 3: Verification

**Goal:** Tests and typecheck pass for the final tree.

- [ ] Run `npm test`
- [ ] Run `npm run typecheck`
- [ ] Fix any issues found
- [ ] Final status recorded in git with no uncommitted changes
