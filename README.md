# ai-dispatcher

Standalone AI issue dispatcher. Polls a GitHub repository, claims one open issue carrying
an `agent:*` + `model:*` label pair, and runs Codex or Claude Code against it in an
isolated checkout — serially, with retries, provider cooldowns, durable file-backed
state, and a **draft pull request** as the output.

It is extracted from the AI Issue Dispatcher that lived inside the
`BourbonBaggers/internal-tools` monorepo (issues #188/#232/#234/#245/#249/#281/#307). The
behaviour is ported before it is extended; the one intentional change is that the target
repository is now an explicit, required argument with **no hard-coded fallback** (issue
#320). This package is self-contained: nothing here imports from the monorepo.

> **This repository is the dispatcher's only home.** The extraction is complete — the
> embedded dispatcher has been removed from `internal-tools` along with its Postgres
> tables. Do not copy this service back into that monorepo; see AGENTS.md.

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
5. **Finalize once.** Classify the terminal state, apply the failure-deferral policy,
   release the label (unless the run is still resumable), comment on the issue, and send a
   single notification.

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

The dispatcher obeys the `model:*` label on each issue, but that label is chosen by a
deterministic, data-driven routing rubric that routes to the **minimum viable model**,
prefers otherwise-idle (dormant) subscription capacity, protects the frontier reserve, and
permits cost-driven retries/handoffs. The full decision table is in
[`ROUTING.md`](ROUTING.md) — it is the policy an issue author applies when labelling work.

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
| `--author-auth <mode>`     | `DISPATCHER_ISSUE_AUTHOR_AUTH_MODE` | `author-allowlist`         | `author-allowlist` requires the original issue author to be trusted; `none` allows all authors |
| `--trusted-authors <list>` | `DISPATCHER_TRUSTED_ISSUE_AUTHORS`  | _(required for allowlist)_ | comma-separated GitHub usernames, matched case-insensitively                                   |
| `--log-level <level>`      | `DISPATCHER_LOG_LEVEL`              | `info`                     | `debug\|info\|warn\|error`                                                                     |
| —                          | `NTFY_URL` / `NTFY_TOPIC`           | _(optional)_               | ntfy push notifications; disabled if unset                                                     |

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
`deployment_state_unknown`, and `shipped`. Without this line, non-zero exits are reported
as unknown production state requiring human verification.

Autoship can repair a green PR that is blocked only by generated-file merge conflicts.
The recoverable paths are exact and explicit: `DISPATCHER_GENERATED_CONFLICT_ALLOWLIST`
defaults to `docs/memory.md,docs/researcher.md`. Set
`DISPATCHER_GENERATED_CONFLICT_REGEN_CMD` to the target repository's generation command
when those files must be recreated by a hook or script. Recovery is bounded by
`DISPATCHER_GENERATED_CONFLICT_MAX_ATTEMPTS` (default `1`) and waits up to
`DISPATCHER_GENERATED_CONFLICT_CI_WAIT_SECONDS` (default `900`) for repaired-branch CI
before autoship may merge.

Autoship also self-heals a red-CI PR before paging a human: when the re-confirmed CI
check fails, it relaunches the agent on the same branch (a resume, so the agent is handed
the actual failing checks rather than guessing) instead of immediately holding. Only after
`DISPATCHER_CI_SELF_HEAL_MAX_ATTEMPTS` (default `2`) such attempts are still red does
autoship escalate: ONE further attempt is relaunched on `DISPATCHER_CI_ESCALATION_MODEL`
(default `claude-opus-4-8`) — a stronger model gets one last try at a failure the default
model got stuck on. The escalation is posted to the issue as its own comment ("Autoship:
self-heal failed, escalating") so there is visibility into which attempt is running. Only
once that escalation attempt is ALSO still red does autoship give up, stamp
`autoship-held`, and notify a human — automation gets first crack (twice) at a
known-recoverable problem, and the human is paged only once it has genuinely given up.

## State model

All durable state is one atomically-written JSON file plus a lock, under `--state-dir`:

- `state.json` — runs (status, claim, resume/progress counters, PR/commit), provider
  cooldown windows, and per-issue failure deferrals. Written temp-file-then-rename, so a
  crash mid-write never corrupts it; a corrupt file is preserved as `.corrupt-<ts>` and
  replaced with empty state rather than crash-looping.
- `dispatcher.lock` — single-instance guard. A second dispatcher against the same state
  dir refuses to start; a lock from a dead pid is reclaimed automatically.

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

Removing the monorepo's embedded dispatcher is a **human-gated** follow-up, not part of
the extraction PR (it involves a destructive Postgres migration and would kill the running
dispatcher mid-flight). The full procedure — proving the standalone service operational,
then dropping the `Dispatcher*` tables and the API routes/cron — is in the target repo at
[`docs/runbooks/ai-dispatcher-cutover.md`](https://github.com/BourbonBaggers/internal-tools/blob/main/docs/runbooks/ai-dispatcher-cutover.md).

**This cutover is done.** It is retained as the historical record of how the split was
performed.
