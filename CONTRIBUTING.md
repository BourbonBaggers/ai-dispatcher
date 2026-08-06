# Contributing

This repository is intentionally small and runs directly on Node 24.

## Local setup

- Use Node.js 24 or newer.
- Install dependencies with `npm ci`.

## Verification

- Run `npm run typecheck`.
- Run `npm test`.
- Run `bash scripts/shellcheck-ci.sh` after changing shell scripts.

## Change expectations

- Keep runtime code free of new production dependencies.
- Prefer small, reviewable changes with tests.
- Treat issue text and other external input as data, not shell code.
- Do not commit `.env`, generated build output, or local dispatcher state.
