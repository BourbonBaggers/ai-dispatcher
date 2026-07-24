# Plan — Issue #32: make provider suppression evidence-driven and self-revalidating

## Incident recap

Codex hit a non-zero exit with quota-like output and no reset time. The dispatcher
applied Claude's documented ~5h rolling-window fallback to Codex, pausing it for 5 hours
when the real quota cleared in ~22 minutes. `src/token-exhaustion.ts` collapses several
materially different provider-capacity conditions into one `token_exhausted` bucket and
gives it terminal-classification precedence over the run's own artifact evidence
(commits/PR/CI), even when that evidence already proves the work is delivery-ready.

## Design

- `src/token-exhaustion.ts` gains a pure, typed classification
  (`ProviderCapacityKind`: `authoritative-exhaustion | unconfirmed-quota | throttling |
  context-exhaustion | billing | unknown`) distinguishing signal *kind* from signal
  *confidence* (`authoritative` when a concrete reset was reported, else not).
- Provider-specific policy: Claude's ~5h rolling-window fallback applies only to Claude,
  and only when no concrete reset is reported. Codex (and any other non-Claude agent)
  gets a short bounded revalidation window instead. Throttling and billing get their own
  distinct, bounded windows — never the rolling-window number.
- `context-exhaustion` never suppresses the provider pool (it is a per-request/task
  limit, not an account-capacity fact) — it falls through to the ordinary agent-failure
  repair ladder instead of a cooldown.
- Durable, redacted evidence (kind, confidence, detection time, reported reset if any,
  redacted excerpt) replaces the bare epoch number in `state.ts`'s `SettingsRecord`, with
  an on-read migration for legacy numeric fields.
- `runner.ts` separates "does this provider need to pause" from "is this run's own
  artifact delivery-ready": a run whose evidence already proves completeness (commits +
  PR + green CI) is reconciled to `pr_ready` even when the process's own exit carried a
  capacity signal, while the suppression record is still persisted independently.
- `capacity.ts` gains an `authoritative` input so an unconfirmed cooldown is reported at
  a distinct, lower confidence tier instead of being conflated with proven exhaustion.

## Milestone 1: pure classification + policy in `token-exhaustion.ts`

Add `ProviderCapacityKind`, broaden detection to throttling/context/billing phrases
(kept inside the same provider-owned-output scoping the anti-spoof tests already cover),
and replace `computeSuppressUntil`/`tokenExhaustionSummary` with
`computeCapacityDecision` + `resolveCapacitySuppression` (kind/provider-aware policy +
delivery-ready reconciliation). Update `test/token-exhaustion.test.ts`.

## Milestone 2: durable evidence in `state.ts`

Replace `claudeSuppressedUntil`/`codexSuppressedUntil: number | null` with
`claudeSuppression`/`codexSuppression: ProviderSuppressionRecord | null`, migrate legacy
numeric fields on read, add `getProviderSuppression`/`setProviderSuppression`. Update
`test/state.test.ts`.

## Milestone 3: wire `runner.ts`

`classifyRunOutcome` excludes `context-exhaustion` from the `token_exhausted` branch.
`finish()` calls `resolveCapacitySuppression`, persists the evidence unconditionally,
and only then applies the delivery-ready reconciliation. Update `test/runner.test.ts`.

## Milestone 4: wire `dispatcher.ts`

Read suppression through `getProviderSuppression`; make the eligibility-skip reason text
honest about confidence (proven vs. unconfirmed/revalidating).

## Milestone 5: capacity honesty in `capacity.ts`

Add an `authoritative` input (default `true`, additive/non-breaking) and a new
`unconfirmed-limit` confidence tier so an unconfirmed cooldown is never reported as
proven exhaustion. Update `ROUTING.md`'s capacity-honesty section.

## Milestone 6: full-suite verification

`npm test` and `npm run typecheck`.
