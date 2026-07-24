# Pickup-time routing rubric

The dispatcher chooses provider, model, and effort when it claims an issue. Issue authors
describe the workload with characteristic and priority labels; they do not need to know
subscription state or preselect execution parameters.

`src/models.ts` is the model-catalog authority. `src/routing.ts` implements the pure
capability and effort rubric, `src/capacity.ts` normalizes capacity evidence, and the
dispatcher joins those decisions atomically at pickup.

## Objective

> Use the minimum viable model while balancing paid subscription headroom and preserving
> frontier capacity, with no routine operator involvement.

Success means merged, deployed, healthy, and requiring no material human repair. A cheap
first miss is acceptable when deterministic verification and automatic recovery make it
useful evidence.

## 1. Optimize for this operating environment

This is a small, trusted, automation-heavy operation—not an enterprise change-control
board. Most mistakes happen on a Git branch, are caught by tests or CI, and can be retried.
Production changes are health-checked and rollback is the safety net. The number of users,
organizational approval layers, and enterprise governance overhead are not routing inputs.

Judge the residual work left for the coding agent after reading the issue. Apply only
labels that materially differ from the middle defaults; an omitted dimension uses its
middle value and never wedges an issue. When choosing between adjacent values, use the
lower one unless the issue contains concrete evidence for the higher value.

| Dimension | Label | Values |
| --- | --- | --- |
| Task type | `task:<type>` | e.g. `feature`, `bugfix`, `refactor`, `docs`, `test`, `infra` |
| Complexity | `complexity:<v>` | `trivial`, `simple`, `moderate`, `complex` |
| Residual blast radius | `risk:<v>` | `low`, `medium`, `high` |
| Context size | `context:<v>` | `small`, `medium`, `large` |
| Ambiguity | `ambiguity:<v>` | `clear`, `some`, `high` |
| Requirements quality | `requirements:<v>` | `good`, `adequate`, `poor` |
| Residual reasoning | `reasoning:<v>` | `shallow`, `moderate`, `deep` |
| Verification strength | `verification:<v>` | `weak`, `standard`, `strong` |
| Recoverability | `recoverability:<v>` | `low`, `medium`, `high` |

Use `requirements:good` only when the issue gives a bounded execution package: outcome,
scope and exclusions, acceptance criteria, business/data rules, dependencies, verification,
and relevant rollback guidance.

Use these operational definitions:

- **Complexity** measures unsettled implementation structure, not workflow importance or
  file count. `trivial` is mechanical; `simple` follows one obvious local pattern;
  `moderate` is bounded cross-file or stateful work with a settled approach; `complex`
  means the worker must choose among materially different architectures, algorithms, or
  integration strategies. Several explicit states and negative cases are usually
  `moderate`, not `complex`.
- **Risk** is harm that can escape the safeguards actually present. `low` is isolated;
  `medium` can temporarily break a workflow but is detectable and reversible; `high`
  can silently corrupt or disclose data, cause irreversible external effects, or evade
  tests, health checks, and rollback. Merely touching merge, deployment, authentication,
  or production code is not `high`.
- **Context** is the material that must be held simultaneously to choose the solution,
  not the number of relevant files or concepts. `small` is localized; `medium` is normal
  repository orientation plus several files; `large` asserts that the task probably
  exceeds a normal 200k-token context and cannot reasonably be partitioned. Use `large`
  rarely: it is a hard model-capability constraint, not an effort adjective.
- **Ambiguity** measures unresolved outcome or policy. Ordinary factoring, naming, and
  integration-point choices do not make a well-specified issue `some`; use `clear` when
  acceptance criteria settle externally observable behavior.
- **Residual reasoning** measures approach selection left to the worker. `shallow` is
  mechanical execution; `moderate` is normal coding judgment and careful edge cases;
  `deep` requires novel diagnosis, competing invariants, or unresolved tradeoffs.
  Implementing explicit safety rules is normally `moderate`.
- **Verification** is `strong` when deterministic tests, CI, structured health evidence,
  or equivalent checks give a reliable oracle; `standard` is normal test/review feedback;
  `weak` means correctness is subjective or failures are hard to observe.
