# TypeScript and Bun migration

Target runtime: Bun **1.4.2**, verified against the official stable release at
<https://github.com/oven-sh/bun/releases/tag/bun-v1.4.2>. The previous installed
runtime was 1.3.14. Use pinned Bun with isolated dependency installation.

## Dependency direction

`apps/cli` → `packages/proxy` → `packages/core`.
The CLI may also consume core types. Core owns errors, domain contracts and pure
routing algorithms; proxy owns HTTP, persistence, provider authentication and
account coordination; CLI owns terminal interaction and commands. Keep modules
organized by responsibility within these packages. Do not create one package per
small helper. Workspace exports are the cross-package API, not source-path imports.

Tests and E2E fixtures remain test-only tooling. Shell/Python host integrations stay
in their native languages; JavaScript application, tooling and tests migrate to
TypeScript. Production packages declare every dependency they consume.

## Method

Move one cohesive responsibility at a time, add real types, then run its compiler
and behavioral tests. Keep behavior covered when moving modules; remove obsolete adapters once all
consumers use the package API. The migration removed the former Node entry points
after Bun equivalents passed the same behavior checks. No `allowJs` completion shortcut,
`@ts-nocheck`, implicit/explicit `any`, or relaxed strictness to clear errors.

Prefer interfaces for contracts and functions for policy; retain classes where they
own meaningful lifecycle/state. SOLID means explicit responsibilities and dependencies,
not factories or interfaces for every function. KISS means no speculative framework.
Inject only nondeterministic boundaries needed for tests (time, I/O, random selection).
Keep identity checks, retry budgets, reset idempotency, atomic persistence, request
accounting and terminal behavior covered throughout the migration.

Track actual completion in [IMPLEMENTATION_CHECKLIST.md](../IMPLEMENTATION_CHECKLIST.md).

## Compiler compatibility

TypeScript 7.0.2 supplies `tsc`; ESLint uses the TypeScript 6 API through the
`typescript` alias to `@typescript/typescript6@6.0.2`, following Microsoft's
[side-by-side guidance](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/#running-side-by-side-with-typescript-60).
Bun 1.4.2 declarations require current Node declarations. Pin `@types/node` 26.5.1:
the registry's `latest` tag currently resolves to 22.20.2, which lacks declarations
used by Bun. This is type compatibility, not a Node runtime requirement.
`skipLibCheck` remains false. Recheck these pins when upgrading the toolchain.

## Current layout

Core owns errors, routing policy, retry classification, config validation and shared
account/quota/telemetry contracts. Proxy owns atomic persistence, account lifecycle,
auth protocols, reset reservations and HTTP handling. CLI owns command dispatch,
service wiring, browser/stdin orchestration and terminal presentation.

All application code, tests, E2E harnesses, error generation and ESLint configuration
are TypeScript. `apps/cli/src/index.ts` is the single Bun entry point. Docker and CI
use the same pinned runtime. Shell/Python host integrations remain native.

The TUI harness uses `Bun.Terminal`, checked against the pinned runtime's
[implementation](https://github.com/oven-sh/bun/blob/bun-v1.4.2/src/runtime/api/bun/Terminal.rs)
and [spawn tests](https://github.com/oven-sh/bun/blob/bun-v1.4.2/test/js/bun/terminal/terminal-spawn.test.ts).
Screenshots render real PTY output through xterm in Chromium.
