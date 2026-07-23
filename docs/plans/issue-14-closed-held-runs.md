# Issue #14 — Closed held runs must stop reprocessing

Branch: `fix/issue14-closed-held-runs`

## [DONE] Milestone 1: Closed-issue terminal guard

- Make `recheckHeldRun` read the linked issue state before checking hold labels.
- Return without autoship, comments, labels, or notifications when the issue is closed.
- Add regression coverage for closed held runs and retain the open un-hold behavior.

## Milestone 2: Validate and deploy

- Run the locked install, typecheck, and full test suite on the Ubuntu agent host.
- Open and merge the PR through green CI.
- Fast-forward the production checkout, restart the self service, and verify a clean poll.