- **Recoverability** is `high` when a miss is confined to a branch or can be automatically
  retried/rolled back; `medium` needs some cleanup; `low` is irreversible or difficult to
  restore. Self-healing and rollback count.

Route by uncertainty remaining after requirements and safeguards. Importance, codebase
breadth, state-machine vocabulary, and “production-adjacent” language do not independently
justify a stronger model.

## 2. Derive the minimum model tier

The capability ladder is `fast → general → complex → frontier`. General is the default.

| Tier | Initial use |
| --- | --- |
| **fast** | Trivial/simple, low-risk, clear work with good requirements, shallow reasoning, and strong deterministic verification. |
| **general** | Most bounded work with a known approach, including cross-file stateful work with explicit invariants; also complex raw scope whose design is settled and whose failures are strongly verified and cheaply recoverable. |
| **complex** | Meaningful approach selection remains: genuinely complex implementation structure, high ambiguity, poor requirements, or deep residual reasoning. Risk alone does not select this tier. |
| **frontier** | Exceptional first attempts only: complex and high-risk work with deep uncertainty plus weak verification or low recoverability. |

Raw complex scope receives a one-tier recoverability discount when requirements are good,
ambiguity is not high, reasoning is not deep, verification is strong, and recovery is
cheap. High risk does not cancel real verification and recoverability. Frontier otherwise
remains the final automatic recovery rung.

The human-readable decision rule is:

> Start at general + medium. Move down for deterministic mechanical work. Move effort up
> for execution breadth or persistence. Move the model up only when the worker must choose
> the right approach under unresolved uncertainty.

Current catalog warning: `context:large` requires large-context capability, while
`complexity:complex` requires the complex lane. No current live model satisfies both.
That combination is intentionally unroutable and should be used only when both assertions
are literally true—not as a way to say “this is an important broad change.”

### Calibration examples from this repository

