# ai-dispatcher

Standalone AI issue dispatcher. Polls a GitHub repository, claims one open issue carrying
an `agent:*` + `model:*` label pair, and runs Codex or Claude Code against it in an
isolated checkout — serially, with retries, provider cooldowns, and durable file-backed
state. Without autoship its handoff is a draft pull request. With autoship configured,
the output is a merged PR, verified production deployment, and closed issue.

It is extracted from the AI Issue Dispatcher that lived inside the
`BourbonBaggers/internal-tools` monorepo (issues #188/#232/#234/#245/#249/#281/#307). The
behaviour is ported before it is extended; the one intentional change is that the target
repository is now an explicit, required argument with **no hard-coded fallback** (issue
#320). This package is self-contained: nothing here imports from the monorepo.

> **This repository is the dispatcher's only home.** The extraction is complete — the
> embedded dispatcher has been removed from `internal-tools` along with its Postgres
> tables. Do not copy this service back into that monorepo; see AGENTS.md.

> **Agent context is one file.** `AGENTS.md` is canonical and `CLAUDE.md` is a symlink
> to it. Do not replace the symlink with a divergent Claude-only copy.

## What it does

On each scan (when no run is active):

1. **Resume first.** A run left `interrupted` / `timed_out` / `token_exhausted` still owns
   its issue's claim, so it is picked up before any fresh work — up to an auto-resume cap,
   and never while its provider is in a token cooldown.
2. **Select one fresh issue.** Open issues are evaluated oldest-first and filtered by an
   allowlist contract (below). The single highest-priority eligible issue is chosen by
   tier: `queue jump` → regular → `technical debt`.
3. **Claim, then label.** The state row is the authoritative lock; the `agent-working`
   label is added after the claim so a failed label write cannot desync the claim.
4. **Launch and supervise.** The bundled `dispatch-agent.sh` clones an isolated checkout,
   writes a bootstrap prompt (the issue body is never interpolated — the agent fetches it
   itself), launches the CLI under a wall-clock budget, checkpoints the plan every 60s,
   captures uncommitted work on a clean exit, opens a **draft** PR, and waits for the real
   CI verdict.
5. **Recover or finalize.** Agent/CI/merge/deploy failures retry with the assigned model,
   then get one Opus 4.8 attempt. Only verified production success or exhausted frontier
   failure finalizes the delivery; progress attempts do not page the operator.

For coding, CI, merge, and deploy, `autoship-held` is valid only with durable evidence
that the assigned-model repair budget and the automatic frontier attempt both failed.
Legacy holds without that proof clear and resume themselves. Markdown conflicts are not
a human gate: deterministic generated-file repair handles safe generated-only conflicts,
and all other conflicts enter the agent repair ladder.

The dispatcher is **strictly serial**: only one agent runs at a time, guaranteed by a
single-instance lock plus the fact that each run is driven to completion before the loop
continues.

## The label contract

An issue is eligible only with exactly one supported agent label and one supported model
label (a mismatched pair is rejected, not guessed):

| Label                           | Meaning                                                                            |
| ------------------------------- | ---------------------------------------------------------------------------------- |
| `agent:claude` / `agent:codex`  | which CLI to launch                                                                |
| `model:*`                       | the exact `--model` string; must match the agent — the curated set below           |
| `effort:low\|medium\|high\|max` | per-agent reasoning effort (`max` caps Codex at `high`); default `effort:medium`   |
| `queue jump` / `technical debt` | move the issue between priority tiers                                              |
| `agent-working`                 | the dispatcher is actively on it (added on claim, cleared on non-resumable finish) |
| `needs-input` / `blocked`       | held for a human — skipped, not worked                                             |

The `model:*` allowlist is **data-driven**: it is derived from the curated registry in
`src/models.ts`, not hand-maintained. The live lanes are `model:claude-haiku-4.5` (fast),
`model:claude-sonnet-5` (general / large-context / planning), `model:gpt-5.5` (complex),
and `model:claude-opus-4.8` (frontier reserve). A disabled or future-provider registry
entry is documentation and is not dispatchable.

Labels are never passed to a shell; they are only ever looked up in frozen maps
(`src/labels.ts`), and the constant they resolve to is what reaches the CLI. An unknown
label simply fails to resolve and the issue is skipped with a visible reason.

## Capacity-aware routing & evidence (#319)

The dispatcher validates and obeys the `model:*` label on each issue; it does not choose
or rewrite that label at dispatch time. Issue authors and planning automation use the
deterministic, data-driven rubric to choose the **minimum viable model**, prefer dormant
subscription capacity, and protect the frontier reserve. The full decision table and its
pure decision-support functions are described in [`ROUTING.md`](ROUTING.md).

Every terminal run records an **attempt** into `telemetry.json` (alongside dispatcher
state); attempts fold into per-issue records. The model is honest about what it can't
measure: token counts are `unavailable` (the launcher emits none), capacity is `unknown`
unless a cooldown proves exhaustion, and an issue is _successful_ only when merged **and**
deployed **and** free of material human repair — never on a clean exit or a PR alone.

```bash
# Print the routing analytics report (completed features by model, success by task
# category, first-attempt/retry rates, frontier utilization, recommendations).
node bin/ai-dispatcher.mjs report --state-dir ~/dispatcher/state
```

## Requirements

- **Node.js 24+** (the service runs its TypeScript directly via native type-stripping; no
  build step, no `dist/`).
- **`git`, `gh`, and the agent CLIs** (`codex` and/or `claude`) on `PATH` on the host that
  runs the agents. This is normally the dev server.
- Authentication is owned by those CLIs — `gh auth`, and the agent CLIs' own credentials.
  **This service never stores a GitHub, OpenAI, or Anthropic token.** For a headless box,
  the operator's credentials go in `~/.dispatcher/env` (chmod 600, never committed), which
  `dispatch-agent.sh` sources; this is where `CLAUDE_CODE_OAUTH_TOKEN` (from
  `claude setup-token`) or an `ANTHROPIC_API_KEY` belongs.

## Configuration

Configuration is CLI-flag → environment → documented default. Repository identity is the
one value with no default. Copy `.env.example` to `.env` (never commit it) for the
environment form; every variable is documented there.

| Flag                       | Env                                 | Default                    | Meaning                                                                                        |
| -------------------------- | ----------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------- |
| `--repo <owner/repo>`      | `DISPATCHER_REPO`                   | _(required)_               | target repository; canonical `owner/repository`, validated, no fallback                        |
| `--repo-dir <path>`        | `DISPATCHER_REPO_DIR`               | _(required)_               | pristine mirror clone kept on `origin/main`                                                    |
| `--worktree-dir <path>`    | `DISPATCHER_WORKTREE_DIR`           | _(required)_               | parent dir for per-run checkouts                                                               |
| —                          | `DISPATCHER_ENV_SOURCE_DIR`         | _(optional)_               | checkout whose `.env` seeds each run checkout                                                  |
| `--interval <seconds>`     | `DISPATCHER_POLL_INTERVAL_SECONDS`  | `900`                      | poll interval                                                                                  |
| `--max-minutes <min>`      | `DISPATCHER_MAX_RUNTIME_MINUTES`    | `90`                       | per-run wall-clock budget                                                                      |
| `--state-dir <path>`       | `DISPATCHER_STATE_DIR`              | `./state`                  | durable state directory                                                                        |
| `--autoship-deploy-dir`    | `DISPATCHER_AUTOSHIP_DEPLOYMENT_DIR` | state/repo-specific      | dedicated checkout used only for merge/deploy/rollback                                         |
| `--autoship-timeout-minutes` | `DISPATCHER_AUTOSHIP_TIMEOUT_MINUTES` | `120`                  | complete merge/deploy/verify/rollback command ceiling                                           |
| `--author-auth <mode>`     | `DISPATCHER_ISSUE_AUTHOR_AUTH_MODE` | `author-allowlist`         | `author-allowlist` requires the original issue author to be trusted; `none` allows all authors |
| `--trusted-authors <list>` | `DISPATCHER_TRUSTED_ISSUE_AUTHORS`  | _(required for allowlist)_ | comma-separated GitHub usernames, matched case-insensitively                                   |
| `--log-level <level>`      | `DISPATCHER_LOG_LEVEL`              | `info`                     | `debug\|info\|warn\|error`                                                                     |
| —                          | `NTFY_URL` / `NTFY_TOPIC`           | _(optional)_               | ntfy push notifications; disabled if unset                                                     |

Autoship and recovery also use environment-only configuration:

| Env | Default | Meaning |
| --- | --- | --- |
| `DISPATCHER_AUTOSHIP_CMD` | disabled | repository-specific merge/deploy/health/rollback command |
| `DISPATCHER_GENERATED_CONFLICT_ALLOWLIST` | `docs/memory.md,docs/researcher.md` | exact generated paths eligible for deterministic conflict recovery |
| `DISPATCHER_GENERATED_CONFLICT_REGEN_CMD` | disabled | target-repository command to regenerate allowlisted files |
| `DISPATCHER_GENERATED_CONFLICT_MAX_ATTEMPTS` | `1` | deterministic generated-conflict attempts per pass |
| `DISPATCHER_GENERATED_CONFLICT_CI_WAIT_SECONDS` | `900` | CI wait after generated-conflict repair |
| `DISPATCHER_CI_SELF_HEAL_MAX_ATTEMPTS` | `2` | assigned-model repairs for each of agent/CI/merge/deploy |
| `DISPATCHER_CI_ESCALATION_MODEL` | `claude-opus-4-8` | one final automatic model attempt after repairs |

`author-allowlist` fails closed when trusted authors are missing or malformed. Untrusted
issues are left open, marked `needs-input`, and commented once. The check uses only the
original GitHub issue author's login; labels, assignees, comments, issue edits, branch
contents, commit authors, and model output cannot override it. This mitigates arbitrary
public issue submission, not compromise of a trusted GitHub account.

## Running

```bash
# One scan and exit — the safest way to try it.
node bin/ai-dispatcher.mjs --repo owner/repo --once \
  --repo-dir ~/dispatcher/mirror --worktree-dir ~/dispatcher/worktrees

# Validate config + report the next dispatch WITHOUT launching or mutating anything.
node bin/ai-dispatcher.mjs --repo owner/repo --dry-run

# Poll forever (the service mode).
node bin/ai-dispatcher.mjs --repo owner/repo --interval 900
```

The poll interval is configurable with `--interval` (in seconds) and defaults to 900 seconds if not specified.

Installed as a bin (`npm link` or `npm i -g`), the same commands are `ai-dispatcher …`.

### As a service (systemd)

```ini
# /etc/systemd/system/ai-dispatcher.service
[Unit]
Description=AI issue dispatcher
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/home/<operator>/ai-dispatcher
EnvironmentFile=/home/<operator>/ai-dispatcher/.env
# REQUIRED. The dispatcher spawns gh, node/npm, codex, and claude by name. A systemd
# service does NOT inherit your login PATH, so without this it cannot find them and every
# scan dies with "gh exited 1". Point PATH at wherever those CLIs actually live -- gh is
# often in ~/bin and the Node CLIs under an nvm bin. git is on the default PATH already.
Environment=PATH=/home/<operator>/bin:/home/<operator>/.nvm/versions/node/<ver>/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/home/<operator>/.nvm/versions/node/<ver>/bin/node bin/ai-dispatcher.mjs --repo owner/repo --interval 900
Restart=on-failure
RestartSec=30
# SIGTERM triggers a graceful shutdown: the in-flight run finishes its current agent,
# state is flushed, and the lock is released. An orphaned run is reconciled to
# `interrupted` (resumable) on the next start.

[Install]
WantedBy=multi-user.target
```

Logs are one JSON object per line on stdout, ready for `journalctl`/`docker logs`.


**Running more than one repo.** One process polls one --repo. To dispatch several repos,
run one unit per repo, each with its OWN DISPATCHER_STATE_DIR, DISPATCHER_REPO_DIR,
DISPATCHER_WORKTREE_DIR, and autoship deployment checkout (the state dir carries the
single-instance lock, so shared dirs collide). Autoship, when enabled, is per-instance via
DISPATCHER_AUTOSHIP_CMD.

Autoship never runs the deployment command from an agent issue checkout. The dispatcher
passes `AUTOSHIP_DEPLOYMENT_CHECKOUT` (default:
`<DISPATCHER_STATE_DIR>/autoship-deployments/<owner>-<repo>`) and runs the command from
that directory. It also passes exact immutable context:
`AUTOSHIP_PR_HEAD_SHA`, `AUTOSHIP_BASE_SHA`, `AUTOSHIP_PR_NUMBER`, `AUTOSHIP_ISSUE_NUMBER`,
`AUTOSHIP_BRANCH`, and `AUTOSHIP_REPO`. Repo-specific commands should deploy the exact
merged SHA they produce, record last-known-good before changing production, and emit one
status line on failure when state is known:
`::autoship:: state=<state> health=<pass|fail|unknown> pr_head=<sha> merged=<sha> deployed=<sha|-> rollback=<sha|-> last_good=<sha|-> checkout=<path>`.
Recognized states are `merge_succeeded_deployment_not_attempted`,
`deployment_failed_rollback_succeeded`, `deployment_failed_rollback_failed`,
`deployment_state_unknown`, and `shipped`. Without this line, non-zero exits are conservatively
reported as unknown production state and sent through the automated deploy-repair ladder.
If production already contains an older requested merge, the command must report it
delivered without deploying that older SHA over newer production.

Autoship commands have a 120-minute default ceiling
(`DISPATCHER_AUTOSHIP_TIMEOUT_MINUTES`). Timeout terminates the entire deploy process
group—not just its wrapper shell—so no orphaned build, SSH process, or deploy lock can
poison the recovery attempt.

Autoship can repair a green PR that is blocked only by generated-file merge conflicts.
The recoverable paths are exact and explicit: `DISPATCHER_GENERATED_CONFLICT_ALLOWLIST`
defaults to `docs/memory.md,docs/researcher.md`. Set
`DISPATCHER_GENERATED_CONFLICT_REGEN_CMD` to the target repository's generation command
when those files must be recreated by a hook or script. Recovery is bounded by
`DISPATCHER_GENERATED_CONFLICT_MAX_ATTEMPTS` (default `1`) and waits up to
`DISPATCHER_GENERATED_CONFLICT_CI_WAIT_SECONDS` (default `900`) for repaired-branch CI
before autoship may merge.

Every delivery phase uses one recovery contract: agent exit/zero-commit/no-PR failures,
red CI, mergeability or file-conflict failures, deploy failures, unhealthy/unknown
production reports, and failure to close the shipped issue. Each phase gets
`DISPATCHER_CI_SELF_HEAL_MAX_ATTEMPTS` (default `2`) repairs with the assigned model,
then one automatic attempt on `DISPATCHER_CI_ESCALATION_MODEL` (default
`claude-opus-4-8`). The resumed agent receives the exact recovery reason as data in its
prompt, including conflicting file names and CI evidence.

The phase budgets are independent: spending the CI ladder does not consume the merge or
deploy ladder. The original issue assignment is retained separately from the currently
running escalation model, so a successful frontier repair in one phase does not make
frontier the "assigned" model for later phases. Intermediate attempts and escalation do not send operator push
notifications. Only failure after the frontier attempt stamps `autoship-held`, retains
the issue claim, posts the exhausted evidence, and sends one high-priority page.

GitHub transport/auth/read failures are parked as unknown and rechecked; they are not
misreported as red CI, merge failure, or operator removal of an exhausted hold.

Draft and review-required PRs are promoted and admin-merged. Mixed Markdown/source
conflicts that the deterministic generated-file repair cannot resolve are handed to the
agent rather than held. An already-merged PR is deployed by exact merge SHA and verified
instead of standing down for manual production verification.

**Self-shipping.** When the dispatcher ships changes to *itself*
(`BourbonBaggers/ai-dispatcher`), point `DISPATCHER_AUTOSHIP_CMD` at this repo's
[`scripts/self-ship.sh`](scripts/self-ship.sh) and set `DISPATCHER_AUTOSHIP_DEPLOYMENT_DIR`
to the checkout the systemd unit runs *from* (e.g. `~/ai-dispatcher`) so a restart serves
the merged code. `self-ship.sh` re-gates and merges, then hands the restart to a **detached**
transient unit (outside the dispatcher's own cgroup, so the restart does not kill the ship
command mid-flight) which verifies health and **rolls back** to the previous commit if the
new code does not come up. The detached unit keeps restarting last-known-good until it is
healthy; it does not page the operator from this intermediate failure. The restarted
dispatcher then owns the normal deploy-repair → frontier → exhausted ladder. See
[`.env.example`](.env.example) for the exact variables.

## Run outcome semantics

A run's terminal `status` is never "succeeded" for merely opening a PR or observing
green CI at hand-off — those were the actual root cause of the #366 incident: a
"succeeded" run released its issue claim, so a PR that was open with CI still checking
(or even already red) got silently re-claimed and rerun by the dispatcher from scratch
every ~15 minutes, for hours, with no failure ever showing up as a red CI run because
CI was never the problem — the claim was released too early.

The terminal statuses:

- **`pr_ready`** — the agent exited cleanly with a PR and green CI at handoff. This is
  the terminal draft-PR output when autoship is disabled; with autoship configured it is
  immediately re-gated and cannot become `shipped` until production is verified. It
  retains the issue claim (but not the `agent-working` label), preventing redispatch.
- **`shipped`** — the only TRUE success: the PR is merged, production health passed,
  and the linked issue was closed.
- **`ci_pending`** — the agent finished and opened a PR, but CI had not resolved yet.
  **Parked**: the claim stays, and the next scan re-checks CI ONLY — it does not
  relaunch the agent to wait on a check that is already running.
- **`ci_failed`** — a ladder-in-progress marker (CI is definitively red, or a deploy
  failure is being escalated). Drives the repair → frontier → exhausted ladder described
  above and keeps the issue claim across the relaunch. Always resolved further within the
  same finalize pass; a run should not be found sitting in this status across a scan
  boundary in normal operation.
- **`held`** — the assigned-model repair attempts and the final frontier attempt for a
  delivery phase all failed. This is the sole coding/CI/merge/deploy operator-handoff
  state. `autoship-held` and the retained claim prevent a fresh-from-scratch rerun.
- **`failed`** — the agent itself crashed, gave up (zero commits), or exited non-zero.
  This is an intermediate classification that immediately enters the same repair →
  frontier → exhausted ladder; it is not an operator handoff or 24-hour deferral.

`interrupted` / `timed_out` / `token_exhausted` are unchanged: crash/timeout recovery,
resumed by relaunching the agent on the next scan.

**The linked issue closes only on a verified `shipped`, never on merge.** PR bodies
never carry a GitHub auto-close keyword (`Closes`/`Fixes`/`Resolves #n`) -- merging
closes the issue instantly, before the deploy that follows the merge has even started,
let alone passed its health check. `autoshipRun` calls `github.closeIssue` itself, once,
only after the ship command's own exit code AND its parsed `::autoship::` status line
(when present) agree the deploy is healthy -- not merely on reaching the success branch.
This is what the #366 postmortem calls "merge is not shipped": an issue auto-closed on
merge read as done while the deploy was still mid-build and prod was still on the
previous release.

Only the autoship evaluation/finalization path in `dispatcher.ts` writes verified
`shipped` or exhausted `held`; `exhaustRun` is the single hold/page function. Fresh CI
reads transition `ci_pending`/`ci_failed` both right after a
fresh/resumed/self-healed/escalated run and on every parked recheck.

## State model

All durable state is one atomically-written JSON file plus a lock, under `--state-dir`:

- `state.json` — runs (status, claim, resume/progress counters, parked/ladder CI
  state, PR/commit), provider cooldown windows, per-phase recovery budgets, and verified
  frontier-exhaustion proof. Written
  temp-file-then-rename, so a crash mid-write never corrupts it; a corrupt file is
  preserved as `.corrupt-<ts>` and replaced with empty state rather than crash-looping.
- `dispatcher.lock` — single-instance guard. A second dispatcher against the same state
  dir refuses to start. Creation is atomic, a lock from a dead process is reclaimed, and
  process identity prevents PID reuse from turning a stale lock into a permanent block.

Every runner terminal observation is checkpointed as awaiting finalization before control
returns to the loop. After a kill/restart, the dispatcher completes that exact run's
repair/autoship path before fresh selection; replayed telemetry uses the attempt id as an
idempotency key. Legacy `succeeded` rows are treated as unverified PR handoffs and
re-enter the same finalization path rather than being accepted as production success;
legacy `shipped` rows written before the recovery ledger are likewise reverified because
older self-restarts could persist that word before issue closure survived.

No database. The embedded version's Postgres claims are replaced by the lock (one process)
plus serial execution (one run driven to completion at a time).

## Stopping / interrupting

`SIGINT` / `SIGTERM` abort the poll loop and release the lock. A run that was mid-agent
when the process died is reconciled to `interrupted` on the next start and resumed from the
first milestone without a `[DONE]` marker — completed work is never redone, and the
per-run branch/checkout are always preserved.

## Limits and non-goals

- **Default path ends at a draft PR.** It never merges, closes issues, or deploys unless
  an operator explicitly configures `DISPATCHER_AUTOSHIP_CMD`.
- **No web UI / SSE.** The embedded version's dashboard is intentionally dropped; the
  interface is the CLI, the logs, and the issue comments it posts.
- **Serial, single-host.** One agent at a time, on the host where the CLIs are installed.

## Development

```bash
npm install       # only devDependency is typescript (for typecheck)
npm run typecheck # tsc --noEmit
npm test          # node --test over test/**/*.test.ts (zero runtime deps)
```

## Cutover from the embedded dispatcher

The cutover is complete. Its runbook remains in `internal-tools` as a historical record.
