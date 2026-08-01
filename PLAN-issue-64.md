# Plan — Issue #64: Do not close issues when acceptance criteria were not addressed

## Problem

Autoship currently treats green CI, deployment, and health as sufficient for issue
completion even when the issue's business acceptance criteria were explicitly omitted or
contradicted by the implementation.

## Design

Add a bounded, deterministic acceptance-evidence check before shipping. It extracts
explicit business criteria from the issue, compares them with the PR diff and PR text,
and reports only strong failures: an explicit contradiction or a material criterion
with no implementation evidence. Unknown GitHub reads park the run; they never create
false success. Failed checks re-enter the existing automatic repair ladder with concrete
missing-criterion context, while preserving the existing no-auto-close-keyword and
verified-deploy protections.

## [DONE] Milestone 1: Add pure acceptance-evidence classification

- Extract explicit criteria and normalize business terms from issue text.
- Detect explicit omissions/contradictions and materially unattempted criteria.
- Add focused regression tests for invoice delivery and payment-menu labels, plus
  reasonable implementation wording and unknown/low-evidence tolerance.

## [DONE] Milestone 2: Gate autoship and route failed criteria to repair

- Read issue body and PR diff/text through the existing GitHub adapter.
- Run the check after green CI and before merge/deploy.
- Keep issue open and return concrete repair context through the existing recovery ladder.
- Park when acceptance evidence cannot be read, without spending recovery budget.

## [DONE] Milestone 3: Full verification and delivery

- Run the complete test and typecheck suites. (`npm test`, `npm run typecheck`)
- Update this plan with final verification results and regression/policy-narrative filtering.
- Commit, push the branch, and open a ready-for-review PR referencing `Issue: #64`.

## Verification

- `npm test` — passed (640 tests)
- `npm run typecheck` — passed
