# Issue 12: Prevent ShellCheck PR checks from hanging indefinitely

The referenced `ai-dispatcher` and `internal-tools` runs both eventually completed. Their
GitHub metadata shows the shared delay was before the shell-checking jobs started running:
once scheduled, the ShellCheck steps completed in seconds. This repo still needs bounded,
phase-visible ShellCheck CI so the next incident can distinguish runner queueing,
installation, discovery, and analysis without guesswork.

## [DONE] Milestone 1: Document the observed root cause

- Record the confirmed evidence from the referenced `ai-dispatcher` PR #11 run
  `30033367167`: the `test` job was created at 18:21 UTC but only started at 20:18 UTC;
  the ShellCheck step then completed in roughly 10 seconds.
- Record the supporting `internal-tools` PR #401 run `30028149415`: the `shell` job was
  created at 17:08 UTC but only started at 20:19 UTC; its ShellCheck step also completed
  in roughly 10 seconds.
- Note that the common failure mode was runner/job scheduling delay rather than proven
  ShellCheck analysis hang.

## [DONE] Milestone 2: Add bounded repository-owned ShellCheck discovery

- Add a repo script that discovers only tracked repository shell files.
- Exclude generated, vendor, dependency, build, temporary, and cache directories.
- Do not follow symlinks, and skip symlink entries even if tracked.
- Log the exact ShellCheck command and discovered file count before analysis starts.

## [DONE] Milestone 3: Time and bound each ShellCheck phase

- Time installation, discovery, and checking separately in CI output.
- Run ShellCheck in bounded batches instead of one unbounded invocation.
- Apply a five-minute timeout to the analysis phase with an actionable local reproduction
  command when it fires.
- Preserve normal ShellCheck failures as required-check failures.

## Milestone 4: Validation and PR

- Run `npm test`, `npm run typecheck`, and the new ShellCheck wrapper.
- Commit each completed milestone with `milestone(N): ...`.
- Push the branch and open a ready-for-review PR referencing `Issue: #12` without
  auto-close keywords.
