# Pickup-time routing rubric

The dispatcher chooses provider, model, and effort when it claims an issue. Issue authors
provide a clear issue plus `dispatch:ready` and one label from each business-facing
group: `type:*`, `priority:*`, and `risk:*`. They do not need to know subscription state,
technical workload dimensions, or execution parameters.

`src/models.ts` is the model-catalog authority. `src/routing.ts` implements the pure
capability and effort rubric, `src/capacity.ts` normalizes capacity evidence, and the
dispatcher joins those decisions atomically at pickup.

## Objective

> Use the lowest expected-cost route that is adequate for a successful result while
> preserving frontier capacity and requiring no routine operator involvement.

Success means merged, deployed, healthy, and requiring no material human repair. A cheap
first miss is acceptable when deterministic verification and automatic recovery make it
useful evidence.

## 1. Optimize for this operating environment

This is a small, trusted, automation-heavy operation—not an enterprise change-control
board. Most mistakes happen on a Git branch, are caught by tests or CI, and can be retried.
Production changes are health-checked and rollback is the safety net. The number of users,
organizational approval layers, and enterprise governance overhead are not routing inputs.

Judge the residual work left for the coding agent after reading the issue. New issues
normally carry exactly these labels:

| Group | Values |
| --- | --- |
| Type | `type:bug`, `type:enhancement`, `type:refactor`, `type:chore`, `type:docs`, `type:ops`, `type:research` |
| Priority | `priority:queue-jump`, `priority:normal`, `priority:background` |
| Risk | `risk:low-stakes`, `risk:normal`, `risk:destructive` |

Priority controls order only. Risk informs the initial route and safeguards, but
`risk:destructive` does not automatically select a frontier model. Missing or materially
contradictory requirements produce `needs-input` rather than expensive-model escalation.

### Where the internal axes come from

The author is no longer asked for the technical dimensions. At pickup the dispatcher reads
the selected issue's title and body and derives them itself (`src/issue-assessment.ts`),
using that evidence to move one route down for localized, strongly verified work or one
route up for concrete cross-cutting context, unresolved approach selection, or explicitly
weak verification.

This is deterministic pattern matching over structure the author produces incidentally —
file paths, code fences, checklists, headings, cross-references — plus explicit vocabulary.
It is a rubric, not a prediction engine, so the same text always routes the same way and
every axis is unit testable.

Three properties bound it, because the issue body is untrusted author-controlled input:

- scanning is length-capped;
- the assessment may move the route by one step only; and
- **text can never reach a frontier model.** Text-driven up-routing stops at `hard`.
  Frontier remains reachable only by human override or by the recovery ladder proving
  cheaper rungs already failed, so no issue author can word their way into the reserve.

Silence is not evidence. An issue that does not mention tests is `standard` verification,
not `weak` — this service always runs CI, health verification, and rollback, so those
safeguards exist whether or not the author mentioned them. Treating silence as weak would
up-route nearly every issue and pay for a bigger model to cover a contained risk.

`needs-input` likewise requires positive evidence of a problem, never brevity: either the
issue states essentially nothing, or it hedges heavily while giving no acceptance criteria
and no reproduction steps. "Bump node to 24" is short and perfectly actionable.

Legacy technical labels (`complexity:*`, `context:*`, `ambiguity:*`, `requirements:*`,
`reasoning:*`, `verification:*`, and `recoverability:*`) still pin their axis when present,
so a human can override the reader during migration.

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

## 2. Derive the route

The route ladder is `tiny → cheap → standard → capable → hard → frontier → ultra-frontier`.

| Type | Low-stakes | Normal | Destructive |
| --- | --- | --- | --- |
| Docs | tiny | cheap | standard |
| Chore | tiny | cheap | capable |
| Bug | cheap | standard | capable |
| Enhancement | standard | standard | capable |
| Refactor | standard | capable | hard |
| Ops | standard | capable | hard |
| Research | standard | capable | hard |

The human-readable decision rule is:

> Start from the type/risk matrix. Move down once for deterministic localized work. Move
> up once for concrete unresolved implementation evidence. Use `needs-input` for poor
> requirements. Keep frontier exceptional.

