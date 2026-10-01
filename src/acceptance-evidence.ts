/**
 * What the post-ship audit shows its judge (#98).
 *
 * Normally that is the merged PR's unified diff. GitHub refuses to render a diff over 300
 * files or 20 000 lines, and that refusal is permanent for the PR, so a large cleanup used
 * to leave its audit unreadable on every scan forever. The files API still lists such a PR,
 * so the fallback is its changed-file list: every file with its status and line counts
 * first — enough on its own to show what a cleanup touched — then whole per-file patches
 * while they fit.
 *
 * The judge never sees more than `MAX_EVIDENCE_CHARS`, so the listing is budgeted here
 * rather than cut mid-file by the prompt. Whatever is left out is stated, never silent: an
 * omission judge must not read "not shown" as "not done".
 */

import type { GithubPrFile } from "./github.ts";

/** The most evidence the judge prompt carries. */
export const MAX_EVIDENCE_CHARS = 60_000;

/** `changed-files` tells the judge that it is reading the fallback listing, not a diff. */
export type AuditEvidenceKind = "diff" | "changed-files";

/** The file list may use at most this share of the budget; the rest is for patches. */
const FILE_LIST_SHARE = 0.5;

/** Room kept for the closing notes, so they always fit. */
const NOTES_RESERVE = 200;

/** The files API stops listing here, so a list this long may be incomplete. */
const FILES_API_LIMIT = 3000;

/** Untrusted paths stay on one line, so a crafted name cannot forge listing structure. */
function oneLine(text: string): string {
  return text.replace(/[\r\n]+/g, " ");
}

function fileLine(file: GithubPrFile): string {
  const path =
    file.previousFilename === undefined
      ? file.filename
      : `${file.previousFilename} -> ${file.filename}`;
  return `${file.status} +${file.additions}/-${file.deletions} ${oneLine(path)}`;
}

function patchBlock(file: GithubPrFile): string {
  const from = oneLine(file.previousFilename ?? file.filename);
  return `diff --git a/${from} b/${oneLine(file.filename)}\n${file.patch ?? ""}`;
}

/**
 * The changed-file listing the judge reads when the PR's diff is too large. Added, modified,
 * and renamed files' patches come first, in GitHub's order; a patch that does not fit is
 * skipped whole rather than truncated, so every patch shown is complete.
 */
export function changedFilesEvidence(
  files: readonly GithubPrFile[],
  maxChars: number = MAX_EVIDENCE_CHARS,
): string {
  const statusCounts = new Map<string, number>();
  for (const file of files) statusCounts.set(file.status, (statusCounts.get(file.status) ?? 0) + 1);
  const summary = [...statusCounts].map(([status, count]) => `${count} ${status}`).join(", ");

  const out: string[] = [];
  let used = 0;
  const push = (text: string): void => {
    out.push(text);
    used += text.length + 1;
  };

  push(`GitHub refused this pull request's diff as too large. ${files.length} files changed: ${summary}.`);
  push("");
  push("Changed files (status +additions/-deletions path):");
  const listBudget = Math.floor(maxChars * FILE_LIST_SHARE);
  let listed = 0;
  for (const file of files) {
    const line = fileLine(file);
    if (used + line.length + 1 > listBudget) break;
    push(line);
    listed += 1;
  }
  if (listed < files.length) push(`... ${files.length - listed} more files not listed for space`);

  const withPatch = files.filter((file) => file.patch !== undefined && file.patch !== "");
  const ordered = [
    ...withPatch.filter((file) => file.status !== "removed"),
    ...withPatch.filter((file) => file.status === "removed"),
  ];
  const patchBudget = maxChars - NOTES_RESERVE;
  let omitted = 0;
  if (ordered.length > 0) {
    push("");
    push("Patches:");
    for (const file of ordered) {
      const block = patchBlock(file);
      if (used + block.length + 1 > patchBudget) {
        omitted += 1;
        continue;
      }
      push(block);
    }
  }

  const notes: string[] = [];
  if (files.length >= FILES_API_LIMIT) {
    notes.push(`GitHub lists at most ${FILES_API_LIMIT} files, so more may have changed.`);
  }
  if (omitted > 0) notes.push(`${omitted} patches omitted for space.`);
  const withoutPatch = files.length - withPatch.length;
  if (withoutPatch > 0) {
    notes.push(`${withoutPatch} files have no patch (removed, binary, or too large for GitHub).`);
  }
  if (notes.length > 0) {
    push("");
    push(notes.join(" "));
  }
  return out.join("\n").slice(0, maxChars);
}
