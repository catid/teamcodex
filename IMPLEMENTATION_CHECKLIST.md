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
- [ ] Define account identities, quota, configuration and telemetry contracts.
- [ ] Unit tests run in Bun with strict type checking; no runtime I/O dependencies.

## Proxy (`packages/proxy`)

- [ ] Migrate configuration transactions and credential persistence.
- [ ] Migrate account lifecycle and explicit identity checks across awaits.
- [ ] Migrate OAuth, usage polling and reset reservations/idempotency.
- [ ] Split HTTP admission, upstream attempts, retry policy and SSE accounting.
- [ ] Migrate persistent usage history and normalized status snapshots.
- [ ] Preserve cancellation, pool isolation, backpressure and bounded buffering.

## CLI / TUI (`apps/cli`)

- [ ] Separate command dispatch from commands and injected application services.
- [ ] Migrate terminal lifecycle, input, pure panels and shared styles to TypeScript.
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
