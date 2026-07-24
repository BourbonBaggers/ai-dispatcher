# Plan — Issue #26: automatic dispatcher target-policy reconciliation

## Design

- Add a canonical dispatcher launch policy as source-owned data in `src/target-policy.ts`.
- Materialize the policy into dispatcher-created checkouts only, under ignored
  `.dispatcher/policy.md` managed content, and verify the exact bytes after every write.
- Reconcile immediately before each provider invocation in `dispatch-agent.sh`, after the
  checkout exists and before prompt generation / dependency install / agent launch.
- Include the verified policy in `.dispatcher-prompt.md` with explicit precedence over
  repository instructions; repository instructions remain available only where they do
  not conflict.
- Keep all target policy artifacts untracked and ignored through `.git/info/exclude`, so
  interactive checkouts and committed repository instructions are unchanged.

## [DONE] Milestone 1: canonical policy and pure reconciliation

Create the canonical target-policy module, export deterministic reconciliation helpers,
and cover missing/drift/extra managed-content cases with unit tests.

## [DONE] Milestone 2: launcher integration

Call reconciliation from the dispatcher launcher before every start/resume invocation,
thread policy paths into the generated prompt, and make launch fail before provider
startup if verification fails.

## [DONE] Milestone 3: end-to-end isolation tests

Add shell/runner tests proving repeated reconciliation is idempotent, target worktrees
stay clean, repository instructions are not modified, and non-dispatcher interactive
sessions remain unaffected.

## [DONE] Milestone 4: full verification

Run `npm test`, `npm run typecheck`, and the repository shellcheck wrapper.

Verification result: `npm test` and `npm run typecheck` passed. `scripts/shellcheck-ci.sh`
was attempted but could not run because `shellcheck` is not installed in this
environment; `bash -n scripts/dispatch-agent.sh scripts/shellcheck-ci.sh` passed as a
syntax fallback.
