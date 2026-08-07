# Agent guide — ai-dispatcher (standalone service)

This is the guide for an agent working **on** the `ai-dispatcher` service itself (not for
the agents it launches). Read it before changing code here.

## What this is

A standalone, self-contained AI Issue Dispatcher. It polls a GitHub repo and runs Codex /
Claude Code on labelled issues. Without autoship it hands off a ready PR; with autoship
configured it owns the entire path through merge, deploy, health verification, rollback,
and issue closure.

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
symlink to it so Codex and Claude receive exactly the same rules. Local planning artifacts
are not part of the public tree; current code, this file, and the README win.

## Operator authorization

The operator expects this repository to be maintained by one coding agent at a time and
authorizes that agent to treat the local checkout as disposable when necessary: fetch and
reset to the latest upstream code, overwrite local branches or uncommitted work, merge
ready PRs, and run the normal autoship/deploy path for this service without adding a
manual gate. Do this with the same care as the dispatcher would use for its own issues:
preserve durable safety evidence, run the relevant tests, and report exactly what was
changed or shipped.

## Mandatory startup synchronization

This checkout is shared between the dispatcher on the development server and local
interactive sessions. Before inspecting work, editing files, running tests against a
planned change, or making GitHub changes, synchronize with upstream; never assume the
checkout is current because a previous session fetched it.

1. Run `git fetch origin --prune`.
2. Inspect `git status --short --branch`, `git log --oneline --decorate -5`, and the
   configured base branch. This repository's base is `origin/main` unless the task
   explicitly says otherwise.
3. Compare `HEAD` with `origin/main`. If upstream is ahead, bring the checkout to the
   latest upstream before continuing. A clean checkout may be fast-forwarded; a stale
   or deleted feature branch should be based on the current `origin/main` rather than
   treated as authoritative.
4. If local changes exist, preserve them explicitly before synchronizing: use a named
   branch or a clearly named stash that includes untracked files, then reapply the
   changes onto the current upstream. Inspect the resulting diff for conflicts and
   verify that no local work was silently discarded.
5. Report the upstream commit used and any preserved/reapplied local work in the
   session summary. Do not claim to be working from latest code until this check is
   complete.

Synchronization is a prerequisite, not optional housekeeping. If fetch or
reconciliation fails, stop before making changes and report the exact Git state. The
only exception is an explicitly isolated investigation that does not modify the
checkout; even then, identify the commit under inspection.

## Operational environment: local Mac vs production dev server

The interactive checkout is on a Mac, but the running dispatcher for this repository
is a production service on the development server. The Mac is for editing, local tests,
and GitHub-oriented work; it is not the source of truth for dispatcher status, durable
state, autoship, deployment, health verification, rollback, systemd, or live agent
processes.

Before checking or changing any live dispatcher behavior, connect to the configured dev
server over SSH and inspect the production service there. Do not infer that “no local
dispatcher process” means the service is down, and do not run autoship or deployment
commands from the Mac merely because the repository is checked out there.

The server-side dispatcher runs with a service-specific PATH that includes the installed
`gh`, Node, and agent CLIs. An interactive SSH shell may not have that PATH. For live
commands, use the service unit's PATH from the private operator context (if present), or
reproduce it explicitly; otherwise `gh` lookup failures can masquerade as GitHub or
autoship failures. Never print or commit the server `.env` contents.

If this trusted checkout contains `AGENTS.private.md`, read it after this file. It is
intentionally gitignored and may contain the operator's server hostname, paths, unit
names, and exact connection/PATH procedures. Its absence is normal in a public clone;
the public instructions above remain sufficient to avoid treating the Mac as
production.

## Interactive work is not dispatcher intake

There are two distinct operating modes:

1. **Interactive work:** the operator asks the current session to create, investigate,
   or finish an issue directly. The current session owns the implementation and works
   the ticket through its requested outcome.
