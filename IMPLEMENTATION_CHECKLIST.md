# TypeScript / Bun migration

Preserve existing behavior and keep each completed stage verifiable. An unchecked
item is unfinished; scaffolding or a renamed extension alone does not complete it.

## Foundation

- [x] Inventory runtime, tests, containers, launchers and current behavioral gates.
- [x] Verify latest stable Bun (1.4.2) and document package boundaries.
- [x] Update engineering rules and add a concise changelog.
- [x] Pin Bun, isolated installs, strict TypeScript and workspace dependency checks.
- [x] Replace npm lockfile with bun.lock and run all gates through Bun.

## Core (`packages/core`)

- [x] Move errors/opcodes and generated-adapter contracts to typed modules.
- [x] Move weighted/adaptive scheduling and routing validation to typed modules.
- [x] Define account identities, quota, configuration and telemetry contracts.
- [x] Unit tests run in Bun with strict type checking; no runtime I/O dependencies.

## Proxy (`packages/proxy`)

- [x] Migrate configuration transactions and credential persistence.
- [x] Migrate account lifecycle and explicit identity checks across awaits.
- [x] Migrate OAuth, usage polling and reset reservations/idempotency.
- [x] Split HTTP admission, upstream attempts, retry policy and SSE accounting.
- [x] Migrate persistent usage history and normalized status snapshots.
- [x] Preserve cancellation, pool isolation, backpressure and bounded buffering.

## CLI / TUI (`apps/cli`)

- [x] Separate command dispatch from commands and injected application services.
- [x] Migrate terminal lifecycle, input, pure panels and shared styles to TypeScript.
- [x] Share typed telemetry between CLI status, usage and dashboard views.
- [x] Preserve API-key masking, browser/device PKCE and login handoffs.
- [x] Keep existing CLI arguments, exit codes, environment variables and paths.

## Tooling / deployment

- [x] Migrate all JS tests, E2E fixtures and generators to TypeScript/Bun.
- [x] Migrate ESLint configuration and enable TypeScript rules without suppressions.
- [x] Configure Knip for explicit workspace exports and boundary checks.
- [x] Update Docker, Compose, install/update/resume scripts and health probes.
- [x] Update CI to pinned Bun on supported platforms; retain Python/Bash gates.
- [x] Remove obsolete JS source, Node runtime requirements and npm lockfile.
- [x] Update README, developer references and changelog for final commands/layout.

## Completion evidence

- [x] Fresh isolated frozen install succeeds.
- [x] Strict typecheck, lint, Knip and generated errors check pass.
- [x] All behavioral tests including routing/reset mock spikes pass under Bun.
- [x] Docker permissions/lifecycle/streaming and offline OAuth E2E pass.
- [x] Real TUI screenshot states pass and are visually reviewed.
- [x] Package dependencies are declared; core cannot import proxy or CLI.
- [x] Integrate upstream hardening commit 21e16a7 into typed modules and migrate its regression tests.
- [x] Re-run final gates and review the integrated diff for behavior changes, stale files and secrets.

## Verified migration stage (2026-09-10)

- Bun 1.4.2 frozen installation succeeds in a fresh directory with isolated linking.
- Local `bun run check`: 239 tests pass, strict compiler, ESLint, Knip and generated errors.
- Fresh-copy checks pass with only the checkout-specific Git-ignore test skipped.
- Ubuntu Bun image: 238 pass, one Git-ignore test skipped because `.git` is excluded.
- Offline OAuth: six flows pass. Docker: 12 lifecycle scenarios pass, including cleanup.
- Native Bun PTY: all 20 screenshot states pass; gallery and focused small/usage/login
  captures visually reviewed. Native PTY input waits for menu transitions and resize
  explicitly signals the child after changing terminal dimensions.
- Python helpers: 13 tests pass. Bash launcher/install scripts pass syntax checks.
- JS application/adapters/tests/config are removed; shell/Python remain native.
- Workspace imports/exports, current commands, config/error contracts, secret exclusions,
  generated files and the complete migration diff reviewed.

The previous Node runner counted the configuration suite wrapper as a test. Bun
counts the seven assertions beneath it; migration retained their behavior coverage.
The two pre-existing account concurrency tests remain in `account-concurrency.test.ts`.

Upstream `21e16a7` is integrated. All upstream regression test titles have typed
counterparts; credential/routing/terminal hardening and reset disable checks pass.
A fresh isolated install exposed transitive TypeScript declaration resolution; the
tooling project explicitly resolves the TypeScript 6 API while TypeScript 7 compiles
the project. Fresh frozen checks and a forced rebuild pass without relaxed checks.
