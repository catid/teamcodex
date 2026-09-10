# Terminal interface

The dashboard uses bordered Accounts, Telemetry and Activity panels, with reset
credits in the header and context-sensitive actions in a fixed footer. Wide
terminals show telemetry beside accounts; narrow terminals stack it when there
is room. Tiny terminals show a centered size hint. Account selection scrolls
without hiding the footer. `u` opens detailed account and pool usage.

`s` switches the active account in unpooled routing. With explicit pools, selection
follows each pool's strategy, so the switch shortcut is hidden and explains this
restriction if pressed. Edit pool membership or strategy and reload with `R`.
External account, activity, and usage text is stripped of terminal controls before
styling and display.

## Responsibilities

- `apps/cli/src/tui/controller.ts`: terminal lifecycle, input, actions, and server event handlers.
- `apps/cli/src/tui/view.ts`: screen composition, account rows and context-sensitive footer.
- `apps/cli/src/tui/panels.ts`: bounded panel layout; add dashboard panels here.
- `apps/cli/src/tui/style.ts`: ANSI styles, visible width, clipping, padding and quota meters.
- `packages/core/src/telemetry.ts`: normalized account/pool totals consumed by operator views.
- `apps/cli/src/tui/usage.ts`: scrollable detailed usage using the same normalized snapshot.

Renderers do not mutate configuration or perform provider I/O. Add actions to the
controller; expose data in the public status snapshot and normalize it in telemetry
before displaying it. Pools show member totals; overall totals count each account
once. Adaptive measurements are per-account and shared across pool memberships.
Unknown quota or reset credits remain unknown, rather than displaying a false zero.

Validation includes exact panel dimensions at four terminal sizes and real PTY
screens rendered in Chromium, including masked key entry, OAuth handoffs, disabled
accounts, selection scrolling, usage and resize recovery. Run `bun run test:tui`
and review `artifacts/tui/index.html`. These captures are not pixel baselines.
