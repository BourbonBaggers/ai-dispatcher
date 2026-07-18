# Routing rubric — how to label a dispatchable issue

This is the routing policy the AI dispatcher enforces (#319). It is the rubric an issue
author (human or planning agent) applies when creating an issue, and it is implemented
as data + pure functions in `src/models.ts`, `src/capacity.ts`, and `src/routing.ts`. Keep
this document and that code in sync — the code is the source of truth; this is its
decision table.

## The one objective

> **Lowest total subscription capacity consumed per production-quality feature.**

Not attempt cost, not first-attempt success, not speed. A weaker model that completes the
work adequately — even after an occasional cheap retry — beats immediately spending scarce
frontier capacity. Success is only counted when a feature is **merged, deployed, and needs
no material human repair** (see telemetry semantics below).

## Step 1 — Classify the issue (characteristic labels)

Apply one label per dimension. Unlabelled dimensions fall back to a mid default, so label
the axes that actually move the decision. These are objective, machine-comparable, and let
later evidence compare similar issues.

| Dimension | Label | Values |
| --- | --- | --- |
| Task type | `task:<type>` | e.g. `feature`, `bugfix`, `refactor`, `docs`, `test`, `infra` |
| Complexity | `complexity:<v>` | `trivial`, `simple`, `moderate`, `complex` |
| Blast radius / risk | `risk:<v>` | `low`, `medium`, `high` |
| Context size | `context:<v>` | `small`, `medium`, `large` |
| Ambiguity | `ambiguity:<v>` | `clear`, `some`, `high` |
| Requirements quality | `requirements:<v>` | `good`, `adequate`, `poor` |
| Reasoning depth | `reasoning:<v>` | `shallow`, `moderate`, `deep` |

**Requirements quality substitutes for model strength.** Well-specified requirements let a
mid-tier model succeed, so `requirements:good` does *not* raise the tier — it raises
routing *confidence*. Poorly-specified work (`requirements:poor`) should be refined before
reaching for a stronger model, not escalated.

## Step 2 — Derive the minimum viable tier

The capability ladder ascends `fast → general → complex → frontier`. The minimum viable
tier is complexity-driven, with two floors and one reserved ceiling:

| Condition | Minimum tier |
| --- | --- |
| `complexity:trivial` or `simple` | **fast** |
| `complexity:moderate` | **general** |
| `complexity:complex` | **complex** |
| `risk:high` **or** `reasoning:deep` (any complexity) | at least **complex** |
| `complexity:complex` **and** `risk:high` **and** `reasoning:deep` | **frontier** |

Frontier is reached only at the ceiling of every axis — it is a genuine reserve, never a
default for "hard" issues.

## Step 3 — Select the model (one `model:*` label)

Pick the model from the curated registry (`src/models.ts`) using, in order:

1. **Minimum viable tier** — the lowest capable tier that meets Step 2.
2. **Availability** — drop any pool in a known usage-limit cooldown.
3. **Frontier protection** — never select a frontier model unless Step 2 justified it.
4. **Large context** — `context:large` requires a large-context-capable model.
5. **Dormant capacity** — among comparable options, prefer an otherwise-idle subscription
   pool to conserve busy capacity.

Current live lanes:

| Tier | `model:*` label | CLI model | Pool | Frontier |
| --- | --- | --- | --- | --- |
| fast | `model:claude-haiku-4.5` | `claude-haiku-4-5-20251001` | claude-subscription | no |
| general / large-context / planning | `model:claude-sonnet-5` | `claude-sonnet-5` | claude-subscription | no |
| complex | `model:gpt-5.5` | `gpt-5.5` | codex-subscription | no |
| frontier reserve | `model:claude-opus-4.8` | `claude-opus-4-8` | claude-subscription | **yes** |

Selected models use an **explicit, pinned identifier**, never a floating alias, so a
provider silently upgrading an alias cannot cause quality-over-cost drift.

## Step 4 — Record the rationale (routing-rationale labels)

The dispatcher applies these automatically; an issue author may add them to document a
manual choice: `route:min-viable`, `route:dormant-capacity`, `route:frontier-justified`,
`route:capacity-constrained`, `route:task-class-match`.

**Human overrides:** a model chosen by a human against the rubric must carry
`route:human-override`. Overrides are recorded and analysed separately and are **excluded
from the automatic learning dataset** so human preference never distorts the policy.

## Retry / handoff policy

Retries and handoffs are allowed when they lower expected *total* feature cost, not to
reflexively escalate within one provider. By failure category:

| Failure category | Next attempt |
| --- | --- |
| `transient` (provider blip) | retry the **same** model if its pool is up |
| `usage-limit` (pool exhausted) | hand off to **comparable** capacity in another pool |
| `context-exhaustion` | hand off to a **large-context** model |
| `implementation-failure` / `test-failure` | escalate **exactly one** tier |
| `requirements-block` / `human-intervention` | **hold** for a human — do not burn tokens |

Escalation reaches the **frontier only as the last rung**, and any frontier escalation is
flagged `requiresHumanApproval` — the operator gates the frontier capacity increase.

## Priority is separate from routing

Human priority (`queue jump` / `technical debt` / normal) controls *order*, never *which
model*. The two are independent by construction.

## Capacity honesty

Capacity is assessed on a descending confidence ladder (`provider-reported` →
`cli-reported` → `persisted-limit` → `estimated` → `unknown`). No CLI exposes a remaining
quota today, so the system reports `persisted-limit` (from an active cooldown) or
`estimated`/`unknown` — it never fabricates a precise remaining-capacity number.

## Telemetry semantics

Every terminal run records an **attempt**; attempts fold into an **issue** record.

- **Token counts carry a source** — `reported | estimated | unavailable`. The launcher
  emits no counts today, so real attempts record `unavailable`, never a fake `0`.
- **Success ≠ a clean exit or a PR.** An issue succeeds only when merged **and** deployed
  **and** free of regression/material human repair.
- Manual overrides are recorded but excluded from learning.

Run `ai-dispatcher report` for the analytics view (completed features by model, success by
task category, first-attempt/retry rates, frontier utilization, recommendations).

## Evidence-based adjustment (and its one hard gate)

Once enough comparable data exists, routing may be adjusted **among approved non-frontier
models** based on evidence — e.g. routing a task category to a lower tier that reliably
succeeds. **Any change that increases frontier-model usage requires explicit human
approval.** This is the non-negotiable gate on the frontier reserve.

## Adding a future provider

The registry is provider-neutral. To add a CLI-backed lane (e.g. a Gemini free tier):

1. Add a `ModelEntry` to `MODELS` in `src/models.ts` (see the disabled `model:gemini-2.5-pro`
   entry as a template) with its provider, pinned `cliModel`, tier, task classes, context
   characteristics, and `capacityPool`.
2. Teach the runner to launch that CLI and add its `cli` value to `LIVE_DISPATCH_CLIS`.
3. Set `enabled: true`. The label allowlist, routing, capacity, and reporting pick it up
   from the data with no further change.
