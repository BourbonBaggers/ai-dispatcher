# Agent guide — ai-dispatcher (standalone service)

This is the guide for an agent working **on** the `ai-dispatcher` service itself (not for
the agents it launches). Read it before changing code here.

## What this is

A standalone, self-contained extraction of the AI Issue Dispatcher that used to live
inside `BourbonBaggers/internal-tools` (issue #320). It polls a GitHub repo and runs Codex
/ Claude Code on labelled issues, ending at a draft PR. This repository is its only
home: the embedded copy in `internal-tools` has been removed.

## Hard rules

- **Zero runtime dependencies.** The only dependency is `typescript`, and it is a
  *devDependency* used solely for `npm run typecheck`. Everything at runtime is the Node
  24 standard library (`node:child_process`, `node:fs`, `node:test`, `fetch`, …). Do not
  add a runtime dependency — if you reach for one, solve it with the stdlib instead.
- **No build step.** Node 24 strips TypeScript types natively. There is no `dist/`, no
  bundler. Source runs directly (`node bin/ai-dispatcher.mjs`, `node --test`).
- **Node 24 strip-only TS.** No parameter properties, no `enum`, no `namespace`, no
  decorators — anything requiring type-directed emit. Use explicit field declarations and
  `as const` objects. `verbatimModuleSyntax` is on: `import type` for types, and import
  `.ts` paths explicitly (`./config.ts`).
- **No hard-coded repository, ever.** Repository identity comes from `--repo` /
  `DISPATCHER_REPO`, is validated in `config.ts`, and is threaded through every `gh` call
  and the launch environment. There is no `BourbonBaggers/internal-tools` fallback
  anywhere; a missing/malformed repo fails fast. Keep it that way.
- **Untrusted input stays data.** Labels are looked up in frozen maps, never shell-expanded.
  Issue titles/bodies/comments never enter a command line: free-form bodies go over stdin
  (`--body-file -`), and the issue body is fetched by the launched agent itself, never
  interpolated into the prompt or a `gh` argument.

## Layout

```
bin/ai-dispatcher.mjs     executable shim → src/main.ts
src/
  config.ts               CLI + env parsing, repo validation (no fallback)
  models.ts               the curated model/provider registry — one data source (#319)
  labels.ts               the agent/model/effort/priority allowlist; model:* derived from models.ts
  capacity.ts             honest capacity ladder + dormancy signal (pure, #319)
  routing.ts              minimum-viable routing rubric + cost-driven escalation (pure, #319)
  telemetry.ts            attempt/issue evidence records + atomic store + aggregation (#319)
  report.ts               pure Markdown routing analytics (`ai-dispatcher report`, #319)
  github.ts               gh CLI wrapper (argv arrays, repo threaded through)
  selection.ts            pure issue eligibility + priority-tier ordering
  token-exhaustion.ts     provider-owned exhaustion detection + cooldown math (pure)
  state.ts                atomic file-backed store + single-instance lock
  runner.ts               launch argv/env + terminal-state classification + supervision
  capture.ts              the uncommitted-work capture DECISION (mirrors the shell)
  sanitize.ts             redaction + stream-json rendering + control-line parsing
  notify.ts  logger.ts    ntfy push + JSON line logger (both best-effort/zero-dep)
  dispatcher.ts           the scan/claim/launch/resume/reconcile loop; records attempt telemetry
  main.ts                 entrypoint: parse → validate → open state → reconcile → loop; `report` subcommand
ROUTING.md                the routing rubric decision table (the planning-repo policy deliverable)
scripts/
  dispatch-agent.sh       the bundled per-run launcher (repo-parameterized, fails fast)
  lib/dispatch-capture.sh the uncommitted-work safety net (sourced by the launcher)
test/                     node:test suites, one per module
```

## Conventions

- **Prefer pure functions.** IO-free decision logic (selection, classification, failure
  policy, capture decision, cooldown math) is exported and unit-tested directly. The loop
  and runner are thin shells over those pieces. Follow this when adding behaviour.
- **Every change ships with tests.** Run `npm test` (110+ cases) and `npm run typecheck`
  before committing. Shell changes must keep `dispatch-agent.sh` / `dispatch-capture.sh`
  passing `shellcheck --severity=error`.
- **Comments explain WHY.** The non-obvious safety invariants (terminal-classification
  precedence, resume budget resetting on progress, capture only on a clean exit, one alert
  per cooldown window) are load-bearing — document the reason when you touch them.

## Capacity-aware routing (#319)

The routing layer is data-driven and pure, and it does **not** override the dispatch path:
the dispatcher still obeys the single `model:*` label on the issue. Routing is decision
support for *choosing* that label (the planning-repo rubric) and for *planning a retry*.

- **`models.ts` is the one source of model config.** `labels.ts` derives the `model:*`
  allowlist from it. Add or change a model there, not in routing/label code. A disabled or
  future-provider entry is documentation and is never dispatchable (`isDispatchable`).
- **Honesty is load-bearing.** Capacity is `unknown` unless a cooldown proves `exhausted`
  — never a fabricated remaining-quota number. Telemetry token counts are `unavailable`
  (the launcher emits none), and success requires merged + deployed + no human repair — a
  clean exit or PR is not success. Do not "improve" these into optimistic fabrications.
- **Frontier is the final automatic recovery rung.** Initial routing still withholds
  frontier models unless task characteristics justify them. After bounded assigned-model
  repairs fail, escalation to the configured frontier model is automatic; only failure
  there is a human handoff.
- **Manual overrides** (`route:human-override`) are recorded but excluded from the learning
  dataset — keep that exclusion intact.
- The rubric itself lives in [`ROUTING.md`](ROUTING.md); keep it in sync with the code.

## The safety invariants (do not regress)

- Terminal classification precedence: token-exhaustion → timeout → no-result(interrupted)
  → zero-commits(failed) → CI-red(failed) → CI-pending(succeeded/unverified) → succeeded →
  failed. The no-result branch **must** precede the commit/CI branches, or a blind kill is
  misjudged as a hard failure and its resumable work is dropped.
- Token-exhaustion requires a non-zero exit AND provider-owned output — issue text an
  agent echoes must never manufacture a cooldown.
- Capture uncommitted work only on `exit==0 && commitsAhead==0 && dirty`; a timeout/crash
  may have left the tree half-written.
- A resumable run keeps its `agent-working` claim; only a genuinely terminal run releases
  it.
