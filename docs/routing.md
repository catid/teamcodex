# Routing and admission control

Existing configurations retain sticky, quota-aware failover. Configure `routing`
to opt into named pools. Requests use `routing.defaultPool` unless the caller sends
`x-teamcodex-pool`. The proxy consumes this header and never forwards it upstream.
Unknown pools return 400; exhausted pools return 429 and never spill into another pool.
Pools are routing groups, not authorization boundaries: any proxy client can select one.

```json
{
  "maxConcurrentRequests": 100,
  "switchThreshold": 0.98,
  "accounts": [
    { "name": "primary", "type": "apikey", "apiKey": "fake-key", "weight": 3, "enabled": true, "switchThreshold": 0.9 },
    { "name": "secondary", "type": "apikey", "apiKey": "fake-key-2", "weight": 1 }
  ],
  "routing": {
    "defaultPool": "main",
    "pools": {
      "main": { "accounts": ["primary", "secondary"], "strategy": "weighted-round-robin", "switchThreshold": 0.95, "maxConcurrentRequests": 50 }
    }
  }
}
```

Pool strategy defaults to smooth weighted round-robin: weights 3:1 yield three
selections for primary per secondary selection while both are eligible. Weights
count request attempts, not tokens or cost. `failover` selects the first eligible
member in pool order. Account weights are integers 1–1000, default 1; `enabled`
defaults true. Disabled, rejected and throttled accounts are excluded.
Threshold precedence is account, pool, global. Thresholds are fractions 0–1 and
prefer fresher accounts; if every usable member exceeds its threshold, it can still
serve until upstream throttles it. Thresholds are not spending caps. Usage-reset
policy remains separate from routing thresholds.

Reset credits are strictly per OAuth account. `autoReset.threshold` is a shared
default applied independently to each account's own provider-reported usage and
available credits. Pool totals, weights, routing thresholds, and the TUI's summed
credit display never authorize a redemption. Snapshots are bound to the account
object, provider account ID, and credential that fetched them. Disabled accounts
cannot redeem. Cooldowns and pending redemption IDs are keyed by provider account
ID, so overlapping pool membership does not multiply reset attempts. Retrying an
uncertain pending redemption reuses its original ID, even if current usage drops.

Configuration reload updates pool policy and account overrides. Removing an account
through the CLI also removes its pool memberships. Empty pools fail closed. Resetting
installation settings preserves accounts but resets routing to the default behavior.
Eligibility is checked again after token refresh, before forwarding. Accounts disabled,
removed, or moved out of the selected pool during that wait cannot receive the request.
Removing the selected pool or repeatedly changing eligibility during preparation returns
503 `ROUTING_CHANGED` with `Retry-After: 1`; retries remain bounded across reloads.

Manual TUI switching is available only without explicit pools. With pools configured,
account selection follows each pool's strategy; edit its membership or strategy and
reload the configuration to change routing.

The global concurrency limit defaults to 100; a pool can impose a lower limit.
Limits accept integers 1–10000. Admission occurs before request-body buffering.
Excess requests receive 503 `PROXY_OVERLOADED` and `Retry-After: 1`, without an
unbounded waiting queue. Slots are released on completion or disconnect. Status and
reload endpoints remain available under load. SSE writes already wait for `drain`
and stop on disconnect. Limits are process-local, not coordinated across replicas.

Algorithm reference: NGINX's published upstream round-robin implementation uses
current-weight accumulation and subtraction of total weight for the selected peer.

## Adaptive routing

Set a pool's `strategy` to `"adaptive"` to adjust account traffic using measured
upstream header latency, failure rate and current in-flight attempts. For example:

```json
{
  "defaultPool": "main",
  "pools": {
    "main": { "accounts": ["primary", "secondary"], "strategy": "adaptive" }
  }
}
```

Put this object in `routing`, and define both account names in `accounts`.
Existing configurations retain their current strategy. Account weights remain
relative capacity settings; adaptive routing scales them, then uses smooth weighted
round-robin. Disabled, throttled and errored accounts and pool boundaries retain
precedence. Quota thresholds retain their existing preference semantics.

Each account's effective weight is its configured weight multiplied by a bounded
latency/failure factor, divided by `inFlight + 1`. Latency and failure observations
use EWMA (20% new sample). A neutral 1000ms latency prior decays stale evidence with
a 30-second half-life. The quality factor stays between 0.05 and 2 so slower
eligible accounts receive recovery probes. It is a preference, not a circuit
breaker or a concurrency limit; global/pool admission still applies independently.

Latency measures fetch start to headers, excluding credential refresh and client
stream-consumption time. Load stays reserved throughout the upstream attempt,
including streaming. HTTP 429/5xx, embedded quota errors and network/body failures
penalize attempts; ordinary client errors do not. Client cancellation releases
load without adding a failure observation. Every retry releases its prior attempt
before selecting again. Metrics follow account objects across pools and are kept
in memory; a new identity/restart starts cold. Status includes `adaptive` metrics
(`inFlight`, `latencyMs`, `failureRate`, `samples`, and monotonic `updatedAt`).
Adaptive feedback never reserves or spends usage-reset credits.

Without explicit pools, startup and failover use a shuffled routing schedule while
keeping display/configuration indexes stable. Explicit pool strategies retain
their specified member ordering and adaptive/weighted scheduling behavior.

Transient retries prefer eligible pool members not yet rejected by this request's
503/network attempts, before applying quota preference and the pool strategy.
Once every eligible member has been tried, retries may reuse members within the
existing retry budget. The exclusion is request-local: it never disables accounts
for other clients, bypasses pool membership, or changes configured weights.
