# Historical record — Issue #8 deploy escalation

> Completed and superseded. This file records why the deploy ladder exists; it is not
> current implementation guidance. `AGENTS.md`, `README.md`, and the code are authoritative.

Issue #8 originally added a one-shot deploy escalation. The implementation has since
been generalized: `src/recovery-policy.ts` now owns one durable, phase-independent ledger
for `agent`, `ci`, `merge`, and `deploy`.

Current behavior for every owned phase is:

1. retry with the assigned model up to
   `DISPATCHER_CI_SELF_HEAL_MAX_ATTEMPTS` (default `2`);
2. automatically launch one attempt on `DISPATCHER_CI_ESCALATION_MODEL` (default
   `claude-opus-4-8`);
3. only if that attempt fails, persist `RunRecord.exhaustion`, retain the issue claim,
   add `autoship-held`, and send the single high-priority operator page.

The old `ciEscalated`, `deployEscalated`, `ship_escalate`, `ship_failed`, and
`stampHold` design described by the original plan is compatibility history, not the
current API. Legacy boolean fields are migrated into the unified recovery ledger when
old state is loaded.

Deploy failure, unhealthy production, unknown production state, rollback success, and
rollback failure all enter this automated ladder. None is a first-failure human handoff.
