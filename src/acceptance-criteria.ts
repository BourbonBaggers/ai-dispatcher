/**
 * Deterministic extraction of an issue's stated acceptance criteria.
 *
 * This is the mechanical half of the post-ship audit (#85): finding the checklist is a
 * parsing problem, so it stays here, pure and testable. Judging whether a diff addressed a
 * criterion is not a parsing problem, and deliberately does NOT live here — the previous
 * attempt at that (#84) tried to decide adherence with regexes, produced false
 * "contradicted" verdicts on correct PRs, and cost a frontier escalation before being
 * removed. Anything resembling a keyword-match verdict belongs nowhere in this file.
 *
 * Extraction is intentionally permissive: every explicit checklist item under an
 * acceptance heading is returned. The old business/operational/meta triage regexes existed
 * only because the verdict could block a merge, so the set had to be kept artificially
 * small. The audit files follow-up work instead of blocking, so it can look at everything.
 */

const MAX_INPUT_CHARS = 32_000;
const MAX_CRITERIA = 40;
const MAX_CRITERION_CHARS = 500;

/** Headings that introduce a criteria checklist. */
function isCriteriaHeading(line: string): boolean {
  return /\b(acceptance criteria|definition of done|success criteria)\b/i.test(line);
}

function headingLevel(line: string): number | null {
  const match = /^(#{1,6})\s+/.exec(line);
  return match ? match[1]!.length : null;
}

/**
 * Every explicit checklist item under an acceptance heading, in document order.
 *
 * A section ends at the next heading of the same or shallower level, so a nested
 * sub-heading inside the criteria section keeps contributing its items.
 */
export function extractAcceptanceCriteria(issueText: string): string[] {
  const lines = issueText.slice(0, MAX_INPUT_CHARS).split(/\r?\n/);
  const criteria: string[] = [];
  let sectionLevel: number | null = null;

  for (const raw of lines) {
    const line = raw.trim();
    const level = headingLevel(line);

    if (level !== null) {
      if (isCriteriaHeading(line)) {
        sectionLevel = level;
        continue;
      }
      // A heading at or above the section's level closes it; a deeper one nests inside.
      if (sectionLevel !== null && level <= sectionLevel) sectionLevel = null;
      continue;
    }

    if (sectionLevel === null) continue;

    // Only explicit list items are criteria. Prose under the heading is context.
    const item = /^(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s*)?(.*)$/.exec(line)?.[1]?.trim();
    if (!item) continue;

    const criterion = item.slice(0, MAX_CRITERION_CHARS).replace(/\s+/g, " ").trim();
    if (criterion === "" || criteria.includes(criterion)) continue;
    criteria.push(criterion);
    if (criteria.length >= MAX_CRITERIA) break;
  }

  return criteria;
}
