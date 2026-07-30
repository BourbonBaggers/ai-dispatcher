/**
 * Deriving workload judgment from the issue text (#51 §1).
 *
 * The intake contract asks the author for four business facts — type, priority, risk, and
 * a clear issue. Everything else the router needs (how much context the work spans, how
 * settled the approach is, how strong the verification is) is the dispatcher's job to work
 * out by reading the issue. This module is that reader.
 *
 * Deliberately deterministic pattern matching, not a model call: routing happens at pickup
 * for every candidate, it must be reproducible for the same text, and it must be unit
 * testable. It is a *rubric*, not a prediction engine — the same 80/20 principle the
 * routing rubric follows.
 *
 * SECURITY: the issue body is untrusted, author-controlled input. It stays data here —
 * matched in-process, never interpolated into a command line, never shell-expanded. Its
 * routing influence is bounded by construction:
 *   - scanning is length-capped, so a huge body cannot burn CPU;
 *   - the assessment can only move the route one step, up or down (see `deriveMinimumTier`);
 *   - text can never reach a frontier model — `routing.ts` caps text-driven up-routing at
 *     `TEXT_UPROUTE_CEILING`. Frontier stays reachable only by human override or by the
 *     recovery ladder, so no issue author can talk their way into the expensive reserve.
 */

import type {
  Ambiguity,
  Complexity,
  ContextSize,
  IssueCharacteristics,
  ReasoningDepth,
  Recoverability,
  RequirementsQuality,
  VerificationStrength,
} from "./routing.ts";

/** Bounded scan: enough for a thorough issue, small enough that matching stays cheap. */
const MAX_SCANNED_CHARS = 24_000;

export interface IssueAssessment {
  contextSize: ContextSize;
  ambiguity: Ambiguity;
  requirementsQuality: RequirementsQuality;
  reasoningDepth: ReasoningDepth;
  verificationStrength: VerificationStrength;
  complexity: Complexity;
  recoverability: Recoverability;
  /** Human-readable justification for each axis, recorded as routing evidence. */
  evidence: string[];
}

/** Signals counted from the text. Kept separate so tests can assert the raw observation. */
export interface IssueTextSignals {
  scannedChars: number;
  titleChars: number;
  bodyChars: number;
  filePaths: number;
  codeBlocks: number;
  checklistItems: number;
  crossReferences: number;
  headings: number;
  hedges: number;
  openQuestions: number;
  acceptanceCriteria: boolean;
  reproductionSteps: boolean;
  verificationMentions: number;
  weakVerificationMentions: number;
  rollbackMentions: number;
  deepReasoningMentions: number;
}