| Work item | Appropriate characteristics | Initial route |
| --- | --- | --- |
| Reconcile target policy before each launch (#26) | `complexity:moderate`, `risk:medium`, `context:medium`, `ambiguity:clear`, `requirements:good`, `reasoning:moderate`, `verification:strong`, `recoverability:high` | general + medium |
| Compose existing autoship machinery into a one-shot command (#27) | `complexity:moderate`, `risk:medium`, `context:medium`, `ambiguity:clear`, `requirements:good`, `reasoning:moderate`, `verification:strong`, `recoverability:high` | general + medium |
| Add blocked, on-demand semantic policy cleanup (#28) | `complexity:moderate`, `risk:medium`, `context:medium`, `ambiguity:some`, `requirements:good`, `reasoning:moderate`, `verification:standard`, `recoverability:high` | blocked; general + medium when admitted |

## 3. Derive effort independently

Effort controls persistence within the selected lane. It is derived at pickup and is
independent of subscription usage.

| Effort | Use |
| --- | --- |
| `effort:low` | Localized deterministic work with an obvious path and strong verification. |
| `effort:medium` | Default normal implementation and test work. |
| `effort:high` | Broad but bounded execution, careful sequencing, several edge cases, or multi-step verification. |
| `effort:max` | Rare exhaustive frontier/near-frontier work where weak verification or costly recovery makes extra persistence cheaper than a miss. |

Importance alone raises neither model tier nor effort. After model selection, the
provider-neutral effort is mapped through the selected CLI's frozen allowlist; unsupported
Codex levels remain safely capped.

## 4. Read live subscription capacity

At pickup the dispatcher reads both pools concurrently:

- Codex: `codex app-server` JSON-RPC `account/rateLimits/read`.
- Claude: authenticated `GET https://api.anthropic.com/api/oauth/usage`.

The normalized confidence ladder is `provider-reported → cli-reported →
persisted-limit → unconfirmed-limit → estimated → unknown`.

Each live window carries utilization and reset time. Model-specific Claude windows apply
only to their matching model. Constrained headroom is the smallest remaining percentage
among applicable active windows.

A fresh affirmative live read supersedes a stale suppression. A failed read proves
nothing: existing evidence remains and the pool becomes unknown when there is no durable
evidence. Credentials and raw responses are never logged or persisted.

Capacity reads are bounded. One or both adapters failing never stops the scan.

## 5. Select provider and model

For each issue in priority order:

1. Exclude models below the minimum tier.
2. Admit at most one non-frontier tier of headroom.
3. Enforce context and task capabilities.
4. Withhold frontier unless the issue characteristics justify it.
5. Exclude pools or model-specific windows proven exhausted.
6. When both pools have comparable live evidence and their constrained headroom differs
   by more than the hysteresis threshold, prefer greater headroom.
7. When evidence is close, missing, or incomparable, use the durable round-robin cursor.
8. Within the chosen pool, use the lowest adequate model, then task-class match.

If an issue is temporarily unroutable, leave it unclaimed and continue through the queue.
Retry it on later polls. Capacity scheduling never creates `autoship-held`, spends a
repair attempt, or pages the operator.

Current live lanes:

<!-- BEGIN GENERATED LIVE MODEL LANES -->
| Tier | Role | `agent:*` label | `model:*` label | CLI model | Pool | Frontier |
| --- | --- | --- | --- | --- | --- | --- |
| fast | fast | `agent:claude` | `model:claude-haiku-4.5` | `claude-haiku-4-5-20251001` | `claude-subscription` | no |
| general | general | `agent:claude` | `model:claude-sonnet-5` | `claude-sonnet-5` | `claude-subscription` | no |
| frontier | frontier-reserve | `agent:claude` | `model:claude-opus-4.8` | `claude-opus-4-8` | `claude-subscription` | **yes** |
| complex | complex | `agent:codex` | `model:gpt-5.5` | `gpt-5.5` | `codex-subscription` | no |
<!-- END GENERATED LIVE MODEL LANES -->

Run `npm run docs:routing` after changing `src/models.ts`.

## 6. Assignment labels and overrides

Any recognized workload-characteristic label admits a planned issue. `dispatch:ready` is
the explicit provider-neutral admission marker for an issue that intentionally relies on
all default characteristics. Neither form needs `agent:*`, `model:*`, or `effort:*`.
Ordinary assignment labels remain a legacy admission signal, but are advisory/stale and
cannot wedge the queue. After the
durable claim, the dispatcher rewrites them best-effort for visibility.

Only `route:human-override` makes assignment labels authoritative. It requires exactly one
compatible `agent:*` and `model:*`; `effort:*` is optional. Without explicit effort, the
dispatcher still derives it. Invalid explicit overrides are visible human-input errors
rather than silently ignored instructions.

Overrides pin the initial launch only. Automatic quota handoff and the normal repair →
frontier → exhaustion contract still apply. Override attempts are recorded but excluded
from the learning dataset.

## 7. Quota handoff

A quota exit changes capacity, not task difficulty. The dispatcher re-routes the existing
run inside the original capability band, preserving assigned effort and branch state.
One adjacent non-frontier tier is allowed, so Sonnet exhaustion can hand off to GPT-5.5
before Opus. A quota handoff does not consume the frontier rung.

If no alternate pool is usable, the run waits and revalidates automatically. It does not
become operator work.

## 8. Durable evidence

Before any launch or GitHub mutation, the claim stores:

- immutable original agent, model, and effort;
- assignment source and timestamp;
- minimum tier and characteristic labels;
- routing and effort rationale;
- capacity selection method;
- sanitized capacity assessments; and
- selected capacity pool.

Restart and later delivery phases restore this original assignment. Frontier use in one
phase does not rewrite it. GitHub assignment-label failures are cosmetic.

Attempt telemetry records the same sanitized routing evidence. Token counts remain
`unavailable` until a trusted launcher signal exists; they are never fabricated.

## Operator-involvement invariant

Initial routing, effort selection, adapter failure, exhausted subscriptions, and stale
suppressions are scheduling states. They wait, retry, rotate, or hand off automatically.
Only genuinely invalid/revoked credentials across all providers, absence of any technically
capable configured model, an explicit invalid human override, or the existing fully spent
repair → frontier → durable exhaustion path can require an operator.

## Priority and future providers

`queue jump`, regular, and `technical debt` control order only. They never select model or
effort.

To add a provider, add the complete disabled catalog entry in `src/models.ts`, implement
its launch and bounded capacity adapters, test its safety contract, then enable it. Never
mirror the model allowlist outside the registry.
