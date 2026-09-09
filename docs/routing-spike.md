# Mock routing spike

Run `bun test packages/proxy/test/routing-spike.test.ts`. All providers are loopback HTTP
servers with fake credentials; the suite runs without Docker or provider access.

## Finding and fix

Before the fix, all three pool strategies could repeatedly retry a failing member
on HTTP 503. Failover always selected the first member, while a 1000:1 configured
weight overwhelmed the weighted/adaptive alternatives. The original nine-case
matrix produced six passes and three failures.

Request-local exclusions now make transient retries prefer an untried eligible
member. Membership is resolved again for every attempt. Once no untried eligible
member remains, the existing bounded retry policy can reuse a member; it cannot
borrow accounts from another pool. Independent requests retain the original policy.

## Coverage

The expanded 19-case spike checks:

- All three strategies against 503, 429, 401 and socket disconnection.
- Exact credential sequence, unchanged request payload and removal of the pool header.
- Zero leaked adaptive in-flight reservations after requests/retries.
- Emptying pool membership during an attempt fails closed, without using outsiders.
- A one-member pool makes exactly three attempts with a two-retry budget.
- Threshold preferences, serving the only usable near-quota account, and expired
  quota recovery for each strategy.

Existing tests separately cover adaptive load/latency feedback, weighted shares,
client cancellation, SSE backpressure, hot reload identity, and account-only resets.
This is behavioral integration validation, not a production throughput benchmark
or proof of provider availability.
