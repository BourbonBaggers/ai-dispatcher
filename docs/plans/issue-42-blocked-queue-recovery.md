# Issue #42 blocked queue recovery

## [DONE] Milestone 1: Pure Audit Policy

Add a focused blocked-queue audit module that can deterministically select blocked
candidates, extract dependency issue references, interpret conservative audit outcomes,
and decide whether `blocked` may be removed without mutating GitHub or creating claims.

## [DONE] Milestone 2: Dispatcher Integration

Wire the audit into the scan loop only after resumable, parked, held, and normal
eligible work are drained. Add configuration for the audit model, effort, and per-scan
candidate bound, using a non-frontier default and failing closed when configuration or
GitHub/audit reads are unavailable.

## [DONE] Milestone 3: Verification And Documentation

Cover queue precedence, deterministic stale dependency recovery, uncertain dependency
state, single-issue unblocking, and mutation failure behavior with tests. Update operator
documentation for the new fallback pass and run the required verification commands.
