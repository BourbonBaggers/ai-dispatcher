# Issue #69: Dogfood safety — make the dashboard local-only by default

Make the read-only status dashboard safe to run during dogfooding: default to loopback,
require an explicit opt-in with a prominent warning to bind non-loopback, and document a
safe way to view it remotely.

## Problem

- `src/dashboard.ts` already defaults `--host` to `127.0.0.1`, but nothing stops a caller
  from passing `--host 0.0.0.0` (or any non-loopback address) silently.
- `scripts/install-dashboard-service.sh` defaults `DASHBOARD_HOST` to `0.0.0.0`, so the
  installer itself exposes the dashboard on the LAN by default with no warning.
- README's example command and installer description both show/describe the `0.0.0.0`
  default, reinforcing the unsafe default.
- The dashboard has no authentication; a LAN listener leaks issue metadata, live agent
  output, and repository/filesystem state to anyone on the network.

## Solution approach

1. Require an explicit `--allow-remote` flag on `ai-dispatcher dashboard` before it will
   bind to a non-loopback host; refuse to start otherwise, and print a prominent warning
   to stderr when it does bind non-loopback with the flag set.
2. Flip the installer's default `DASHBOARD_HOST` to `127.0.0.1` and thread an equivalent
   opt-in/warning through it when the operator explicitly overrides `DASHBOARD_HOST` to a
   non-loopback address.
3. Update README to show the safe local default, document the opt-in flag, and document a
   safe remote-viewing option (SSH port forwarding).
4. Add tests for the loopback-detection helper, `parseDashboardArgs` opt-in/refusal
   behavior, and the installer's default host.

## [DONE] Milestone 1: Loopback opt-in gate in the dashboard command

**Goal:** `ai-dispatcher dashboard` refuses to bind a non-loopback host without explicit
opt-in, and warns prominently when opted in.

- [x] Add an `isLoopbackHost()` helper (127.0.0.0/8, `::1`, `localhost`)
- [x] Add `--allow-remote` boolean flag to `parseDashboardArgs`
- [x] Non-loopback host without `--allow-remote` → `ok: false` with an explanatory message
      (no server start)
- [x] Non-loopback host with `--allow-remote` → succeeds, and `runDashboardCommand` prints
      a prominent warning to stderr before listening, explaining there is no
      authentication and the dashboard may expose live run output
- [x] Unit tests for `isLoopbackHost` and the new `parseDashboardArgs` branches
- [x] Commit: `milestone(1): require explicit opt-in to bind the dashboard off loopback`

## [DONE] Milestone 2: Safe installer default + opt-in warning

**Goal:** The systemd installer defaults to loopback and warns when explicitly overridden.

- [x] Flip `install-dashboard-service.sh` default `DASHBOARD_HOST` to `127.0.0.1`
- [x] When `DASHBOARD_HOST` is explicitly set to a non-loopback address, pass
      `--allow-remote` in `ExecStart` and print a warning during install
- [x] Add a small bash-level loopback check mirroring the TS helper (kept in sync by
      naming/comments, since the installer has no access to the TS module)
- [x] `bash -n` syntax check clean + regression tests on the script text; `shellcheck`
      itself was unavailable in this sandbox (no sudo, no network for the Docker image) —
      flagged in the PR body for CI's `scripts/shellcheck-ci.sh` to confirm
- [x] Commit: `milestone(2): default the dashboard installer to loopback`

## Milestone 3: Documentation

**Goal:** README reflects the safe default and documents remote viewing.

- [ ] Update the `dashboard` example command to the loopback default
- [ ] Update installer description to loopback default + opt-in override instructions
- [ ] Document SSH port forwarding as the safe way to view a loopback-bound dashboard
      remotely (and note an authenticated reverse proxy as an alternative)
- [ ] Reconcile the macOS menu bar section, which currently documents hitting the
      dashboard directly over LAN, with the new opt-in requirement
- [ ] Commit: `milestone(3): document local-only default and safe remote viewing`

## Milestone 4: Verification

**Goal:** Full test suite and typecheck pass.

- [ ] `npm test`
- [ ] `npm run typecheck`
- [ ] `scripts/shellcheck-ci.sh`
- [ ] Commit if any fixups were needed: `milestone(4): verification fixups`
