#!/usr/bin/env bash
# dispatch-capture.sh — safety net for the AI Issue Dispatcher (ported from #237).
#
# The dispatcher's most common non-manual failure is an agent that finishes the work
# but never runs `git commit`. In `codex exec` the agent frequently writes the whole
# implementation into the worktree and then ends its turn by printing a diff instead of
# committing. The runner deliberately auto-commits ONLY docs/plans + memory + researcher
# (so it never sweeps half-written source mid-run), so a clean exit with uncommitted
# source and no agent commit was discarded as "nothing to publish" — throwing away
# finished work sitting on disk.
#
# This file is sourced by dispatch-agent.sh. It lives on its own so the decision logic
# is unit-testable without launching a real agent (the TS mirror is src/capture.ts).

# capture_uncommitted_work <issue> <exit_code> <commits_ahead>
#
# Stage and commit the worktree as a fallback ONLY when all three hold:
#   - the agent exited cleanly (exit_code == 0), AND
#   - there are no agent commits ahead of main (commits_ahead == 0), AND
#   - the worktree has uncommitted changes (dirty `git status`).
#
# Returns 0 (and makes exactly one commit) when work was captured; returns 1 without
# committing otherwise. Runs in the current working directory, which must be the run
# checkout. Never stages .env, credentials, or .dispatcher-prompt.md.
capture_uncommitted_work() {
  local issue="$1" exit_code="$2" commits_ahead="$3"

  # Fire ONLY on a clean exit. A timeout (124/137) or any non-zero exit may have left
  # the tree half-written mid-edit; committing that would publish broken work. Those
  # runs stay resumable exactly as before — this function makes no commit for them.
  [[ "$exit_code" -eq 0 ]] || return 1

  # If the agent already committed anything of its own (here or on the remote), there is
  # nothing to rescue — the normal push/PR path already handles it.
  [[ "$commits_ahead" -eq 0 ]] || return 1

  # Nothing to capture if the working tree is clean. `git status --porcelain` respects
  # .gitignore and .git/info/exclude, so an otherwise-clean tree with only ignored files
  # (.env) or excluded files (.dispatcher-prompt.md) reports empty here and we stop.
  [[ -n "$(git status --porcelain 2>/dev/null)" ]] || return 1

  # Stage everything the repo's ignore rules allow. `git add -A` never stages paths
  # matched by .gitignore (.env) or .git/info/exclude (.dispatcher-prompt.md). Reset
  # those two explicitly anyway, as belt-and-suspenders in case either is ever tracked.
  git add -A || return 1
  git reset -q -- .env .dispatcher-prompt.md 2>/dev/null || true

  # If the only dirty entries were ignored/excluded, the index is empty now — stop.
  git diff --cached --quiet && return 1

  git commit --no-verify -q \
    -m "dispatcher: capture uncommitted agent work for #${issue}" || return 1
  return 0
}
