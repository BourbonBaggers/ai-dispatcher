# Issue #28: on-demand LLM policy cleanup for target repositories

Add `ai-dispatcher target policy-cleanup --repo owner/repo [--dry-run]`: an explicitly
invoked, LLM-powered audit that reconciles a target repository's committed agent
instructions (`AGENTS.md`, `CLAUDE.md`) against the canonical dispatcher policy
(`target-policy.ts`'s `CANONICAL_TARGET_POLICY`, #26), rewrites only those files when they
conflict, and opens a ready PR through the same delivery boundary the other on-demand
command (`ai-dispatcher ship`, #27) already uses. It never runs during normal scans, never
merges/deploys itself, and a clean repository produces no branch or PR.

KISS boundary: no new model-selection setting (reuses `DISPATCHER_CI_ESCALATION_MODEL`),
no source-code edits, no GitHub issue required, structured-JSON model output (not a
free-write agentic session) so the permitted-file boundary is enforced by construction
rather than by post-hoc diff policing across an unbounded write surface.

## [DONE] Milestone 1: pure audit logic (`src/policy-cleanup.ts`)

- `resolvePolicyCleanupConfig(rawModel)`: validates the CLI model via `modelByCliModel` +
  `isDispatchable` (frontier is fine and expected here — this reuses the escalation model,
  unlike the non-frontier blocked-queue auditor).
- `policyCleanupPrompt({ canonicalPolicy, files })`: builds the model prompt. Files with
  `content: null` are reported as "does not exist". Instructs the model to return minified
  JSON `{"conflicts":boolean,"summary":string,"files":[{"path":string,"content":string}]}`,
  to treat the canonical policy as authoritative, preserve repo-specific build/test/arch
  guidance and interactive workflows, scope restrictions to dispatcher-launched sessions,
  and touch only the two named paths.
- `parsePolicyCleanupVerdict(stdout, allowedPaths)`: fail-closed JSON validation —
  `conflicts` boolean required; `summary` non-empty string; each `files[]` entry's `path`
  must be an exact match against `allowedPaths` (no traversal, no new files) with
  non-empty string `content`, no duplicate paths; `conflicts:false` requires an empty
  `files[]` and vice versa (internal consistency).
- Unit test every validation branch.

## [DONE] Milestone 2: CLI config + usage text

- `parsePolicyCleanupCliConfig(argv, env)` in `src/config.ts`: `--repo` (required,
  `DISPATCHER_REPO` fallback), `--dry-run`, `--log-level`. Resolves
  `DISPATCHER_CI_ESCALATION_MODEL` the same way `parseCliConfig` does (shared validation).
  New `POLICY_CLEANUP_USAGE` text; add the subcommand line to the top-level `USAGE`.
- Unit test alongside the existing `config.test.ts` ship-config cases.

## [DONE] Milestone 3: `GithubClient.createPullRequest`

- Add `createPullRequestArgs` + `createPullRequest({ base, head, title, body })` to
  `src/github.ts`, body over stdin (`--body-file -`) like `comment()`, returning the
  created PR number parsed from `gh pr create --json number` or `null` on failure.
- Unit test the argv builder and the client method.

## [DONE] Milestone 4: orchestration (`runPolicyCleanup`)

- In `src/policy-cleanup.ts`, add `runPolicyCleanup(deps, request)`: clones an isolated
  temp checkout (mirrors `generated-conflict-repair.ts`'s `mkdtempSync` pattern), reads
  `AGENTS.md` and `CLAUDE.md` (missing file -> `content: null`, not an error), builds the
  prompt, runs the configured escalation model in single-shot JSON mode (mirrors
  `runBlockedQueueAuditor`'s CLI invocation, larger output budget for full file contents),
  and parses the verdict.
- No conflicts -> return `{ action: "clean" }` without creating a branch or touching git.
- Conflicts + `--dry-run` -> return `{ action: "dry_run", summary, paths }` without
  writing, committing, or pushing.
- Conflicts (real run) -> write only the verdict's own files, confirm
  `git status --porcelain` touched nothing outside the audited path set (defense in depth
  even though the verdict parser already rejects out-of-scope paths), commit on
  `dispatcher/policy-cleanup-<timestamp>`, push, open the PR via
  `createPullRequest` with `Issue: none` framing and no auto-close keywords (reuse
  `ship.ts`'s `findAutoCloseKeyword` to self-check the generated body before creating it).
  Any failure at clone/read/model/write/commit/push/PR-create aborts without a partial
  publish and returns a typed failure outcome.
- Always remove the temp checkout (`finally`).
- Unit test with injected `exec`/model-runner fakes: clean repo, dry-run with conflicts,
  successful cleanup PR, out-of-scope verdict rejected, push/PR failure paths.

## [DONE] Milestone 5: CLI wiring (`main.ts`) + docs

- `ai-dispatcher target policy-cleanup ...` subcommand in `main.ts`, formatting the
  outcome to one line like `runShipCommand` does; non-`clean`/`opened` outcomes exit
  non-zero.
- Document the command in `README.md` next to the `ship` command.
- Run `npm test` + `npm run typecheck`; fix anything red before committing.
