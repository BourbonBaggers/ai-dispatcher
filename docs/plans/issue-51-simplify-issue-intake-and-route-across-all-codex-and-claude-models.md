# Issue #51 simplify issue intake and route across all Codex and Claude models

## [DONE] Milestone 1: Intake label contract and route derivation

Replace the legacy technical workload-label admission contract with the new
business-facing intake labels: `dispatch:ready` plus exactly one valid `type:*`,
`priority:*`, and `risk:*` label for normal new work. Preserve compatibility for
existing legacy-labelled issues during migration and for explicit human overrides.
Implement the documented type/risk route matrix, queue ordering, missing-input
handling, one-step down-routing/up-routing evidence, and provider-neutral effort
mapping.

## [DONE] Milestone 2: Cost-aware model catalog and selection

Represent all supported Codex and Claude dispatch models, including assignable
alternates and exceptional frontier/ultra-frontier lanes, from the single model
registry. Add price snapshots with effective dates, cached/long-context fields where
applicable, and deterministic candidate selection that prioritizes availability,
technical compatibility, expected completion cost, measured evidence when present,
and capacity as a constraint or close-cost tie-breaker.

## [DONE] Milestone 3: Evidence-based recovery and economic telemetry

Replace fixed attempt-count-to-Opus recovery with evidence-classified recovery
actions: same-model retry/repair, effort increase, lateral handoff, one-route
capability escalation, frontier selection by task fit/cost/capacity, requirements
hold, and exhaustion after an appropriate frontier attempt. Record per-attempt
economic evidence without fabricating unavailable token or billed-cost data, then
aggregate completed or exhausted issue costs across all attempts.

## [DONE] Milestone 4: Migration, documentation, and verification

Add migration helpers/tests for old labels to the new contract without losing
durable claims or human overrides. Update README, `ROUTING.md`, generated lane
documentation/help/report terminology, and automated coverage for label parsing,
route derivation, price-effective dates, candidate selection, effort mapping,
migration, missing usage, cost aggregation, and recovery branches. Run the required
test and typecheck commands before opening the ready-for-review PR.

## [DONE] Milestone 5: Recovery self-ship CI gate

Repair the self-ship delivery failure where the PR check rollup was green but the
ship command treated `gh pr checks` as non-green. Re-read current PR check buckets
from GitHub during self-ship, classify pass/pending/fail from structured data, and
verify the script keeps using bucket evidence instead of raw exit-code semantics.
