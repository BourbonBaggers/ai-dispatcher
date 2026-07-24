# ShellCheck CI Guard

> Historical incident evidence. The current executable contract is
> `scripts/shellcheck-ci.sh` plus its regression tests.

Issue #12 investigated two live PR checks that appeared to be stuck in ShellCheck:

- `BourbonBaggers/ai-dispatcher` PR #11, run `30033367167`, commit
  `d9a272a8a1debab4bc19f9bf8972f0a834e52f22`.
- `BourbonBaggers/internal-tools` PR #401, run `30028149415`, commit
  `c7265b7bc2a7748351373a94f099e04eac7cc733`.

Both runs later completed successfully. Their completed GitHub Actions metadata showed
the shared delay happened before the shell-checking jobs started:

- In `ai-dispatcher`, the workflow was created at `2026-07-23T18:21:41Z`, but the
  `test` job started at `2026-07-23T20:18:09Z`. Its ShellCheck step ran from
  `20:18:24Z` to `20:18:34Z`.
- In `internal-tools`, the workflow was created at `2026-07-23T17:08:36Z`, but the
  `shell` job started at `2026-07-23T20:19:55Z`. Its ShellCheck step ran from
  `20:19:58Z` to `20:20:07Z`.

The confirmed common failure mode was therefore GitHub Actions runner or job scheduling
delay, not a proven ShellCheck analysis hang.

This repository still runs ShellCheck through `scripts/shellcheck-ci.sh` so future
incidents are phase-visible. CI reports the ShellCheck version, repository-owned file
count, discovery duration, check duration, batch size, and the five-minute analysis
timeout. Installation remains in the workflow step so its duration is visible separately.

Follow-up for `BourbonBaggers/internal-tools`: apply the same pattern there if its shell
workflow still combines package installation, file discovery, and ShellCheck analysis in
one unbounded command.
