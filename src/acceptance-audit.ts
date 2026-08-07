/**
 * The post-ship acceptance audit's pure decision layer (#85).
 *
 * The audit never blocks delivery. It runs after an issue has shipped, and its only
 * possible product is *queued work*: a follow-up issue the dispatcher picks up on a later
 * scan. That is what keeps a wrong verdict cheap. The predecessor gated merge instead, so
 * a false positive spent both repair attempts, escalated to frontier, exhausted, and paged
 * the operator against a correct PR (#84).
 *
 * Three properties are load-bearing and must not be relaxed:
 *
 *  1. **Only a confident, cited omission creates work.** `unclear` is the correct output
 *     for a cheap judge that is not sure, and it creates nothing. Unparseable, missing, or
 *     malformed judge output degrades to `unclear` — never to `not_addressed`.
 *  2. **Generation is depth-bounded.** Follow-ups are themselves auditable, so without a
 *     cap the loop files issues forever. Exceeding the cap is the ONLY path here that
 *     notifies a human, and it is a real signal.
 *  3. **Judge text is data.** Citations come from an agent-authored diff. They are
 *     rendered into a Markdown body that travels over stdin, and they never select a
 *     label, a command, or a routing decision.
 */

export const AUDIT_FOLLOWUP_LABEL = "audit-followup";
export const AUDIT_DEPTH_LABEL_PREFIX = "audit:depth-";
/** Depth 1 may file work; a follow-up's own follow-up may not. */
export const AUDIT_MAX_DEPTH = 1;

export const AUDIT_RESULTS = ["addressed", "not_addressed", "unclear"] as const;
export type AuditResult = (typeof AUDIT_RESULTS)[number];

export interface CriterionVerdict {
  criterion: string;
  result: AuditResult;
  /** Required for `not_addressed`; a verdict without one degrades to `unclear`. */
  citation?: string;
}

const MAX_CITATION_CHARS = 300;

/**
 * Parses the judge's response into one verdict per criterion.
 *
 * Every failure mode lands on `unclear`: unparseable JSON, a missing entry, an unknown
 * result string, or a `not_addressed` with no citation. The judge can therefore never
 * manufacture work by emitting malformed output, only by making a confident cited claim.
 */
export function parseJudgeVerdicts(raw: string, criteria: readonly string[]): CriterionVerdict[] {
  const byIndex = new Map<number, { result?: unknown; citation?: unknown }>();

  // The response may be wrapped in prose or a code fence; take the outermost JSON array.
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start !== -1 && end > start) {
    try {
      const parsed: unknown = JSON.parse(raw.slice(start, end + 1));
      if (Array.isArray(parsed)) {
        for (const entry of parsed) {
          if (typeof entry !== "object" || entry === null) continue;
          const record = entry as { index?: unknown; result?: unknown; citation?: unknown };
          if (typeof record.index !== "number" || !Number.isInteger(record.index)) continue;
          byIndex.set(record.index, { result: record.result, citation: record.citation });
        }
      }
    } catch {
      // Fall through: every criterion stays unclear.
    }
  }

  return criteria.map((criterion, index) => {
    const entry = byIndex.get(index);
    const result = typeof entry?.result === "string" ? entry.result : "";
    const citation =
      typeof entry?.citation === "string" && entry.citation.trim() !== ""
        ? entry.citation.trim().slice(0, MAX_CITATION_CHARS)
        : undefined;

    if (result === "addressed") return { criterion, result: "addressed" };
    // A confident omission without evidence is not confident. Degrade it rather than
    // filing work on an uncited claim.
    if (result === "not_addressed" && citation !== undefined) {
      return { criterion, result: "not_addressed", citation };
    }
    return { criterion, result: "unclear" };
  });
}

/** Depth recorded on an issue's labels; an issue with no depth label is an original. */
export function auditDepth(labels: readonly string[]): number {
  let depth = 0;
  for (const label of labels) {
    if (!label.startsWith(AUDIT_DEPTH_LABEL_PREFIX)) continue;
    const value = Number.parseInt(label.slice(AUDIT_DEPTH_LABEL_PREFIX.length), 10);
    if (Number.isInteger(value) && value > depth) depth = value;
  }
  return depth;
}

