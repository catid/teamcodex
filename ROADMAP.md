# Roadmap

## Implemented

- Optional adaptive account routing using latency, failures and in-flight load.

- Central error registry and generated shell/Python adapters and documentation.
- ESLint, Knip, sorted imports, template literals, safe numeric checks, and standalone assignments.
- Docker mock E2E: lifecycle, permissions and failure recovery, health, token refresh,
  request/response forwarding, accounting, rotation, persistence, and reset backups.
- Offline CLI browser/device PKCE and API-key authentication regression coverage.
- Docker verification of weighted distribution, routing-header isolation, pool
  saturation, cancellation recovery, and paused-client SSE delivery.
- Real TUI browser/device login handoffs with offline PKCE and review screenshots.
- Named pools, smooth weighted round-robin, ordered failover, account weights,
  disabled accounts, per-account/pool thresholds, and configuration validation.
- Global/pool admission limits with immediate overload responses; stream backpressure.

## Next validation and product work

- Add sustained-load measurements for throughput, latency, memory and fairness.
- Add per-account concurrency limits and optional bounded queueing with deadlines
  if load measurements justify them; preserve cancellation and retry budgets.
- Expose per-pool active requests, rejection counts and routing decisions in status/TUI.
- Add explicit pool authorization if different clients require isolated credentials.
- Add deliberate cross-pool fallback policies only with explicit configuration.
- Decide whether reset-credit policy needs per-account overrides alongside routing.
- Add operator CLI/TUI controls for pool membership and weights; config edits currently
  provide these settings and credential replacement preserves them.
- Validate upstream API contracts against versioned evidence and maintain mock fixtures.
- Broaden Docker coverage to macOS bind mounts, port collisions, disk-full writes,
  interrupted configuration transactions and unavailable Docker daemon diagnostics.
- Add production deployment guidance for multiple replicas; scheduling and limits
  currently apply independently in each process.

These are follow-ups, not claims that all operational failure modes are tested.
