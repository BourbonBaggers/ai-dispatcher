# Historical record — Issue #14 closed held runs

> Completed. This file records the regression and is not an active deployment checklist.

`recheckHeldRun` reads the linked issue state before labels or autoship:

- `CLOSED` retires the run as `abandoned` without shipping, commenting, relabelling, or
  notifying.
- `UNKNOWN` fails closed and waits for the next scan.
- `OPEN` keeps a proven exhausted hold, but automatically clears and resumes a legacy
  hold that has no durable exhaustion proof.

Validation and deployment were completed through green CI. Historical instructions to
restart a service are intentionally removed: repository changes never authorize starting
or restarting a disabled production dispatcher.