2. **Dispatcher work:** the production service discovers and claims an issue through
   the GitHub intake contract, adds ownership labels, runs an isolated agent, and owns
   recovery/autoship.

When working interactively, do not add or retain dispatcher-intake/ownership labels:

- `dispatch:ready`
- `agent-working`
- `agent:*`
- `model:*`
- `effort:*`
- `route:*`

Those labels are operational signals, not generic progress markers. Adding them to an
interactive ticket can cause the production dispatcher to claim the same work, create
conflicting ownership, and leave stale `agent-working` state when the interactive
session finishes. Ordinary descriptive labels such as `type:*`, `risk:*`, and
`priority:*` may be used when useful, but they do not authorize pickup.

An issue created for interactive work must remain without `dispatch:ready` unless the
operator explicitly asks to hand it to the production dispatcher. Before taking an
already-labelled issue over interactively, remove stale dispatcher ownership/admission
labels as appropriate, verify the production dispatcher has not claimed it, and then
work the existing issue/branch/PR rather than creating a competing run. Add dispatcher
labels only as an explicit final handoff after the interactive work is complete and the
issue is intentionally ready for autonomous pickup.

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
  and the launch environment. A missing/malformed repo fails fast. Keep it that way.
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
  token-exhaustion.ts     provider-capacity signal classification + suppression policy (pure, #32)
  recovery-policy.ts      per-phase repair → frontier → exhausted ledger (pure)
  state.ts                atomic file-backed store + single-instance lock
  exec.ts                 bounded output + timeout-safe process-tree supervision
  runner.ts               launch argv/env + terminal-state classification + supervision
  autoship-deployment.ts  structured deploy/health/rollback result classification
  autoship.ts             CI/merge/deploy orchestration; no hold before exhaustion
  generated-conflict-*.ts generated-only resolution + agent conflict-repair plumbing
  capture.ts              the uncommitted-work capture DECISION (mirrors the shell)
  sanitize.ts             redaction + stream-json rendering + control-line parsing
  dashboard.ts            read-only one-page status dashboard + SSE stream endpoints
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
  precedence, finite resume budgets, capture only on a clean exit, one alert
  per cooldown window) are load-bearing — document the reason when you touch them.

## Capacity-aware pickup routing (#319, #34)

The routing layer is data-driven and pure. A recognized workload-characteristic label
admits new work; `dispatch:ready` explicitly admits work relying on all defaults. The
dispatcher then derives provider, model, and effort at pickup from those characteristics
plus bounded live capacity evidence. Legacy assignment labels remain an admission signal
but are advisory. Only `route:human-override` makes a compatible agent/model pair and
optional effort authoritative for the initial launch.

- **`models.ts` is the one source of model config.** `labels.ts` derives the `model:*`
  allowlist from it. Add or change a model there, not in routing/label code. A disabled or
  future-provider entry is documentation and is never dispatchable (`isDispatchable`).
- **Honesty is load-bearing.** Codex app-server and Claude OAuth usage windows may provide
  live capacity. A bounded adapter failure is `unknown`, never fabricated headroom.
  Telemetry token counts remain `unavailable` (the launcher emits none), and success
  requires merged + deployed + no human repair — a clean exit or PR is not success.
- **Route residual work, not institutional importance.** This service runs for a small,
  trusted operation with CI, health verification, rollback, and automatic recovery.
  Production adjacency, file count, and explicit safety states do not by themselves raise
  model tier. Model tier tracks unresolved approach selection; execution breadth belongs
  in effort, and risk is the harm that can escape the safeguards actually present.
- **Frontier is the final automatic recovery rung.** Initial routing still withholds
  frontier models unless task characteristics justify them. After bounded assigned-model
  repairs fail, escalation to the configured frontier model is automatic; only failure
  there is a human handoff. The original assignment is immutable in durable state:
  frontier use in one phase must not turn the next phase's ordinary repair attempts into
  more frontier attempts.