export function auditDepthLabel(depth: number): string {
  return `${AUDIT_DEPTH_LABEL_PREFIX}${depth}`;
}

export interface AuditDecisionInput {
  parentIssue: number;
  verdicts: readonly CriterionVerdict[];
  /** Depth of the audited issue itself, from its labels. */
  parentDepth: number;
  /** An already-open follow-up for this parent, if one was found. */
  existingFollowUp?: number | undefined;
  maxDepth?: number;
}

export type AuditDecision =
  | { action: "none"; reason: string }
  | { action: "file"; omissions: readonly CriterionVerdict[]; depth: number }
  | { action: "comment_existing"; issue: number; omissions: readonly CriterionVerdict[] }
  | { action: "notify"; reason: string; omissions: readonly CriterionVerdict[] };

export function decideAudit(input: AuditDecisionInput): AuditDecision {
  const omissions = input.verdicts.filter((verdict) => verdict.result === "not_addressed");
  if (omissions.length === 0) {
    return { action: "none", reason: "No confident cited omission." };
  }

  // Re-running the sweep over the same shipped issue must not create a second follow-up.
  // Commenting keeps the new evidence visible without multiplying queued work.
  if (input.existingFollowUp !== undefined) {
    return { action: "comment_existing", issue: input.existingFollowUp, omissions };
  }

  const depth = input.parentDepth + 1;
  if (depth > (input.maxDepth ?? AUDIT_MAX_DEPTH)) {
    return {
      action: "notify",
      reason:
        `Issue #${input.parentIssue} is itself an audit follow-up and still shows an ` +
        "unaddressed criterion. Automated follow-up generation stops here.",
      omissions,
    };
  }

  return { action: "file", omissions, depth };
}

/**
 * The follow-up issue body.
 *
 * Two things here are deliberate. The criteria are restated verbatim so the follow-up is
 * self-contained work rather than a pointer. And the body explicitly authorizes closing
 * without changes: the judge can be wrong, and an agent that finds the work already done
 * must have a sanctioned way to say so instead of inventing changes to justify its run.
 */
export function followUpIssueBody(
  parentIssue: number,
  parentTitle: string,
  omissions: readonly CriterionVerdict[],
  depth: number,
): string {
  return [
    `Audit follow-up for #${parentIssue} — ${parentTitle}`,
    "",
    `#${parentIssue} shipped, but a post-ship audit did not find evidence in the merged`,
    "diff that the criteria below were addressed. Each one is quoted from that issue.",
    "",
    "## Unaddressed criteria",
    "",
    ...omissions.flatMap((omission) => [
      `- [ ] ${omission.criterion}`,
      `  - Audit note: ${omission.citation ?? "no citation recorded"}`,
    ]),
    "",
    "## If the criteria are already satisfied",
    "",
    "The audit is a cheap heuristic and can be wrong. If the merged work already satisfies",
    "these criteria, that is a valid and expected outcome: **close this issue with a comment",
    "explaining what already covers each one, and make no code changes.** Do not invent work",
    "to justify the run, and do not leave the issue open.",
    "",
    "## Notes",
    "",
    `Audit depth: ${depth}. Generated by the post-ship acceptance audit (#85).`,
  ].join("\n");
}

/** Comment added to the parent when a follow-up is filed. */
export function parentClosureComment(followUpIssue: number, omissions: readonly CriterionVerdict[]): string {
  return [
    "## Shipped — residual tracked in a follow-up",
    "",
    "This issue is delivered and closed: its PR merged and production health verified.",
    "A post-ship audit did not find evidence for every stated acceptance criterion, so the",
    `remainder is tracked in #${followUpIssue} rather than held here.`,
    "",
    ...omissions.map((omission) => `- ${omission.criterion}`),
  ].join("\n");
}
