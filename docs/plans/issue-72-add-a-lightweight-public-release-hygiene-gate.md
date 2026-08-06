# Issue #72: Add a lightweight public-release hygiene gate

Add the minimum public-release guardrails needed for a small, unfamiliar reviewer to
understand licensing, reporting paths, supported development commands, and the basic
repository hygiene checks.

## Problem

- The repository still lacks a first-class public release hygiene layer.
- A fresh reviewer does not yet get a short, explicit answer for licensing, security
  contact/reporting guidance, development commands, or the release checklist.
- The current CI catches some private-residue issues, but it does not yet gate the full
  set of public-release hygiene checks called out in the issue.

## Solution approach

1. Add the missing public-facing governance docs: `LICENSE`, `SECURITY.md`, and
   `CONTRIBUTING.md`.
2. Extend the hygiene checks so CI rejects the specified release-residue classes:
   secrets, private IP literals, tracked build artifacts, accidental `.env` files, and
   old private-repo/path references.
3. Ensure generated macOS build output is ignored and absent from the intended release
   tree.
4. Add a concise release checklist to the README so the public release expectations are
   obvious without reading the whole repository policy.

## [DONE] Milestone 1: Public release docs

**Goal:** The repository has explicit public-facing answers for license, security, and
day-to-day contribution expectations.

- [ ] Add `LICENSE`.
- [ ] Add `SECURITY.md` with reporting guidance and the dashboard/autoship threat model.
- [ ] Add `CONTRIBUTING.md` with the required Node version, `npm run typecheck`,
      `npm test`, and ShellCheck commands.
- [ ] Update the README with a short release checklist.
- [ ] Commit: `milestone(1): add public release guidance docs`

## [DONE] Milestone 2: Hygiene gate and verification

**Goal:** CI blocks the release-hygiene regressions described by the issue and the
release tree stays clean.

- [ ] Extend the hygiene guard and CI so the checks cover secrets, private IP literals,
      tracked build artifacts, accidental `.env` files, and old private-repo/path
      references.
- [ ] Ensure generated macOS build output is ignored and absent from the intended release
      tree.
- [ ] Add or update tests for the hygiene guard behavior.
- [ ] Run the repository verification commands relevant to the changes.
- [ ] Commit: `milestone(2): add public release hygiene checks`