- **Manual overrides** (`route:human-override`) are recorded but excluded from the learning
  dataset — keep that exclusion intact.
- **Capacity is scheduling, not handoff.** Adapter failure, exhausted pools, stale
  assignment labels, and temporarily unroutable issues wait, rotate, revalidate, or hand
  off automatically. They never create `autoship-held`, spend repair budget, or page.
- The rubric itself lives in [`ROUTING.md`](ROUTING.md); keep it in sync with the code.

## The safety invariants (do not regress)

- Terminal classification precedence: provider-capacity signal → timeout → signal/no-result
  (`interrupted`) → zero-commits (`failed`) → CI-red (`ci_failed`) → CI-pending
  (`ci_pending`) → clean/green (`pr_ready`) → failed. The no-result branch
  **must** precede the commit/CI branches, or a blind kill is misjudged as a hard failure
  and its resumable work is dropped.
- A provider-capacity signal requires a non-zero exit AND provider-owned output — issue
  text, repository fixtures, test names, diffs, and command output an agent echoes must
  never manufacture a cooldown. Codex runs in JSONL mode because its plain mode mixes
  provider diagnostics and untrusted tool output on stderr; only structured error events
  or narrowly anchored provider banners are capacity evidence.
- Provider suppression is evidence-driven and self-revalidating (#32): the signal kind
  (authoritative reset / unconfirmed quota / throttling / context-exhaustion / billing /
  unknown) and provider are both load-bearing — Claude's documented rolling-window
  fallback must never apply to Codex or any other provider, and context/request-size
  exhaustion must never suppress the whole pool. An unconfirmed no-reset signal gets a
  short bounded revalidation, not a blind long fallback, and the durable evidence
  (kind, confidence, detection time, reported reset, redacted excerpt) must survive
  restart. A run whose own evidence already proves delivery-ready (commits + PR + green
  CI) is reconciled to `pr_ready` rather than stranded behind a cooldown that no longer
  matters for that issue — but the suppression itself is still recorded, since it can
  still block new launches on that provider. That reconciled `pr_ready` state is valid
  autoship evidence despite the non-zero provider exit. If a fresh CI read parks it as
  `ci_pending`, that state retains the same artifact trust across later scans. A restart
  must re-enter autoship for either retained state when autoship is configured.
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
- Launcher control records travel on a dedicated file descriptor that is closed in the
  provider process. Agent stdout is untrusted output and can never manufacture a PID,
  result, PR, CI verdict, or closed-issue disposition.
- Self-ship failure resets to last-known-good and makes bounded restart attempts. The
  shell records terminal rollback failure; it must
  not leave a detached infinite restart loop or page directly. The restarted dispatcher’s
  durable recovery ledger owns escalation and exhaustion.
- Ship-command timeout must terminate the whole process tree, retain output without a
  `maxBuffer` abort, and return a repairable timeout. The default ceiling is 120 minutes.
- A GitHub read failure is `unknown`, never fabricated red CI or proof that an exhausted
  hold label was removed. Unknown state parks and rechecks without spending model budget.
- Exit zero from a ship command is not production evidence. A terminal structured status
  with merged and deployed SHA evidence plus passing health is required for `shipped`.
- Every agent relaunch consumes finite resume budget even when the provider emits output;
  startup chatter is not durable progress. A new repair/frontier rung resets its own
  resume allowance.
- The state store keeps an atomic recovery copy. It restores claims from that copy after
  primary corruption and fails closed if neither copy is readable; it never starts with
  an empty queue and redispatches claimed issues.
- A historical merged SHA that production already contains is delivered. Never deploy it
  exactly over a newer production SHA; that would be an automated rollback.
- Issue closure is not an alternate terminal signal. If an issue closes before verified
  production (including via an accidental PR auto-close keyword), reopen it and retain
  the claim until autoship proves delivery.
- `shipped` means merge + production health + issue closure. Merge alone, green CI, a PR,
  or exit zero is not shipped.
