# Issue 4: Auto-Recover Generated-File PR Conflicts

## [DONE] Milestone 1: Recovery Decision Model

Add pure recovery policy code for explicit generated-file allowlists, conflict-path
classification, and bounded recovery attempts. Cover safe generated-only conflicts and
mixed/source conflicts with unit tests.

## [DONE] Milestone 2: GitHub Recovery Plumbing

Extend the GitHub client with repo-threaded, argv-array helpers for reading PR
mergeability/conflicts and for running the repair commands needed by autoship. Keep
free-form text off argv and preserve existing fail-safe behavior when GitHub data is
missing.

## [DONE] Milestone 3: Autoship Integration

Wire generated-file conflict recovery into the autoship path after CI is confirmed green
and before the normal merge/deploy command. Record recovery decisions in logs,
notifications, and PR comments, and refuse non-allowlisted conflicts without shipping.

## [DONE] Milestone 4: Full Validation and PR

Run the required test and typecheck suite, commit each completed milestone, push the
issue branch, and open a draft PR containing `Closes #4`.
