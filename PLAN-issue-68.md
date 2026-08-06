# Plan — Issue #68: Remove private deployment residue and parameterize provisioning

## Problem

The standalone dispatcher checkout still carries residue from the old private deployment:
hard-coded repository and path defaults in the provisioning script, a tracked private LAN
address in docs, and no automated guard to prevent new private literals from creeping
back into shipped source.

## Design

Parameterize provisioning so it is driven by documented arguments or environment
variables, replace private deployment-specific defaults with placeholders or safe
configuration, and add a lightweight CI guard that rejects private repository names and
private IP literals in shipped source while allowing tests and historical docs to retain
context.

## [DONE] Milestone 1: Parameterize provisioning and remove private defaults

- Replace hard-coded repository and checkout paths in `scripts/provision-agents.sh` with
  documented arguments or environment variables.
- Remove the private LAN address and operator-specific path/user references from tracked
  source/docs, replacing them with placeholders or configuration.
- Update the README and provisioning guidance so a fresh clone can follow the documented
  path that uses the intended repository.
- Add or adjust tests for the provisioning text/configuration contract if needed.

## [DONE] Milestone 2: Add a lightweight CI residue guard

- Add a repository-local check that rejects private IP literals and known private
  repository names outside tests/history documentation.
- Wire the check into CI alongside the existing validation jobs.
- Add focused regression coverage for the guard’s allowlist/exception behavior.

## [DONE] Milestone 3: Verification and delivery

- Run the required test suite and typecheck.
- Mark completed milestone headers with `[DONE]`.
- Commit each milestone with a `milestone(N): description` message.
- Open a ready-for-review PR referencing `Issue: #68` in the body.

## Verification

- `npm test` — passed
- `npm run typecheck` — passed
- `bash scripts/check-private-residue.sh` — passed
- `bash -n scripts/provision-agents.sh scripts/check-private-residue.sh` — passed
- `bash scripts/shellcheck-ci.sh` — unavailable in this sandbox because `shellcheck`
  is not installed here; CI should run it.
