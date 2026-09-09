# Authentication references

TeamCodex supports API keys, browser OAuth with S256 PKCE, device authorization,
and importing existing Codex credentials. API keys do not use PKCE. The device
flow receives its verifier from the provider; it does not invent a separate local
verifier or require an operator to enter a device secret.

Implementation references inspected at these upstream revisions (not vendored):

- Codex `9caddc5cf5bf4df5f114498e23bece90eaedb37b`:
  `codex-rs/login/src/pkce.rs`, `server.rs`, and `device_code_auth.rs`.
- Pi `ce5ec9ca355a852fb1f25c088cf409df47a95213`, from
  <https://github.com/earendil-works/pi>:
  `packages/ai/src/auth/oauth/pkce.ts` and `openai-codex.ts`.

Browser login binds a random state to the loopback callback and exchanges the
code with the verifier corresponding to the advertised SHA-256 challenge.
Full callback URLs pasted into the terminal must match state. Raw-code paste
remains a deliberate manual fallback; it cannot validate callback state, but
still uses the session's PKCE verifier. The callback listens on IPv4 loopback
with the registered localhost redirect URI.

The TUI offers separate API-key, browser OAuth, device-code, and import choices.
Browser/device choices hand the terminal to the CLI login flow. Offline CLI
coverage is documented in [e2e.md](e2e.md); screenshots cover the menu, browser/device login handoffs, returned dashboards,
and account authentication labels. Provider consent itself is mocked.

## Account usage reset contract

At the same reviewed Codex revision, inspect
`codex-rs/backend-client/src/client/rate_limit_resets.rs` and
`rate_limit_resets_tests.rs`, plus
`codex-rs/app-server/tests/suite/v2/rate_limit_reset_credits.rs`.
They establish the ChatGPT paths `/backend-api/wham/usage` and
`/backend-api/wham/rate-limit-reset-credits/consume`, JSON `redeem_request_id`,
and outcomes `reset`, `already_redeemed`, `no_credit`, and `nothing_to_reset`.
The app-server tests check both bearer authentication and `chatgpt-account-id`.

TeamCodex reserves attempts per account under the config lock before sending them,
and reuses a pending request ID after uncertain outcomes. Fresh snapshots are bound
to the account object, account ID, and credential. Reservation rechecks disk/live
credentials (including imported auth files), enabled state, and manager membership.
Pool totals, weights, and routing thresholds cannot authorize a reset. Explicit
provider denial (`allowed: false` or `limit_reached: true`) prevents reactivation
even if the reported utilization drops below 100 percent after a reset.
These are source-backed mock checks; no live reset credits were consumed.

The [usage-reset HTTP spike](usage-reset-spike.md) additionally verifies that any
provider-supplied `account_id` matches the requested account. Wire retries and late
responses recheck enabled state, membership and credentials. Responses from changed
accounts leave the original pending ID intact and cannot overwrite replacement
account metrics.
