/**
 * Interruptions are infrastructure events, never model failures (#109).
 *
 * A launch that ends interrupted, timed out, or out of provider capacity returned no result
 * the model owns: a signal, a restart, a blind kill, or the launcher's own unpublished-work
 * recovery. The old resume cap marked the assigned model's whole repair budget spent and,
 * three frontier interruptions later, wrote a model-exhaustion hold -- for internal-tools
 * #773 that meant eight "failed attempts" and an operator page over a PR that was green
 * the whole time.
 *
 * This ledger keeps them apart. Interruptions are counted here, per model, and nowhere in
 * the recovery ledger; that ledger counts only launches that returned a failed result.
 * Once a rung's resume budget is spent (and reconciliation found no finished PR to ship):
 *
 *   - escalate: the assigned rung was interrupted out; try the configured frontier model
 *               once, as the existing final rung, without recording any model failure.
 *   - back-off: the frontier rung was interrupted out too. Nothing is held and nobody is
 *               paged -- an interruption is not evidence the work is unsolvable. The run
 *               keeps its claim and retries after 1 h, 4 h, then once a day, so a broken
 *               launcher costs one launch a day while a recovered one resumes by itself.
 *   - retry:    the back-off elapsed; relaunch once more.
 *   - wait:     still backing off; other work proceeds.
 */

const HOUR_MS = 60 * 60_000;

/** Delays before each retry once every resume budget is spent; the last one repeats. */
export const INTERRUPTION_RETRY_DELAYS_MS = [HOUR_MS, 4 * HOUR_MS, 24 * HOUR_MS] as const;

export interface InterruptionLedger {
  /** Launches that ended interrupted, timed out, or out of provider capacity. */
  count: number;
  /** The same count per CLI model, so reports name where the interruptions happened. */
  byModel: Record<string, number>;
  /** Attempt number of the last launch counted: a replayed finalization counts nothing. */
  lastAttempt: number;
  /** Redacted summary of the latest interruption. */
  lastReason: string;
  lastAt: number;
  /** Back-off rounds scheduled after every resume budget was spent. */
  stalls?: number;
  /** While set, the run is backing off: no relaunch before this time. */
  retryAfter?: number | undefined;
}

export interface InterruptedLaunch {
  attemptNumber: number;
  cliModel: string;
  reason: string;
  at: number;
}

/** Counts one interrupted launch, exactly once per attempt. */
export function recordInterruption(
  previous: InterruptionLedger | undefined,
  launch: InterruptedLaunch,
): InterruptionLedger {
  if (previous && previous.lastAttempt >= launch.attemptNumber) return previous;
  return {
    ...previous,
    count: (previous?.count ?? 0) + 1,
    byModel: {
      ...previous?.byModel,
      [launch.cliModel]: (previous?.byModel[launch.cliModel] ?? 0) + 1,
    },
    lastAttempt: launch.attemptNumber,
    lastReason: launch.reason.slice(0, 500),
    lastAt: launch.at,
  };
}

export function interruptionRetryDelayMs(stalls: number): number {
  const index = Math.min(Math.max(0, stalls), INTERRUPTION_RETRY_DELAYS_MS.length - 1);
  return INTERRUPTION_RETRY_DELAYS_MS[index]!;
}

/** True while a run waits out its back-off; such a run must not hold up other work. */
export function isBackingOff(ledger: InterruptionLedger | undefined, nowMs: number): boolean {
  return ledger?.retryAfter !== undefined && nowMs < ledger.retryAfter;
}

export type ResumeCapDecision =
  | { action: "escalate" }
  | { action: "back-off"; retryAfter: number; stalls: number }
  | { action: "retry" }
  | { action: "wait" };

/** What a run whose current rung spent its whole resume budget does next. */
export function decideResumeCap(input: {
  /** The agent phase already runs on (or started on) a frontier model. */
  reachedFrontier: boolean;
  ledger: InterruptionLedger | undefined;
  nowMs: number;
}): ResumeCapDecision {
  const { reachedFrontier, ledger, nowMs } = input;
  if (ledger?.retryAfter !== undefined) {
    return nowMs < ledger.retryAfter ? { action: "wait" } : { action: "retry" };
  }
  if (!reachedFrontier) return { action: "escalate" };
  const stalls = (ledger?.stalls ?? 0) + 1;
  return { action: "back-off", retryAfter: nowMs + interruptionRetryDelayMs(stalls - 1), stalls };
}

/** "8 times (`claude-sonnet-5` ×4, `claude-opus-5-5` ×4)" — never phrased as a failure. */
export function describeInterruptions(ledger: InterruptionLedger): string {
  const times = `${ledger.count} time${ledger.count === 1 ? "" : "s"}`;
  const models = Object.entries(ledger.byModel)
    .map(([model, count]) => `\`${model}\` ×${count}`)
    .join(", ");
  return models ? `${times} (${models})` : times;
}

/** The one issue comment posted when a run starts backing off. */
export function interruptionBackoffComment(
  run: { branch: string },
  ledger: InterruptionLedger,
  retryAfter: number,
): string {
  return [
    "## Dispatcher: agent launches keep being interrupted",
    "",
    `The agent process on \`${run.branch}\` has been interrupted ` +
      `${describeInterruptions(ledger)} without returning a result. Last interruption: ` +
      ledger.lastReason,
    "",
    "Interruptions are infrastructure events, not model failures: no repair or frontier " +
      "budget was spent, and this issue is not held. The branch, checkout, and claim are " +
      `preserved. The dispatcher retries automatically after ${new Date(retryAfter).toISOString()}, ` +
      "backing off to once a day, and resumes autoship as soon as the branch's PR carries the " +
      "finished work.",
  ].join("\n");
}
