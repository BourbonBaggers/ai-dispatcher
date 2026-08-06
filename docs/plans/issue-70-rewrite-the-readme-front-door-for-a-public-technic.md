# Issue #70: Rewrite the README front door for a public technical demo

Make the README's first five minutes explain the product, the safe working flow, and
the security posture before the deeper extraction history and policy mechanics.

## Problem

- The current opening starts with implementation detail and extraction history before
  the reader understands the problem, the outcome, or the safe way to try it.
- The README does not surface a compact lifecycle diagram, a quick safe start, or a
  short security model near the top.
- The existing model list mixes active dispatchable models with aliases, fixtures, and
  documentation-only names without enough explanation.

## Solution approach

1. Rewrite the README front door so the opening paragraphs explain the problem and the
   outcome in plain language.
2. Add a compact lifecycle diagram, a five-minute safe quickstart, a concise what-this-is
   / what-this-is-not section, and a short security model near the top.
3. Move the extraction history, detailed policy mechanics, and long technical sections
   below the quickstart while preserving the existing depth.
4. Clarify model names so the reader can distinguish active dispatchable lanes from
   aliases, fixtures, disabled entries, and provider-specific internal names.

## [DONE] Milestone 1: Rewrite the README front door

**Goal:** The top of the README tells a coherent story in plain language and gives a
safe first path to try the dispatcher.

- [ ] Rework the opening paragraphs and add a compact lifecycle diagram or equivalent
      sequence.
- [ ] Add a five-minute safe quickstart using dry-run or one-scan mode.
- [ ] Add a concise `What this is / is not` section.
- [ ] Add a small `Security model` section covering credentials, untrusted issue text,
      dashboard exposure, and autoship.
- [ ] Clarify model names that are aliases, fixtures, disabled entries, or provider
      internal names.
- [ ] Commit: `milestone(1): rewrite the README front door`

## Milestone 2: Reorder supporting material and verify

**Goal:** The remaining README content sits behind the quickstart and the documented
entry points remain accurate.

- [ ] Move extraction history, internal incident numbers, and detailed policy mechanics
      below the quickstart.
- [ ] Add links to the architecture, dogfood runbook, tests, and contribution/security
      guidance.
- [ ] Run the repository verification commands relevant to the README change.
- [ ] Commit: `milestone(2): finish the README front door rewrite`
