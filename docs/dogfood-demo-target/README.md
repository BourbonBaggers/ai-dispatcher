# Dogfood demo target

This directory is a tiny local fixture repository for demonstrating `ai-dispatcher`
end to end without relying on a private production target.

## What it contains

- One intentionally simple issue: `docs/dogfood-demo-target/issues/1.md`
- A minimal label set for intake:
  - `dispatch:ready`
  - `agent:codex`
  - `priority:p1`
  - `effort:small`
- A short issue body that asks for a trivial code change and is safe to hand to the
  dispatcher in a dogfood run.

## How to use it

Create a throwaway GitHub repository from this fixture or copy the files into a local
test repository, then point the dispatcher at that repository with the normal `--repo`
configuration.

For the first dogfood pass:

- run `--dry-run` to verify intake and routing
- run `--once` for a single scan
- keep autoship disabled

This fixture is intentionally tiny so the flow from issue intake to PR-ready handoff is
easy to follow and repeat.

