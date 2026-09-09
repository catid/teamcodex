# TypeScript / Bun migration

Preserve existing behavior and keep each completed stage verifiable. An unchecked
item is unfinished; scaffolding or a renamed extension alone does not complete it.

## Foundation

- [x] Inventory runtime, tests, containers, launchers and current behavioral gates.
- [x] Verify latest stable Bun (1.4.2) and document package boundaries.
- [x] Update engineering rules and add a concise changelog.
- [x] Pin Bun, isolated installs, strict TypeScript and workspace dependency checks.
- [ ] Replace npm lockfile and scripts once all gates run through Bun.

## Core (`packages/core`)

- [x] Move errors/opcodes and generated-adapter contracts to typed modules.
- [x] Move weighted/adaptive scheduling and routing validation to typed modules.
- [x] Define account identities, quota, configuration and telemetry contracts.
- [ ] Unit tests run in Bun with strict type checking; no runtime I/O dependencies.

## Proxy (`packages/proxy`)

- [ ] Migrate configuration transactions and credential persistence.
- [x] Migrate account lifecycle and explicit identity checks across awaits.
- [ ] Migrate OAuth, usage polling and reset reservations/idempotency.
- [x] Split HTTP admission, upstream attempts, retry policy and SSE accounting.
- [x] Migrate persistent usage history and normalized status snapshots.
- [ ] Preserve cancellation, pool isolation, backpressure and bounded buffering.

## CLI / TUI (`apps/cli`)

- [ ] Separate command dispatch from commands and injected application services.
- [x] Migrate terminal lifecycle, input, pure panels and shared styles to TypeScript.
- [ ] Share typed telemetry between CLI status, usage and dashboard views.
- [ ] Preserve API-key masking, browser/device PKCE and login handoffs.
- [ ] Keep existing CLI arguments, exit codes, environment variables and paths.

## Tooling / deployment

- [ ] Migrate all JS tests, E2E fixtures and generators to TypeScript/Bun.
- [ ] Migrate ESLint configuration and enable TypeScript rules without suppressions.
- [ ] Configure Knip for explicit workspace exports and boundary checks.
- [ ] Update Docker, Compose, install/update/resume scripts and health probes.
- [ ] Update CI to pinned Bun on supported platforms; retain Python/Bash gates.
- [ ] Remove obsolete JS source, Node runtime requirements and npm lockfile.
- [ ] Update README, developer references and changelog for final commands/layout.

## Completion evidence

- [ ] Fresh isolated frozen install succeeds.
- [ ] Strict typecheck, lint, Knip and generated errors check pass.
- [ ] All behavioral tests including routing/reset mock spikes pass under Bun.
- [ ] Docker permissions/lifecycle/streaming and offline OAuth E2E pass.
- [ ] Real TUI screenshot states pass and are visually reviewed.
- [ ] Package dependencies are declared; core cannot import proxy or CLI.
- [ ] Review complete diff for accidental behavior changes, stale files and secrets.

## Verified intermediate state

- Core errors, routing, retry and config validation compile strictly with TS 7.
- Proxy config transactions and retry timing use declared core workspace exports.
- Generated error adapters run through Bun; legacy JS entry points remain temporary.
- Credential persistence, OAuth, HTTP lifecycle, telemetry, CLI/TUI and test migration
  remain unfinished. Containers still run Node until the full runtime transition.

### Foundation verification

- `bun run check`: strict compiler, ESLint, Knip, generated adapters, 9 Bun tests
  and 194 legacy tests pass with Bun 1.4.2 orchestrating the gates.
- Docker mock lifecycle: 13 tests pass. Ubuntu image: 193 pass, one checkout-only
  Git-ignore test skipped. Offline OAuth: 6 tests pass.
- These are intermediate checks; full Bun runtime, fresh-install completion and
  migrated TUI screenshot evidence remain outstanding.

### Account and usage stage

- Typed account lifecycle/hot reload, token import/refresh, device polling, callback
  validation, reset coordination and usage history now live in proxy.
- Core owns account/quota/reset/usage contracts and operator telemetry aggregation.
- Browser orchestration and terminal handoff remain in legacy CLI pending migration.
- History tests and all 20 usage-reset HTTP spike scenarios now run under Bun;
  legacy routing and reset-unit tests remain regression gates.

- Stage gate: strict types, ESLint, Knip and generated adapters pass; 37 Bun tests
  and 168 legacy tests pass. Docker lifecycle: 13 pass; offline OAuth: 6 pass.
- Next: HTTP admission/streaming seams, credential persistence callback, then CLI
  workspace and browser/terminal orchestration. Full Bun runtime remains unfinished.

### HTTP and terminal stage

- HTTP server, retries, rate limits, stream delivery and response accounting now
  compile in proxy; browser orchestration and all TUI modules compile in CLI.
- Routing spike (19 scenarios) and panel tests now run in Bun, alongside direct Bun
  SSE tests. Typed auth-file mirroring is in proxy; serve wiring is still legacy.
- Node PTY suite generated 20 screenshots; small terminal, usage and browser/device
  login states were visually reviewed. Docker lifecycle passed all 13 scenarios.
- Remaining: CLI commands/dispatch, status/smoke, legacy test migration, runtime and
  deployment switch to Bun, then final full-scope verification.

- Final stage gate: 69 Bun tests and 138 legacy tests pass; compiler, lint, Knip
  and generated files pass. Node remains available for compatibility verification.
