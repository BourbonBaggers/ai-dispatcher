/**
 * Lightweight business-outcome evidence for the autoship boundary.
 *
 * This is deliberately a conservative sanity check, not a test or a model-generated
 * verdict. It only blocks when an explicitly stated criterion is contradicted or has no
 * meaningful implementation evidence at all. That catches obvious omissions while
 * leaving reasonable implementation choices to CI and the deployed health checks.
 */

const MAX_INPUT_CHARS = 32_000;
const GENERIC = new Set([
  "acceptance", "criteria", "criterion", "expected", "behavior", "behaviour", "outcome",
  "result", "implementation", "implemented", "change", "changes", "work", "issue", "feature",
  "system", "code", "must", "should", "shall", "will", "need", "needs", "ensure", "support",
  "provide", "update", "include", "including", "allow", "make", "use", "using", "test", "tests", "feature",
]);

function words(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .match(/[a-z0-9]+/g) ?? [];
}

function stem(word: string): string {
  if (word.length > 5 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 5 && word.endsWith("ing")) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith("es")) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s")) return word.slice(0, -1);
  return word;
}

function materialWords(text: string): string[] {
  return [...new Set(words(text).map(stem).filter((word) => word.length >= 4 && !GENERIC.has(word)))];
}

function inCriteriaSection(line: string): boolean {
  return /\b(acceptance criteria|desired behavior|desired behaviour|expected behavior|expected behaviour|regression test|requirements?)\b/i.test(line);
}

function isBusinessCriterion(line: string): boolean {
  // Desired-behavior sections often mix the business outcome with dispatcher mechanics.
  // The latter are already protected by CI/autoship and must not become a second,
  // brittle implementation checklist. Keep a line when it has recognizable business
  // nouns, or when it is a generic acceptance section with no operational vocabulary.
  const business = /\b(customer|user|invoice|payment|menu|label|order|account|email|price|charge|refund|delivery|workflow|checkout)\b/i.test(line);
  const operational = /\b(dispatcher|continuous integration|\bci\b|pull request|\bpr\b|deploy(?:ed|ment)?|production health|agent|model|issue claim|operator|autoship|evidence|test suite|risky external|human review)\b/i.test(line);
  return !operational || business;
}

/** Extracts explicit, human-authored criteria without treating all issue prose as a gate. */
export function extractAcceptanceCriteria(issueText: string): string[] {
  const lines = issueText.slice(0, MAX_INPUT_CHARS).split(/\r?\n/);
  const criteria: string[] = [];
  let section = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^#{1,6}\s+/.test(line)) section = inCriteriaSection(line);
    const bullet = line.match(/^(?:[-*]|\d+[.)])\s+(?:\[[ xX]\]\s*)?(.*)$/)?.[1] ??
      (/^(?:the issue|it|the system|the dispatcher)\b.*\b(must|should|required|needs to)\b/i.test(line) ? line : null);
    if (!bullet || (!section && !/\b(acceptance criteria|must|required|should)\b/i.test(bullet))) continue;
    if (!isBusinessCriterion(bullet)) continue;
    const criterion = bullet.trim().replace(/[.!]+$/, "");
    if (materialWords(criterion).length >= 2 && !criteria.includes(criterion)) criteria.push(criterion);
  }
  return criteria.slice(0, 24);
}

export interface AcceptanceFinding {
  criterion: string;
  reason: "contradicted" | "not_attempted";
  detail: string;
}

export interface AcceptanceEvidence {
  status: "pass" | "fail" | "insufficient";
  criteria: string[];
  findings: AcceptanceFinding[];
}

function negativeSentences(evidence: string): string[] {
  return evidence
    .slice(0, MAX_INPUT_CHARS)
    .split(/[.!?\n]+/)
    .filter((sentence) => /\b(?:not|never|won't|cannot|can't|doesn't|does not|without|omit|omits|omitted| 제외)\b/i.test(sentence));
}

/** Compare issue criteria with trusted PR diff/title/body evidence. */
export function assessAcceptanceEvidence(issueText: string, implementationEvidence: string): AcceptanceEvidence {
  const criteria = extractAcceptanceCriteria(issueText);
  if (criteria.length === 0) return { status: "insufficient", criteria, findings: [] };
  const evidence = implementationEvidence.slice(0, MAX_INPUT_CHARS);
  if (evidence.trim() === "") return { status: "insufficient", criteria, findings: [] };

  const evidenceWords = new Set(materialWords(evidence));
  const negatives = negativeSentences(evidence);
  const findings: AcceptanceFinding[] = [];
  for (const criterion of criteria) {
    const keyWords = materialWords(criterion);
    const overlap = keyWords.filter((word) => evidenceWords.has(word));
    const contradicted = negatives.some((sentence) => {
      const negativeWords = new Set(materialWords(sentence));
      return keyWords.filter((word) => negativeWords.has(word)).length >= Math.min(2, keyWords.length);
    });
    if (contradicted) {
      findings.push({
        criterion,
        reason: "contradicted",
        detail: "The PR evidence explicitly says that this requested behavior is omitted or unavailable.",
      });
    } else if (overlap.length < Math.min(2, keyWords.length)) {
      findings.push({
        criterion,
        reason: "not_attempted",
        detail: "No material implementation evidence for this criterion appears in the PR diff or text.",
      });
    }
  }
  return { status: findings.length > 0 ? "fail" : "pass", criteria, findings };
}

export function acceptanceRepairReason(evidence: AcceptanceEvidence): string {
  return evidence.findings
    .map((finding) => `- ${finding.reason === "contradicted" ? "Contradicted" : "Not attempted"}: ${finding.criterion}. ${finding.detail}`)
    .join("\n");
}
