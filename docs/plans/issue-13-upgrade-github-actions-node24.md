# Issue 13: Upgrade GitHub Actions from deprecated Node 20 runtimes

`actions/checkout@v4` and `actions/setup-node@v4` run on the deprecated Node 20
action-runtime, which GitHub is forcing onto Node 24. Move the CI workflow to the
Node 24-compatible `@v6` releases of both actions while keeping the application's
own Node 24 test version and dependency caching intact.

## [DONE] Milestone 1: Upgrade CI workflow actions

- Bump all three `actions/checkout@v4` uses in `.github/workflows/ci.yml` to `@v6`.
- Bump `actions/setup-node@v4` to `@v6`, keeping `node-version: 24` (the application
  test version, unrelated to the action-runtime version).
- Add `cache: npm` to the `setup-node` step since `package-lock.json` is committed,
  making `npm ci` caching explicit rather than implicit/absent.

## Milestone 2: Validate and PR

- Run `npm test` and `npm run typecheck`.
- Commit with `milestone(N): ...` and open a ready-for-review PR referencing
  `Issue: #13` without auto-close keywords.
