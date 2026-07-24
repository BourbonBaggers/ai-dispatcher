/**
 * The capture-uncommitted-work decision (ported from dispatch-capture.sh, #237).
 *
 * The dispatcher's most common non-manual failure is an agent that finishes the work
 * but never runs `git commit` (codex often ends by printing a diff). The bundled
 * agent-runner captures that case, but the DECISION lives here so it is unit-testable
 * without launching a real agent.
 *
 * Capture ONLY when all three hold:
 *   - the agent exited cleanly (exitCode === 0), AND
 *   - there are no agent commits ahead of main (commitsAhead === 0), AND
 *   - the worktree has uncommitted changes (dirty).
 *
 * A timeout / non-zero exit may have left the tree half-written, so those stay
 * resumable and are never auto-committed.
 */
export function shouldCaptureUncommittedWork(
  exitCode: number,
  commitsAhead: number,
  dirty: boolean,
): boolean {
  return exitCode === 0 && commitsAhead === 0 && dirty;
}

/**
 * A clean agent exit with both published/committed work and additional dirty files is
 * not deliverable. The safety net intentionally cannot sweep those files into an
 * automatic commit, so the same branch must re-enter agent repair instead of shipping
 * the earlier, incomplete commit set.
 */
export function shouldRepairUnpublishedDirtyWork(
  exitCode: number,
  commitsAhead: number,
  dirty: boolean,
): boolean {
  return exitCode === 0 && commitsAhead > 0 && dirty;
}