function countMatches(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

/**
 * Extracts the raw signals. Every pattern is anchored on structure an issue author
 * produces incidentally (paths, fences, checklists, headings) or on explicit vocabulary,
 * so a normal well-written issue scores well without anyone gaming keywords.
 */
export function extractIssueSignals(title: string, body: string): IssueTextSignals {
  const text = `${title}\n${body}`.slice(0, MAX_SCANNED_CHARS);
  const lower = text.toLowerCase();
  return {
    scannedChars: text.length,
    titleChars: title.trim().length,
    bodyChars: body.trim().length,
    // `src/foo.ts`, path/to/file.py, etc. Extension-anchored to avoid matching prose.
    filePaths: countMatches(text, /\b[\w./-]+\.(ts|tsx|js|mjs|json|md|sh|yml|yaml|py|go|rs|sql)\b/g),
    codeBlocks: countMatches(text, /```/g) >> 1,
    checklistItems: countMatches(text, /^\s*[-*]\s+\[[ xX]\]/gm),
    crossReferences: countMatches(text, /(^|\s)#\d+\b/g),
    headings: countMatches(text, /^#{1,6}\s+\S/gm),
    hedges: countMatches(
      lower,
      /\b(maybe|perhaps|not sure|unsure|unclear|tbd|to be decided|we could|or we|some ?how|figure out|investigate|explore|decide whether|open question|either way)\b/g,
    ),
    openQuestions: countMatches(text, /\?\s*(\n|$)/g),
    acceptanceCriteria:
      /\b(acceptance criteria|definition of done|expected (behaviou?r|outcome|result)|must\b)/i.test(
        text,
      ),
    reproductionSteps: /\b(steps to reproduce|reproduction|repro\b|actual (behaviou?r|result))/i.test(
      text,
    ),
    verificationMentions: countMatches(
      lower,
      /\b(test|tests|unit test|integration test|ci\b|health check|healthcheck|verif(y|ication)|assert)\b/g,
    ),
    // Explicit statements that correctness is hard to observe. Only these downgrade
    // verification — see `assessIssueText` for why silence must not.
    weakVerificationMentions: countMatches(
      lower,
      /\b(manual(ly)? (test|verif|check)|visual(ly)? (check|inspect)|hard to test|difficult to test|cannot be tested|can't be tested|no tests?\b|untested|subjective)\b/g,
    ),
    rollbackMentions: countMatches(lower, /\b(rollback|roll back|revert|feature flag|backup|restore)\b/g),
    deepReasoningMentions: countMatches(
      lower,
      /\b(architect(ure|ural)|design (decision|tradeoff)|trade-?off|invariant|race condition|concurrency|deadlock|consistency model|migration strategy|redesign)\b/g,
    ),
  };
}

/**
 * Turns signals into the internal characteristic axes.
 *
 * Thresholds are intentionally coarse. The router only reacts to *strong* evidence — one
 * step, in one direction — so precision here buys nothing, while over-tuning would make
 * routing hard to explain when someone asks why an issue got the model it got.
 */
export function assessIssueText(title: string, body: string): IssueAssessment {
  const s = extractIssueSignals(title, body);
  const evidence: string[] = [];

  const breadth = s.filePaths + s.crossReferences + s.headings + s.codeBlocks;
  const contextSize: ContextSize = breadth >= 12 ? "large" : breadth <= 2 ? "small" : "medium";
  evidence.push(`context ${contextSize} (breadth signals: ${breadth})`);

  const ambiguity: Ambiguity =
    s.hedges >= 3 || s.openQuestions >= 3 ? "high" : s.hedges === 0 && s.openQuestions <= 1 ? "clear" : "some";
  evidence.push(`ambiguity ${ambiguity} (${s.hedges} hedges, ${s.openQuestions} open questions)`);

  // "Poor" routes to needs-input, which stops automation and asks a human — the one thing
  // the operating contract says should be rare. So it requires positive evidence of a
  // problem, never mere brevity: "Bump node to 24" is short and perfectly actionable, and
  // a terse issue with a descriptive title is a normal way to file work. Only two things
  // qualify: an issue that states essentially nothing at all, or one that hedges heavily
  // while giving no acceptance criteria and no reproduction — a genuinely unresolved ask.
  const nearlyEmpty =
    s.bodyChars < 15 && s.titleChars < 25 && s.checklistItems === 0 && s.filePaths === 0;
  const unresolvedAsk = s.hedges >= 5 && !s.acceptanceCriteria && !s.reproductionSteps;
  const requirementsQuality: RequirementsQuality = nearlyEmpty
    ? "poor"
    : unresolvedAsk
      ? "poor"
      : s.acceptanceCriteria || s.reproductionSteps || s.checklistItems >= 3
        ? "good"
        : "adequate";
  evidence.push(
    `requirements ${requirementsQuality}` +
      (nearlyEmpty ? " (no description)" : unresolvedAsk ? " (unresolved ask)" : ""),
  );

  const reasoningDepth: ReasoningDepth =
    s.deepReasoningMentions >= 2 ? "deep" : s.deepReasoningMentions === 0 ? "shallow" : "moderate";
  evidence.push(`reasoning ${reasoningDepth} (${s.deepReasoningMentions} design-level mentions)`);

  // Silence is `standard`, not `weak`. This service always runs CI, health verification,
  // and rollback, so those safeguards are present whether or not an issue author thought
  // to mention them. Treating an unmentioned test suite as weak verification would
  // up-route nearly every issue — paying for a bigger model to compensate for a risk that
  // is already contained. Only an explicit statement that correctness is hard to observe
  // lowers it.
  const verificationStrength: VerificationStrength =
    s.weakVerificationMentions > 0 ? "weak" : s.verificationMentions >= 3 ? "strong" : "standard";
  evidence.push(
    `verification ${verificationStrength} (${s.verificationMentions} mentions, ${s.weakVerificationMentions} weak signals)`,
  );

  const complexity: Complexity =
    contextSize === "large" || reasoningDepth === "deep"
      ? "complex"
      : contextSize === "small" && reasoningDepth === "shallow"
        ? "simple"
        : "moderate";
  evidence.push(`complexity ${complexity}`);

  const recoverability: Recoverability =
    s.rollbackMentions >= 1 && verificationStrength === "strong"
      ? "high"
      : verificationStrength === "weak"
        ? "low"
        : "medium";
  evidence.push(`recoverability ${recoverability}`);

  return {
    contextSize,
    ambiguity,
    requirementsQuality,
    reasoningDepth,
    verificationStrength,
    complexity,
    recoverability,
    evidence,
  };
}

/**
 * Overlays a text assessment onto label-derived characteristics.
 *
 * Labels win where the author is the authority (type, business risk, priority); the
 * assessment fills the axes the intake contract deliberately stopped asking for. An
 * explicit legacy `dimension:value` label still wins over the reader, so a human can pin
 * an axis during migration without fighting the heuristic.
 */
export function applyAssessment(
  base: IssueCharacteristics,
  assessment: IssueAssessment,
  labels: readonly string[],
): IssueCharacteristics {
  const pinned = (prefix: string) => labels.some((label) => label.startsWith(`${prefix}:`));
  return {
    ...base,
    contextSize: pinned("context") ? base.contextSize : assessment.contextSize,
    ambiguity: pinned("ambiguity") ? base.ambiguity : assessment.ambiguity,
    requirementsQuality: pinned("requirements") ? base.requirementsQuality : assessment.requirementsQuality,
    reasoningDepth: pinned("reasoning") ? base.reasoningDepth : assessment.reasoningDepth,
    verificationStrength: pinned("verification") ? base.verificationStrength : assessment.verificationStrength,
    complexity: pinned("complexity") ? base.complexity : assessment.complexity,
    recoverability: pinned("recoverability") ? base.recoverability : assessment.recoverability,
  };
}
