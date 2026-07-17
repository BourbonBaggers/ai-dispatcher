# Agent guide — ai-dispatcher (standalone service)

This is the guide for an agent working **on** the `ai-dispatcher` service itself (not for
the agents it launches). Read it before changing code here.

## What this is

A standalone, self-contained extraction of the AI Issue Dispatcher that used to live
inside `BourbonBaggers/internal-tools` (issue #320). It polls a GitHub repo and runs Codex
/ Claude Code on labelled issues, ending at a draft PR. Its final home is its own repo
(`~/Developer/ai-dispatcher`); it currently sits under `services/ai-dispatcher/` only
because the extraction PR targets the monorepo.

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
  labels.ts               the frozen agent/model/effort/priority allowlist contract
  github.ts               gh CLI wrapper (argv arrays, repo threaded through)
  selection.ts            pure issue eligibility + priority-tier ordering
  token-exhaustion.ts     provider-owned exhaustion detection + cooldown math (pure)
  failure-policy.ts       3-strike per-issue deferral (pure)
  state.ts                atomic file-backed store + single-instance lock
  runner.ts               launch argv/env + terminal-state classification + supervision
  capture.ts              the uncommitted-work capture DECISION (mirrors the shell)
  sanitize.ts             redaction + stream-json rendering + control-line parsing
  notify.ts  logger.ts    ntfy push + JSON line logger (both best-effort/zero-dep)
  dispatcher.ts           the scan/claim/launch/resume/reconcile loop
  main.ts                 entrypoint: parse → validate → open state → reconcile → loop
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
