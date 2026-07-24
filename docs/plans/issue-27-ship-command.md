# Issue #27: one-shot `ship` command for ad hoc pull requests

Allow work created outside the dispatcher (an ordinary interactive coding session) to use
the existing autoship merge/deploy/health/rollback machinery for a single named PR,
without a dispatcher issue, agent run, plan file, or repair/frontier ladder.

```
ai-dispatcher ship --repo owner/repo --pr 123 [--issue 456]
```

KISS boundary (from the issue): no LLM launch, no dispatcher agent run, no repair/frontier
escalation, no plan file requirement, no dispatcher labels, no manufactured issue, no
branch polling. A single pass: validate, gate on CI green, ship, verify, report. If
anything is not ready, exit non-zero with an explanation; the user reruns it later.

## [DONE] Milestone 1: `GithubClient.prTitleAndBody`

- Add `prTitleBodyArgs` + a `prTitleAndBody(pr)` method to `src/github.ts` returning
  `{ title, body } | null`, so the ship command can read PR text without inventing a new
  read path for merge info.
- Unit test the argv builder and the client method (parse + fail-closed on bad JSON),
  matching the existing `github.test.ts` conventions.

## Milestone 2: pure auto-close-keyword detector

- Add `src/ship.ts` with `findAutoCloseKeyword(text): string | null`, matching GitHub's
  documented close/fix/resolve (+ -s/-d) keywords followed by `#123`, `GH-123`, or a full
  issue URL, case-insensitively. Any match (regardless of which issue number it names) is
  disqualifying: it could close an issue the instant the ship command merges, before
  deploy is verified.
- Unit test positive/negative/edge cases (word-boundary false positives like "closest",
  multiple keyword forms, URL form).

## Milestone 3: `shipRun` orchestration (pure-ish, injected deps)

- In `src/ship.ts`, add `ShipDeps` (github surface, `ship: ShipRunner` reusing
  `autoship.ts`'s type, logger) and `shipRun(deps, { pr, issueNumber })` returning a typed
  `ShipOutcome`.
- Single pass, no recovery ledger: closed/unknown PR state -> blocked; draft or missing
  head/base SHA -> blocked; auto-close keyword in title/body -> blocked; merge conflict
  (`mergeStateStatus === "DIRTY"`) -> blocked (KISS: no generated-conflict repair here);
  CI not `pass` -> `ci_not_green` (no merge attempted); already-merged PR deploys its exact
  merge SHA (idempotent rerun, mirrors `autoship.ts`'s `alreadyMerged`); otherwise invoke
  the ship command and classify with the existing `classifyShipResult`.
- Verify delivered merge/head SHA evidence against a fresh GitHub read before declaring
  `shipped`, exactly like `autoship.ts` does.
- Close `--issue` only after verified `shipped`; report `issueClosed` honestly if the
  close call fails. No `--issue` means no issue operation at all.
- Unit test every branch with a fake github + fake ship runner, mirroring
  `test/autoship.test.ts`'s harness style.

## Milestone 4: CLI wiring

- Add `parseShipCliConfig` to `src/config.ts`: `--repo`, `--pr` (required int), `--issue`
  (optional int), reusing `DISPATCHER_AUTOSHIP_CMD` / `DISPATCHER_AUTOSHIP_DEPLOYMENT_DIR`
  / `DISPATCHER_AUTOSHIP_TIMEOUT_MINUTES` / `DISPATCHER_LOG_LEVEL` env fallbacks and the
  same deployment-dir default shape as the loop config. Missing `DISPATCHER_AUTOSHIP_CMD`
  is a hard config error for this command (there is nothing to ship with).
- Wire `ai-dispatcher ship ...` in `src/main.ts` ahead of the loop-config parse (same
  pattern as `report`/`status`/`history`), build a `ShipDeps` from a fresh `GithubClient`
  and the same bash-login-shell ship runner `buildDeps` already uses, run `shipRun`, print
  a human-readable terminal line, and map the outcome to a process exit code (0 only for
  `shipped`; non-zero for every blocked/not-ready/failed outcome).
- Unit test the CLI parsing in `test/config.test.ts`.

## Milestone 5: docs + verification

- Document the command in `README.md` next to the existing `status`/`history` local
  commands section.
- `npm test` and `npm run typecheck` pass.
