# Plan — Issue #8: escalate DEPLOY failures to the frontier model

Mirror the existing CI self-heal → escalation ladder for **deploy** failures. Today a
ship-command failure in `autoship.ts` goes straight to `stampHold` + hold; opus never
gets the one-shot escalation that the CI path grants. Close that gap with a budget
(`deployEscalated`) that is separate from the CI budget (`ciEscalated`).

## Milestone 1: state — add `deployEscalated` to RunRecord

- `src/state.ts`: add `deployEscalated: boolean` to `RunRecord` (beside `ciEscalated`),
  to the `createRun` `Omit` list, and default it to `false` in `createRun`.
- Keep it a separate budget from `ciEscalated`.

## Milestone 2: autoship — escalate the ship-failure path

- `src/autoship.ts`: add `| { action: "ship_escalate"; model: string }` to
  `AutoshipOutcome`.
- In the `if (result.code !== 0)` ship-failure block, BEFORE `stampHold`: if
  `!(run.deployEscalated ?? false)`, comment + notify (DEFAULT) + return
  `{ action: "ship_escalate", model: deps.ciEscalationModel }`.
- Keep the existing `stampHold` + `ship_failed` (+ HIGH notify) path for the
  already-escalated case (opus's deploy also failed → hold for a human).

## Milestone 3: dispatcher — wire the escalation relaunch

- `src/dispatcher.ts`: parameterize `escalateRun(deps, run, cliModel, kind: "ci" |
  "deploy" = "ci")` so it sets `ciEscalated: true` OR `deployEscalated: true`.
- Add `case "ship_escalate": store.updateRun(...); await escalateRun(deps, run,
  outcome.model, "deploy"); return { relaunched: true };` to the outcome switch.

## Milestone 4: tests

- Ship failure with `deployEscalated=false` → `ship_escalate` (not hold),
  `deployEscalated` NOT yet set (autoship returns the action; dispatcher sets the flag),
  no autoship-held label, DEFAULT-priority notify.
- Ship failure with `deployEscalated=true` → hold (`ship_failed`), autoship-held label,
  HIGH notify.
- A CI escalation must NOT consume the deploy budget and vice-versa (dispatcher-level:
  `escalateRun(..., "deploy")` sets only `deployEscalated`, `"ci"` sets only
  `ciEscalated`).
- `npm test` + `npm run typecheck` green.
