# Historical record — Issue #10 self-ship convergence

> Completed and subsequently hardened. This is a historical record, not an instruction
> list. Current behavior is defined by `AGENTS.md`, `README.md`, and the code.

Issue #10 fixed two loops: held work being redispatched from scratch, and already-merged
self-modification PRs being treated as merge failures.

Current behavior is stronger than the original milestone plan:

- A held run retains its issue claim. Removing `autoship-held` resumes autoship of the
  existing PR; it does not relaunch from scratch.
- Only a hold with durable frontier-exhaustion evidence remains held. Legacy holds
  without that proof are automatically un-held and resumed.
- An already-merged PR is not held. Autoship deploys and verifies its exact merge SHA.
- A stale historical merge that is already contained in a newer running/deployed SHA is
  treated as delivered and never rolls the checkout or production backward.
- Before self-ship can restart the parent, the run is durably parked and the detached
  deployment result is written as `pending`.
- The restarted dispatcher waits for the detached verifier instead of scheduling a
  duplicate restart. Stable service PID and health are required; failure rolls back.
- The deployment checkout defaults to `~/ai-dispatcher` and must be the checkout used by
  the configured systemd unit.

The original plan’s “already merged → hold” behavior is obsolete and must not be
reintroduced.
