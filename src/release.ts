/** Operator release of a durable exhausted claim. The live service must be stopped
 * so StateStore's instance lock protects the state and GitHub label transition. */
import type { StateStore } from "./state.ts";
import type { GithubClient } from "./github.ts";
import { AUTOSHIP_HELD_LABEL } from "./autoship.ts";

export async function releaseHeldRun(
  store: StateStore,
  github: Pick<GithubClient, "prState" | "prMergeInfo" | "removeLabel">,
  repoSlug: string,
  issue: number,
  pr?: number,
): Promise<{ ok: true; pr: number | null } | { ok: false; reason: string }> {
  const held = store.allRuns().filter((run) => run.issueNumber === issue && run.status === "held");
  if (held.length !== 1) return { ok: false, reason: `Expected one held claim for issue #${issue}; found ${held.length}.` };
  const run = held[0]!;
  if (!run.exhaustion) return { ok: false, reason: "The claim has no durable exhaustion proof; let the dispatcher clear its legacy hold." };

  // An explicit PR override is allowed only for a merge GitHub confirms. The stored
  // original merge is preferred when the operator omits --pr.
  const selected = pr ?? run.mergedDelivery?.pr ?? run.prNumber;
  if (pr !== undefined) {
    if (await github.prState(pr) !== "merged") return { ok: false, reason: `PR #${pr} is not confirmed merged.` };
    const info = await github.prMergeInfo(pr);
    if (!info?.mergeCommitOid) return { ok: false, reason: `PR #${pr} has no confirmed merge SHA.` };
    store.updateRun(run.id, {
      prNumber: pr,
      prUrl: `https://github.com/${repoSlug}/pull/${pr}`,
      mergedDelivery: { pr, sha: info.mergeCommitOid },
    });
  } else if (run.mergedDelivery && run.prNumber !== run.mergedDelivery.pr) {
    store.updateRun(run.id, {
      prNumber: run.mergedDelivery.pr,
      prUrl: `https://github.com/${repoSlug}/pull/${run.mergedDelivery.pr}`,
    });
  }
  if (!await github.removeLabel(issue, AUTOSHIP_HELD_LABEL)) {
    return { ok: false, reason: `Could not remove ${AUTOSHIP_HELD_LABEL} from issue #${issue}; the claim remains held.` };
  }
  return { ok: true, pr: selected };
}