### Calibration examples from this repository

| Work item | Appropriate characteristics | Initial route |
| --- | --- | --- |
| Reconcile target policy before each launch (#26) | `type:ops`, `risk:normal`, `priority:normal`, clear requirements, strong verification | capable + medium |
| Compose existing autoship machinery into a one-shot command (#27) | `type:enhancement`, `risk:normal`, `priority:normal`, clear requirements, strong verification | standard + medium |
| Add blocked, on-demand semantic policy cleanup (#28) | `type:enhancement`, `risk:normal`, `priority:background`, blocked until policy is clear | blocked; standard + medium when admitted |

## 3. Derive effort independently

Effort controls persistence within the selected lane. It is derived at pickup and is
independent of subscription usage.

Effort is also an economic control: higher effort consumes more tokens, so it burns more
headroom on the same model. One table (`ROUTE_EFFORT`) maps route tier to effort, shared by
pickup and recovery so the two cannot drift apart.

| Route tier | Effort | Use |
| --- | --- | --- |
| tiny, cheap | `effort:low` | Localized deterministic work with an obvious path and strong verification. |
| standard, capable | `effort:medium` | Default normal implementation and test work. |
| hard | `effort:high` | Broad but bounded execution, careful sequencing, several edge cases, or multi-step verification. |
| frontier | `effort:xhigh` | The final automatic recovery rung. |
| ultra-frontier | `effort:max` | Rare exhaustive work where weak verification or costly recovery makes extra persistence cheaper than a miss. |

Escalation uses the effort of the route it escalated *to*, not a blanket maximum: spending
frontier persistence on a `capable` repair burns headroom the run may still need for a
later phase.

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

1. Exclude candidates whose registry entry does not serve the derived route tier.
2. Exclude unavailable or technically incompatible candidates.
3. Withhold frontier and ultra-frontier unless explicitly justified.
4. Rank the rest by **scarcity-weighted burn** and take the lowest.

### Why one score instead of price and capacity as separate rules

The service runs on flat subscriptions, so the per-attempt dollar figure is not what is
actually being spent. What is being spent is a provider's rolling usage window, and
running one dry can remove that pool for days. Effective list price is the best available
proxy for how fast a model drains its window, which is why routing minimizes it — not
because it is a billing estimate.

Those two concerns point the same way nearly always: the cheapest adequate model burns the
least headroom, so cheapest-first *is* headroom preservation. They diverge only near a
limit, where continuing to feed the cheap-but-nearly-spent pool trades a small saving for a
large outage risk. So the two are combined into one number — burn rate scaled by pool
scarcity:

| Window spent | Scarcity multiplier | Effect on routing |
| --- | --- | --- |
| 0–50% | ~1.0–1.2 | none; the cheapest adequate model wins outright |
| 60% | ~1.6 | still normally cheapest-first |
| 70% | ~2.4 | begins to overcome a small price gap |
| 80% | ~4.2 | work moves to the other provider |
| 90%+ | ~7.4+ | the strained pool is effectively reserved |

The curve is deliberately flat below the knee: reacting to routine consumption would mean
chasing quota jitter instead of picking the cheapest adequate model. There is no pool
rotation rule — rotating would spend headroom with no evidence it needs spending.

An unknown capacity reading is neutral (multiplier 1.0), never optimistic and never a
fabricated estimate. Dormancy may only break a tie, at less than any real price gap.

Measured task-type success and retry cost are not yet inputs: the launcher reports no
trusted token usage, so that evidence does not exist. Attempts durably record the price
snapshot active when they ran, which is what will make that comparison possible later
without rewriting history.

If an issue is temporarily unroutable, leave it unclaimed and continue through the queue.
Retry it on later polls. Capacity scheduling never creates `autoship-held`, spends a
repair attempt, or pages the operator.

Current live lanes:

<!-- BEGIN GENERATED LIVE MODEL LANES -->
| Routes served | Role | `agent:*` label | `model:*` label | CLI model | Pool | Frontier |
| --- | --- | --- | --- | --- | --- | --- |
| tiny, cheap, standard | tiny | `agent:claude` | `model:claude-haiku-4.5` | `claude-haiku-4-5-20251001` | `claude-subscription` | no |
| capable, hard | capable | `agent:claude` | `model:claude-sonnet-5` | `claude-sonnet-5` | `claude-subscription` | no |
| frontier | frontier-reserve | `agent:claude` | `model:claude-opus-4.8` | `claude-opus-4-8` | `claude-subscription` | **yes** |
| ultra-frontier | ultra-frontier-reserve | `agent:claude` | `model:claude-fable-5` | `claude-fable-5` | `claude-subscription` | **yes** |
| tiny, cheap | tiny | `agent:codex` | `model:gpt-5.4-mini` | `gpt-5.4-mini` | `codex-subscription` | no |
| standard | standard | `agent:codex` | `model:gpt-5.6-luna` | `gpt-5.6-luna` | `codex-subscription` | no |
| capable, hard | capable | `agent:codex` | `model:gpt-5.6-terra` | `gpt-5.6-terra` | `codex-subscription` | no |
| capable | capable | `agent:codex` | `model:gpt-5.4` | `gpt-5.4` | `codex-subscription` | no |
| frontier, ultra-frontier | frontier-reserve | `agent:codex` | `model:gpt-5.6-sol` | `gpt-5.6-sol` | `codex-subscription` | **yes** |
| frontier | frontier-reserve | `agent:codex` | `model:gpt-5.5` | `gpt-5.5` | `codex-subscription` | **yes** |
<!-- END GENERATED LIVE MODEL LANES -->

Run `npm run docs:routing` after changing `src/models.ts`.

## 6. Assignment labels and overrides

`dispatch:ready` is the sole normal admission signal. A ready issue also carries exactly
one valid `type:*`, `priority:*`, and business `risk:*` label. Legacy workload and
assignment labels remain migration signals, but are advisory/stale and cannot wedge the
queue. After the
durable claim, the dispatcher rewrites them best-effort for visibility.

### Model-level overrides (human-override)

Only `route:human-override` makes assignment labels authoritative. It requires exactly one
compatible `agent:*` and `model:*`; `effort:*` is optional. Without explicit effort, the
dispatcher still derives it. Invalid explicit overrides are visible human-input errors
rather than silently ignored instructions.

### Agent-level overrides (pickup-time constraint)

An issue with a single `agent:*` label constrains the initial pickup to that agent:
`agent:codex`, `agent:claude`, or `agent:opencode`. The dispatcher then selects the best
compatible model and effort within that agent's supported routes using the standard
capacity-aware ranking. `agent:opencode` is valid even though OpenCode remains
fallback-only during normal routing.

When multiple `agent:*` labels conflict on the same issue, the dispatcher blocks the issue
with the `blocked` label and posts a comment once. It does not claim the issue until
exactly one `agent:*` label remains.

Agent overrides:
- work independently of model-level overrides (but not simultaneously);
- respect existing capacity and tier constraints;
- do not override the `route:human-override` signal;
- do not change the frontier or quota handoff policy.

Overrides pin the initial launch only. Automatic quota handoff and the normal repair →
frontier → exhaustion contract still apply. Override attempts are recorded but excluded
from the learning dataset.

## 7. Quota handoff

A quota exit changes capacity, not task difficulty. The dispatcher re-routes the existing
run inside the original capability band, preserving assigned effort and branch state.
"Comparable" is defined by the registry, not by tier arithmetic: a handoff goes to another
pool whose model also serves the assigned route, so Sonnet exhaustion hands off to the
comparable Codex lane before Opus or Sol. A quota handoff does not consume the frontier
rung.

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

- the per-axis justification the issue-text assessment produced, so a route can be
  explained later even though no label records those axes any more.

Restart and later delivery phases restore this original assignment. Frontier use in one
phase does not rewrite it — escalation walks the *assigned route* ladder, not the current
model's home tier, so a frontier model borrowed to repair one phase leaves the next phase's
ordinary repairs on the original route.

Attempt telemetry records the same sanitized routing evidence, plus the **price snapshot
active when the attempt ran**, so a later price change cannot rewrite historical cost.

Token counts remain `unavailable` until a trusted launcher signal exists; they are never
fabricated, and never estimated from elapsed time. The three economic measures stay
strictly separate and each carries its provenance:

| Measure | Meaning | Today |
| --- | --- | --- |
| Billed cost | An amount a provider or billing source explicitly reported | unavailable — never inferred |
| List-price equivalent | The price snapshot applied to *trusted* token usage | unavailable — no trusted usage exists |
| Subscription consumption | Usage-window/capacity consumed; not converted to currency | unavailable |

A total nothing contributed to is reported as unavailable, not as `$0.00`. Terminal issues
receive a cost summary comment that names each unavailable measure explicitly; the durable
telemetry record is authoritative, and failing to post that comment never changes delivery
status.

## Operator-involvement invariant

Initial routing, effort selection, adapter failure, exhausted subscriptions, and stale
suppressions are scheduling states. They wait, retry, rotate, or hand off automatically.
Only genuinely invalid/revoked credentials across all providers, absence of any technically
capable configured model, an explicit invalid human override, or the existing fully spent
repair → frontier → durable exhaustion path can require an operator.

## Recovery routing and model ladder climbing (#75)

When a repair attempt fails, the dispatcher uses progressive model escalation instead of
retrying the same model exhaustively. Each recovery phase (agent, CI, merge, deploy) has a
per-provider model ladder defined by ascending tier rank.

### Model ladder construction

A ladder for a phase starts with the assigned model and includes all higher non-frontier
models from the same provider, ordered by tier:

| Provider | Ladder (example) |
|---|---|
| Anthropic (Claude) | `claude-haiku` → `claude-sonnet` → (frontier: `claude-opus`) |
| OpenAI (Codex) | `gpt-5.4-mini` → `gpt-5.6-luna` → `gpt-5.6-terra` → (frontier: `gpt-5.5` / `gpt-5.6-sol`) |
| OpenCode (fallback) | `deepseek-v4-flash` → `minimax-m3` → `glm-5.2` → (frontier: `kimi-k3`) |

Frontier and ultra-frontier models do not appear in the ladder itself; they are the final
escalation after the ladder is exhausted.

### Recovery decision flow

For each failure in a phase:

1. If the assigned model has retries remaining, retry the same model.
2. If same-model retries are exhausted and a next ladder rung exists, escalate to that model.
3. Repeat step 2 (ladder climbing) until the ladder is exhausted.
4. After ladder exhaustion, attempt the configured frontier model exactly once.
5. Failure after frontier escalation is durable exhaustion; hold and page.

Ladder climbing is evidence-driven by failure category (transient, deterministic,
context/capacity). Transient failures retry the same model within its allocated budget;
deterministic (test, implementation) failures climb immediately after retries. Context
and capacity exhaustion do not retry the same model; they climb directly.

### Effort on ladder rungs

Effort is determined by the ladder rung's tier, not a blanket maximum:

- Haiku (tiny) → effort:low or effort:medium (same route)
- Sonnet (capable) → effort:medium or effort:high (same route)
- Opus (frontier) → effort:xhigh (frontier reserve)

This preserves frontier effort for only the final reserve rung, preventing unnecessary
spend on intermediate capabilities. Effort is independent per phase, so frontier use in
CI does not promote agent repair to frontier effort.

### Durable state and recovery resumption

Recovery state tracks:
- Attempts on the current rung
- Ladder index (which rung we're on)
- Escalated flag (frontier reached)

On resumption after interruption, the ladder is reconstructed from the current model.
Each attempt is recorded in telemetry with its model, effort, and rung progression.

## Priority and future providers

`priority:queue-jump`, `priority:normal`, and `priority:background` control order only.
They never select model or effort. Legacy `queue jump` and `technical debt` labels migrate
to `priority:queue-jump` and `priority:background`.

To add a provider, add the complete disabled catalog entry in `src/models.ts`, implement
its launch and bounded capacity adapters, test its safety contract, then enable it. Never
mirror the model allowlist outside the registry.

## OpenCode Zen quota-exhaustion fallback (#56)

OpenCode Zen is a consumption-based fallback provider, not a normal dispatch provider.
Codex and Claude are the primary subscription providers; OpenCode is used only after
both primary providers are confirmed exhausted for the same quota window (5-hour, weekly,
or monthly).

### Pickup and normal routing

OpenCode models are marked `fallbackOnly` in the registry and excluded from
`dispatchableModels()`, so they never participate in normal issue pickup or scarcity-weighted
routing. Only the primary providers (Codex and Claude) are candidates at assignment time.

### Quota-window exhaustion and fallback

When a run fails with both primary providers exhausted for the same window, the recovery
ladder tries OpenCode *instead of* escalating the route tier. The selection preserves the
original route tier and effort, preventing silent tier escalation across phases.

**Window preference order** (applies only to the triggering failure):
1. 5-hour: OpenCode eligible if both exhausted for the 5-hour window
2. Weekly: OpenCode eligible if both exhausted for the weekly window
3. Monthly: OpenCode eligible if both exhausted for the monthly window

### Deterministic OpenCode model selection

Within the selected route tier, the dispatcher chooses the first eligible candidate from
the preference table, per `src/opencode-fallback.ts`:

| Route | Model 1 | Model 2 | Model 3 |
|---|---|---|---|
| `tiny` / `cheap` | DeepSeek V4 Flash | MiniMax M3 | Grok Build 0.1 |
| `standard` | MiniMax M3 | Grok Build 0.1 | DeepSeek V4 Flash |
| `capable` / `hard` | GLM 5.2 | DeepSeek V4 Pro | Kimi K2.7 Code |
| `frontier` | DeepSeek V4 Pro | GLM 5.2 | Kimi K3 or Qwen3.7 Max |
| `ultra-frontier` | Kimi K3 | Qwen3.7 Max | DeepSeek V4 Pro |

Grok Build 0.1 is selected for a `standard` fallback only when:
- both Codex and Claude are exhausted for the relevant window;
- Zen paid balance is available;
- MiniMax M3 is unavailable, disabled, incompatible, or has already failed; and
- Grok Build is eligible.

Models are filtered out if:
- disabled in the OpenCode configuration;
- not from OpenCode (e.g., Anthropic or OpenAI models exposed through Zen);
- already failed in the current fallback sequence (prevents loops);
- capacity exhausted in the `opencode-zen` pool.

### Free-model last resort

If OpenCode's monthly paid Zen limit is exhausted, the dispatcher may attempt one free
Zen model, but only after:
- both Codex and Claude are exhausted for the *monthly* window;
- paid Zen balance is truly exhausted (not just unavailable);
- free monthly quota remains; and
- the monthly reset time hasn't passed.

**Free-model order** (try at most one):
1. `deepseek-v4-flash-free`
2. `mimo-v2.5-free`
3. `north-mini-code-free`

Free fallback is not activated by OpenCode's 5-hour or weekly limit alone, and Big
Pickle and other opaque free models are excluded unless they later receive stable
capability metadata.

### Telemetry and evidence

Every OpenCode attempt records:
- provider lane (`opencode-zen`), selected model, route, effort
- fallback trigger window (5-hour/weekly/monthly)
- Codex and Claude exhaustion evidence for that window
- whether paid Zen or free last resort
- price snapshot, Zen balance state at attempt time
- provider-reported usage and billed amount if available
- final outcome

The exhaustion evidence persists through `src/exhaustion-state.ts`, which tracks
per-provider, per-window exhaustion with reset times and signal classifications.

### Configuration

OpenCode fallback is enabled via environment:
- `OPENCODE_API_KEY`: OpenCode API key (required if fallback enabled)
- `OPENCODE_FALLBACK_ENABLED`: true/false (defaults to false for safety)

Fallback is disabled by default. Enable only if OpenCode Zen credentials are configured
and the organization has Zen balance.
