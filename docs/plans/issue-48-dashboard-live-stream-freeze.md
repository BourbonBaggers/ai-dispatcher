# Issue #48 dashboard live stream freeze

## Root cause

Expanding **Live stream** opens an `EventSource` to `/api/stream`. On connect the
backend replays every recorded output entry for the current run from `seq 0` in a
tight synchronous loop (`streamInstance` in `src/dashboard.ts`), and the client's
`entry` handler appends each line to the `<pre>` with `textContent +=` followed by a
`scrollTop` read (forces a synchronous reflow) for every single message. For a run
with a non-trivial amount of agent output this floods the tab with thousands of
back-to-back DOM mutations and forced layouts on expand, freezing the page.

Separately, the dashboard's 15s `refresh()` fully replaces `#content` via
`innerHTML`, destroying the open `<details>`/`<pre>` element and silently
re-collapsing the accordion, while the `EventSource` tied to the old, now-detached
`<pre>` is never stopped — it keeps running and accumulating output against a
disconnected element, violating "closed accordions should not hold a stream open"
and leaking a connection per periodic refresh.

## Milestone 1: Bound the backend replay

Cap the number of historical entries `streamInstance` sends when a stream first
attaches to a run (or jumps to a new run), emit a `notice` SSE event describing how
many earlier lines were omitted, and always advance `seq` to the true tail even when
the emitted slice is capped. Explicitly close the response for an unknown unit
instead of leaving the connection open with nothing left to write. Cover the capping
decision with a pure, unit-tested helper.

## Milestone 2: Fix client rendering and lifecycle

Batch incoming SSE entries client-side (coalesce into a bounded ring buffer and flush
the DOM on a short timer instead of per-message) so a burst of history doesn't force
per-line synchronous reflows. Stop mounting/unmounting the live-stream `<details>` on
every periodic refresh: keep it mounted across status refreshes for the selected
instance, and only tear it down (stopping its stream) when the selected instance
changes. Handle malformed SSE payloads and stream errors without throwing.

## Milestone 3: Verify

Add unit tests for the new pure replay-capping helper. Exercise `/api/stream`
end-to-end with a scripted client (fake `ExecFn`, seeded run-output fixture) to
confirm capping, the `notice` event, and clean connection close for an unknown unit.
Run `npm test` and `npm run typecheck`. Browser automation tooling is not available
in this environment and the hard dependency rule forbids adding any (e.g.
Playwright/Puppeteer) as a devDependency, so the client-side fix is verified by
scripted HTTP/SSE checks plus careful manual review rather than a real browser; this
limitation is called out honestly in the PR.
