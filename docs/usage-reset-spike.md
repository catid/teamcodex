# Usage-reset mock spike

Run `bun test packages/proxy/test/usage-reset-spike.test.ts`. The 20 scenarios use real loopback
HTTP requests and temporary configuration transactions, with mock provider bodies
and a controllable clock. No live credentials or provider reset credits are used.

## Findings

Four initial regression assertions exposed three production defects:

1. Usage carrying a different `account_id` could authorize a reservation. Supplied
   identity now must match the requested account, including verification after reset.
   Older responses without an account ID remain supported.
2. Disabling an account after the first failed consume did not prevent wire retries.
   Enabled state is now checked before each attempt and after response completion.
3. A late consume response could apply to replacement credentials on the same account
   object, clearing their credit count or overwriting quota. Response identity and
   credentials are now rechecked before processing; pending IDs remain for safe retry.

The malformed-JSON scenario also caught a mock-server double-response bug, which
was fixed in the fixture rather than treated as a production defect.

## Assertions

- Wrong-account usage cannot reserve credits, update quota, or confirm recovery.
- Disabled/replaced accounts cannot receive another retry or stale metric updates.
- Disconnects, 503s and invalid JSON retain the same redemption ID across restart,
  including when subsequent usage and credits are zero.
- Concurrent monitors and overlapping weighted/adaptive pools yield one reservation
  for the qualifying account; another account's totals do not authorize a reset.
- The reservation is readable from disk before the provider receives the POST.
- All four terminal outcomes honor the hour cooldown; a later redemption gets a new ID.
- Oversized, unavailable and malformed usage cannot initiate a spend.
- Shutdown interrupts retry while retaining the pending ID.
- Failed persistence prevents the consume request entirely.

The mock's ID set represents one logical redemption. Actual exactly-once effects
require the provider's idempotency contract; repeated HTTP attempts are expected.
An already-sent POST cannot be recalled by disable/reload, so uncertain outcomes
retain their original ID. This spike does not claim distributed consensus or live
provider acceptance. The pinned source references are in [authentication.md](authentication.md).

The spike now runs under Bun 1.4.2. Its HTTP fixture closes the listener once;
Bun's `closeAllConnections()` also stops the listener, unlike Node's behavior
([pinned implementation](https://github.com/oven-sh/bun/blob/bun-v1.4.2/src/js/node/_http_server.ts)).
The teardown difference does not change reservation, retry or response assertions.
