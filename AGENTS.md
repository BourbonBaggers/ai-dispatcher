# Agent guide — ai-dispatcher (standalone service)

This is the guide for an agent working **on** the `ai-dispatcher` service itself (not for
the agents it launches). Read it before changing code here.

## What this is

A standalone, self-contained extraction of the AI Issue Dispatcher that used to live
inside `BourbonBaggers/internal-tools` (issue #320). It polls a GitHub repo and runs Codex
/ Claude Code on labelled issues. Without autoship it hands off a draft PR; with autoship
configured it owns the entire path through merge, deploy, health verification, rollback,
and issue closure. This repository is its only home: the embedded copy in
`internal-tools` has been removed.

## The operating contract

For an assigned issue, coding, CI, merge, and deployment are automation-owned. The
operator is involved only after all of the following have happened for the failing phase:

1. the assigned model made the configured number of repair attempts;
2. the dispatcher automatically escalated to the configured frontier model (currently
   Opus 4.8);
3. that frontier attempt failed too; and
4. the run carries durable `exhaustion` evidence and `autoship-held`.

Everything before that is an internal recovery state, not an operator handoff. Red CI,
merge conflicts (including Markdown conflicts), non-zero exits, timeouts, unknown
production state, failed deploys, and failed rollback verification must repair, resume,
retry, or escalate automatically. Do not add a review gate, destructive-change gate,
manual production-verification step, or first-failure hold. Backups and rollback are the
deployment safety net. A high-priority operator notification is allowed only from the
durable exhausted path.

Legacy `held` records without durable exhaustion proof are automatically un-held and
resumed. A current hold with proof retains its issue claim; removing `autoship-held`
resumes the existing PR rather than starting the issue over.

`AGENTS.md` is the canonical agent-context file. `CLAUDE.md` must remain a repository
symlink to it so Codex and Claude receive exactly the same rules. Historical plans under
`docs/plans/` are records, not instructions; current code, this file, and the README win.

## Hard rules

- **Zero runtime dependencies.** `typescript` and `@types/node` are devDependencies used
  solely for `npm run typecheck`. Everything at runtime is the Node 24 standard library
  (`node:child_process`, `node:fs`, `node:test`, `fetch`, …). Do not add a runtime
  dependency — if you reach for one, solve it with the stdlib instead.
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
  author-auth.ts          fail-closed original-issue-author authorization
  models.ts               the curated model/provider registry — one data source (#319)
  labels.ts               the agent/model/effort/priority allowlist; model:* derived from models.ts
  capacity.ts             honest capacity ladder + dormancy signal (pure, #319)
  routing.ts              minimum-viable routing rubric + cost-driven escalation (pure, #319)
  telemetry.ts            attempt/issue evidence records + atomic store + aggregation (#319)
  report.ts               pure Markdown routing analytics (`ai-dispatcher report`, #319)
  github.ts               gh CLI wrapper (argv arrays, repo threaded through)
  selection.ts            pure issue eligibility + priority-tier ordering
  token-exhaustion.ts     provider-owned exhaustion detection + cooldown math (pure)
  recovery-policy.ts      per-phase repair → frontier → exhausted ledger (pure)
  state.ts                atomic file-backed store + single-instance lock
  exec.ts                 bounded output + timeout-safe process-tree supervision
  runner.ts               launch argv/env + terminal-state classification + supervision
  autoship-deployment.ts  structured deploy/health/rollback result classification
  autoship.ts             CI/merge/deploy orchestration; no hold before exhaustion
  generated-conflict-*.ts generated-only resolution + agent conflict-repair plumbing
  capture.ts              the uncommitted-work capture DECISION (mirrors the shell)
  sanitize.ts             redaction + stream-json rendering + control-line parsing
  notify.ts  logger.ts    ntfy push + JSON line logger (both best-effort/zero-dep)
  dispatcher.ts           the scan/claim/launch/resume/reconcile loop; records attempt telemetry
  main.ts                 entrypoint: parse → validate → open state → reconcile → loop; `report` subcommand
ROUTING.md                the routing rubric decision table (the planning-repo policy deliverable)
scripts/
  dispatch-agent.sh       the bundled per-run launcher (repo-parameterized, fails fast)
  lib/dispatch-capture.sh the uncommitted-work safety net (sourced by the launcher)
  self-ship.sh            detached restart, health verification, and rollback
  shellcheck-ci.sh        bounded tracked-shell-file ShellCheck wrapper
test/                     node:test suites, one per module
```

## Conventions

- **Prefer pure functions.** IO-free decision logic (selection, classification, recovery
  policy, capture decision, cooldown math) is exported and unit-tested directly. The loop
  and runner are thin shells over those pieces. Follow this when adding behaviour.
- **Every change ships with tests.** Run `npm test` (currently 260+ cases) and
  `npm run typecheck` before committing. Shell changes must pass
  `shellcheck --severity=error` for every changed shell file; run
  `scripts/shellcheck-ci.sh` for the repository-wide check.
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
  there is a human handoff. The original assignment is immutable in durable state:
  frontier use in one phase must not turn the next phase's ordinary repair attempts into
  more frontier attempts.
- **Manual overrides** (`route:human-override`) are recorded but excluded from the learning
  dataset — keep that exclusion intact.
- The rubric itself lives in [`ROUTING.md`](ROUTING.md); keep it in sync with the code.

## The safety invariants (do not regress)

- Terminal classification precedence: token-exhaustion → timeout → signal/no-result
  (`interrupted`) → zero-commits (`failed`) → CI-red (`ci_failed`) → CI-pending
  (`ci_pending`) → clean/green (`pr_ready`) → failed. The no-result branch
  **must** precede the commit/CI branches, or a blind kill is misjudged as a hard failure
  and its resumable work is dropped.
- Token-exhaustion requires a non-zero exit AND provider-owned output — issue text an
  agent echoes must never manufacture a cooldown.
- Capture uncommitted work only on `exit==0 && commitsAhead==0 && dirty`; a timeout/crash
  may have left the tree half-written.
- A resumable run keeps both `agent-working` and its durable issue claim.
  `pr_ready` and `held` release the working label but retain the issue claim; without
  that distinction, an open handoff or exhausted issue is redispatched from scratch.
- Before a ship command can merge or self-restart, persist `ci_pending` so a killed parent
  leaves a recoverable claim. Detached self-deploy result state starts as `pending`; a
  restarted dispatcher waits for that verifier instead of launching another restart.
- The runner persists `finalizationPending` with every terminal observation before
  returning it. A restart must finish that exact run's recovery/autoship before selecting
  fresh work; replayed telemetry is idempotent.
- Self-ship failure resets to last-known-good and keeps restarting until healthy. The
  shell must not page on an intermediate new-code or rollback start failure; the
  restarted dispatcher’s durable recovery ledger owns escalation and exhaustion.
- Ship-command timeout must terminate the whole process tree, retain output without a
  `maxBuffer` abort, and return a repairable timeout. The default ceiling is 120 minutes.
- A GitHub read failure is `unknown`, never fabricated red CI or proof that an exhausted
  hold label was removed. Unknown state parks and rechecks without spending model budget.
- A historical merged SHA that production already contains is delivered. Never deploy it
  exactly over a newer production SHA; that would be an automated rollback.
- `shipped` means merge + production health + issue closure. Merge alone, green CI, a PR,
  or exit zero is not shipped.
