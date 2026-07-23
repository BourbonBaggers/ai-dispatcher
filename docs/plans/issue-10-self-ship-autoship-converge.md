# Issue 10: Self-ship autoship does not converge on a held self-modification

Two convergence failures when a self-modification PR is held, plus a self-instance
config/docs gap:

- **A — un-hold re-dispatches instead of resuming autoship.** A `held` run releases its
  issue claim, so once a human clears `autoship-held` the issue is eligible with no claim
  and the dispatcher launches a *fresh agent run* from scratch instead of merging the
  existing green PR. Repeated, this loops.
- **B — a manual merge of the green PR leaves autoship holding again with an
  "PR already merged" ship-command failure.** Autoship re-runs the ship command
  (`gh pr merge`) on an already-merged PR, which fails, and treats it as a deploy failure.
- **C — self-ship config/paths.** `self-ship.sh` defaults its deployment checkout to
  `~/ai-dispatcher-deploy`, which does not exist; the service runs from `~/ai-dispatcher`.
  The self-instance also needs `DISPATCHER_AUTOSHIP_CMD` → `scripts/self-ship.sh`.

## [DONE] Milestone 1: Held runs retain their claim

Make `held` a claim-holding status so a held issue is never re-dispatched from scratch,
and its run record survives pruning.

- `labels.ts`: add `HELD_STATUSES = ["held"]`, fold it into `CLAIMING_STATUSES`; document
  that `held` now retains its claim and is rechecked when un-held.
- `state.ts`: add `heldRuns()`.
- `dispatcher.ts`: `runsToKeep` retains every run whose status is claim-holding
  (`CLAIMING_STATUSES`), which now includes `held`; clarify `shouldReleaseClaim`'s doc
  (it governs the agent-working label + resume messaging, NOT claim retention).
- Tests: `claimingRunsByIssue` includes a held run; `runsToKeep` never prunes a held run.

## [DONE] Milestone 2: Resume autoship on un-hold instead of re-dispatching

- `dispatcher.ts`: add `recheckHeldRun` (mirrors `recheckParkedRun`) — if the issue still
  carries `autoship-held` it is a no-op; once the label is cleared it re-runs
  `evaluateAutoship`, which merges + ships the ready PR without relaunching the agent. Add
  a held-recheck phase to `runScanOnce`, after the parked recheck and before fresh work.
- Tests: a still-held run is a no-op; an un-held green PR ships via `evaluateAutoship`
  with no agent relaunch.

## [DONE] Milestone 3: Recognize an already-merged PR (converge, don't re-hold)

- `github.ts`: add `prState(pr)` → `open | merged | closed | unknown`.
- `autoship.ts`: add `prState` to `AutoshipGithub` and an `already_merged` outcome. Before
  re-confirming CI / running the ship command, if the PR is already merged, stand down:
  stamp a clear (non-error) hold and return `already_merged` — never run `gh pr merge` on
  a merged PR and mistake the failure for a broken deploy.
- `dispatcher.ts`: map `already_merged` → `held` (a stable, claim-holding terminal).
- Tests: a merged PR yields `already_merged`, runs no ship command, and holds cleanly.

## [DONE] Milestone 4: self-ship.sh checkout default + self-ship docs

- `scripts/self-ship.sh`: default the deployment checkout to `~/ai-dispatcher` (the
  running service checkout), not `~/ai-dispatcher-deploy`.
- `.env.example` + `README.md`: document self-shipping — point `DISPATCHER_AUTOSHIP_CMD`
  at `scripts/self-ship.sh`, set `DISPATCHER_AUTOSHIP_DEPLOYMENT_DIR=~/ai-dispatcher`, and
  the un-hold-to-resume-autoship behavior. Keep `shellcheck --severity=error` green.

## Milestone 5: Full validation and PR

`npm test`, `npm run typecheck`, and `shellcheck --severity=error scripts/self-ship.sh`.
Commit each milestone, push the branch, open a ready-for-review PR referencing Issue #10.
