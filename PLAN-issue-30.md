# Issue #30 Plan — Deterministic Status, History, and Agent Output

## Milestone 1: Durable Status Primitives

- Add an explicit, backward-compatible current phase to `RunRecord`.
- Persist trusted phase transitions only from dispatcher/launcher-owned code paths.
- Add append-only per-run output artifacts with sequence numbers, timestamps, provenance,
  redaction, and lifecycle/phase entries.
- Tie output retention to run pruning.

## Milestone 2: Read-Only Status And History CLI

- Add `ai-dispatcher status` and `ai-dispatcher history` subcommands that resolve
  `--state-dir` without opening the write-locking dispatcher store.
- Render terse idle/offline/active human output and versioned JSON.
- Include exact optional `gh` inspection commands from local run data only.
- Fail closed for unreadable primary and backup state instead of reporting idle.

## Milestone 3: Follow Mode

- Implement `status --follow` replay/tailing for the active run's output artifact.
- Emit human-readable followed output by default and newline-delimited versioned JSON
  events for `--json --follow`.
- Stop following when the run reaches a terminal or parked handoff state.

## Milestone 4: Tests And Documentation

- Cover phase mapping, old-state compatibility, idle/offline/active rendering, JSON
  schemas, history ordering/limits, follow replay/tailing, redaction, retention, and
  concurrent read behavior around atomic writes.
- Update README usage and document the versioned status/history/follow schemas.
- Run `npm test`, `npm run typecheck`, and relevant ShellCheck validation.

## Milestone 5: Pull Request

- Commit each completed milestone with `milestone(N): ...`.
- Push `issue-30-add-deterministic-status-history-and-agent-output`.
- Open a ready-for-review pull request against `main` with `Issue: #30` in the body and
  no GitHub auto-close keyword.
