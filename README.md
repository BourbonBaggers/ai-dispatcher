# ai-dispatcher

Standalone AI issue dispatcher. Polls a GitHub repository, claims one open issue carrying
an `agent:*` + `model:*` label pair, and runs Codex or Claude Code against it in an
isolated checkout — serially, with retries, provider cooldowns, durable file-backed
state, and a **draft pull request** as the output.

It is extracted from the AI Issue Dispatcher that lived inside the
`BourbonBaggers/internal-tools` monorepo (issues #188/#232/#234/#245/#249/#281/#307). The
behaviour is ported before it is extended; the one intentional change is that the target
repository is now an explicit, required argument with **no hard-coded fallback** (issue
#320). This package is self-contained and structured to be lifted into its own repository
at `~/Developer/ai-dispatcher` verbatim.

> **Its final home is its own repo.** It currently lives under
> `services/ai-dispatcher/` in the monorepo only because the extraction PR targets that
> repo and a single PR cannot contain a sibling git repository. Nothing here imports from
> the monorepo.

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

| Label | Meaning |
| --- | --- |
| `agent:claude` / `agent:codex` | which CLI to launch |
| `model:claude-opus-4.8` / `model:gpt-5.5` | the exact `--model` string; must match the agent |
| `effort:low\|medium\|high\|max` | per-agent reasoning effort (`max` caps Codex at `high`); default `effort:medium` |
| `queue jump` / `technical debt` | move the issue between priority tiers |
| `agent-working` | the dispatcher is actively on it (added on claim, cleared on non-resumable finish) |
| `needs-input` / `blocked` | held for a human — skipped, not worked |

Labels are never passed to a shell; they are only ever looked up in frozen maps
(`src/labels.ts`), and the constant they resolve to is what reaches the CLI. An unknown
label simply fails to resolve and the issue is skipped with a visible reason.

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

| Flag | Env | Default | Meaning |
| --- | --- | --- | --- |
| `--repo <owner/repo>` | `DISPATCHER_REPO` | *(required)* | target repository; canonical `owner/repository`, validated, no fallback |
| `--repo-dir <path>` | `DISPATCHER_REPO_DIR` | *(required)* | pristine mirror clone kept on `origin/main` |
| `--worktree-dir <path>` | `DISPATCHER_WORKTREE_DIR` | *(required)* | parent dir for per-run checkouts |
| — | `DISPATCHER_ENV_SOURCE_DIR` | *(optional)* | checkout whose `.env` seeds each run checkout |
| `--interval <seconds>` | `DISPATCHER_POLL_INTERVAL_SECONDS` | `900` | poll interval |
| `--max-minutes <min>` | `DISPATCHER_MAX_RUNTIME_MINUTES` | `90` | per-run wall-clock budget |
| `--state-dir <path>` | `DISPATCHER_STATE_DIR` | `./state` | durable state directory |
| `--log-level <level>` | `DISPATCHER_LOG_LEVEL` | `info` | `debug\|info\|warn\|error` |
| — | `NTFY_URL` / `NTFY_TOPIC` | *(optional)* | ntfy push notifications; disabled if unset |

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

Installed as a bin (`npm link` or `npm i -g`), the same commands are `ai-dispatcher …`.

### As a service (systemd)

```ini
# /etc/systemd/system/ai-dispatcher.service
[Unit]
Description=AI issue dispatcher
After=network-online.target

[Service]
Type=simple
User=<operator>
WorkingDirectory=/home/<operator>/ai-dispatcher
EnvironmentFile=/home/<operator>/ai-dispatcher/.env
ExecStart=/usr/bin/node bin/ai-dispatcher.mjs --repo owner/repo
Restart=on-failure
RestartSec=30
# SIGTERM triggers a graceful shutdown: the in-flight run finishes its current agent,
# state is flushed, and the lock is released. An orphaned run is reconciled to
# `interrupted` (resumable) on the next start.

[Install]
WantedBy=multi-user.target
```

Logs are one JSON object per line on stdout, ready for `journalctl`/`docker logs`.

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

- **Ends at a draft PR.** It never merges, closes issues, or deploys. Autoship is
  deliberately not wired in this extraction (`DISPATCHER_AUTOSHIP_CMD` is reserved).
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
[`docs/runbooks/ai-dispatcher-cutover.md`](../../docs/runbooks/ai-dispatcher-cutover.md).
This is also the prerequisite for issue #319.
