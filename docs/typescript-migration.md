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
and behavioral tests. Temporary legacy adapters may re-export completed modules
until consumers move; list their removal in the checklist. Do not call a mixed
runtime stage complete. Keep existing Node checks during the transition until their
Bun replacements prove the same behavior. No `allowJs` completion shortcut,
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

Errors, routing policy, retry classification and configuration validation now live
in core. Atomic configuration persistence and retry timing live in proxy. Legacy
`src` modules re-export package APIs temporarily; remove them as consumers migrate.

Account lifecycle, hot reload, token import/refresh, device authorization and OAuth
callback handling now live in `packages/proxy`. Usage normalization and telemetry
aggregation are pure core modules; reset reservations and history persistence remain
in proxy. Browser launch/stdin/terminal presentation stay in CLI. Account identity
checks across awaited refresh, imports and reset requests remain explicit; helper
predicates re-read mutable state after awaits instead of trusting stale narrowing.
