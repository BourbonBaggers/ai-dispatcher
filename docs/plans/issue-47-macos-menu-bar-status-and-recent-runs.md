# Issue #47 macOS menu bar status app and recent non-idle runs

## [DONE] Milestone 1: Dashboard Recent Runs

Add a pure recent-run summary path for the dashboard that filters out idle/no-work
activity, orders meaningful runs newest first, caps the list at five, and exposes a clear
empty state without changing dispatcher execution behavior.

## [DONE] Milestone 2: Compact Dashboard View

Add a compact status variant for the existing dashboard URL that works well in a menu bar
popover, hides the live stream by default, and keeps the existing full dashboard behavior
intact.

## [DONE] Milestone 3: macOS Menu Bar App And Docs

Add a small macOS status item app that opens the compact dispatcher view from
`http://192.168.0.240:8787`, reports an unavailable/offline state clearly, and document
install, launch, login autorun, and expected dashboard URL.

## [DONE] Milestone 4: Verification

Cover recent-run filtering/rendering and the documented app path with tests or scriptable
verification, then run the repository-required test and typecheck commands.
