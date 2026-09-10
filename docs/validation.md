# Validation record

Validated on 2026-09-10 after the TypeScript/Bun migration and integration of
upstream hardening commit `21e16a7`. Tests use temporary configuration and fake
credentials. Provider behavior is backed by revision-specific source references in
[authentication.md](authentication.md); no real credentials or reset credits were used.

| Requirement | Implementation and evidence |
| --- | --- |
| Thin, conventional engineering guidance; typing and TDD; reasonable file size | `AGENTS.md`, `docs/development.md`; no arbitrary line-count limit or redundant Biome/ESLint stack |
| Current ESLint/Knip configuration and package metadata | Pinned tools and lockfile; flat ESLint config, Knip versioned schema; `bun run check` passes |
| Safe numeric checks, template literals, standalone assignments, import sorting | ESLint rules enforce these across project TypeScript; autofix and full lint pass |
| Central errors and opcode table | `packages/core/src/errors.ts`; generated shell/Python tables and `docs/errors.md`; generator consistency and error tests |
| Routing, weights, thresholds and pools | `packages/core/src/routing/config.ts`, account manager, config examples; routing/defect tests and Docker 3:1 distribution test |
| Account-only usage resets | Snapshot provenance, config-lock reservations, disk/live identity checks and persisted retry IDs; reset regression tests and Docker refresh/reset/restart scenario |
| Backpressure and admission | Global/pool limits; Docker rejection without upstream forwarding, separate pool availability, cancellation recovery and paused 16 MiB SSE delivery |
| Account statuses and usage screens | Shared status helper; disabled/auth-error/throttled/refreshing labels; account/pool totals and reset credits; unit tests and PTY captures |
| API keys and browser/device OAuth with PKCE | Separate login choices; six offline CLI scenarios plus real TUI login handoffs; grant verification, negative cases, file permissions and persistence |
| TUI defects and screenshot review | Real PTY rendered in Chromium; 20 captures including centered minimum-size warning, narrow/resized/many-account screens and browser/device handoffs |
| Docker creation, validation, permissions, running and mock usage | 12 passing Docker scenarios in one Bun lifecycle test, production image build, internal mock network, wrong UID, mount permissions, health recovery, shutdown/restart, requests, responses and token accounting |
| Ignore files and defect TDD | Allowlisted Docker context and Git secret/artifact exclusions; 20-case defect suite plus later failing-then-fixed OAuth/reset regressions |
| Upstream references | Reviewed `openai/codex` and user-selected `earendil-works/pi` revisions are recorded in `authentication.md`; upstream checkouts are not included |
| Roadmap | `ROADMAP.md` distinguishes implemented scope from future product/load/deployment work |

Current local unit/integration gate: **247 tests passed** under Bun 1.4.2.
Strict TypeScript, ESLint, Knip and generated-adapter checks pass. A fresh frozen
install and full checks pass; the Ubuntu Bun image passes 246 tests with the
checkout-specific Git test skipped. Python helpers pass 13 tests and Bash syntax checks pass. The separate
OAuth suite passes all six flows; Docker passes its 12 lifecycle scenarios; the
native PTY suite produces all 20 screenshot states. Small/narrow, usage and browser/
device captures were visually reviewed. These mocks do not establish live-provider
acceptance or exhaustive branch coverage. Older Node coverage percentages are not
carried forward as Bun migration evidence.

Commands: `bun run check`, `bun run test:coverage`, `bun run test:oauth`,
`bun run test:e2e`, `CHROMIUM_PATH=/usr/bin/chromium bun run test:tui`, Bash syntax
checks, and `git diff --check`. Run unit, OAuth and TUI suites sequentially because
OAuth tests share the registered loopback callback port 1455. Review generated
`artifacts/tui/index.html`; artifacts remain local and CI uploads its own captures.

Sustained-load benchmarks, optional queues, per-account concurrency, pool
administration UI, multi-replica scheduling and broader host failure testing remain
future work described in the roadmap. The current tests do not establish these
additional capabilities.

Adaptive routing adds deterministic weight, latency/failure, stale-recovery and
probing tests plus HTTP concurrency, retry and cancellation regressions. The panel rewrite adds shared telemetry and four exact-size layout checks; all
20 real-PTY screenshot states pass with the new composition. See [tui.md](tui.md).

All upstream hardening regressions have typed counterparts, including credential
replacement, persistence races, reload eligibility, cancelled uploads, terminal
controls and disabled-account reset retries. A clean isolated frozen install and
forced compiler rebuild verify tooling declarations against the TypeScript 6 API;
application compilation remains TypeScript 7 with `skipLibCheck: false`.

The shared I/O follow-up adds eight tests for generic HTTP adapters and filesystem
mechanisms. All provider/service calls use the shared API client; application and
tooling filesystem imports use shared exports. Configuration, token persistence
and history use shared atomic writes/locking. Fresh install, full checks, Ubuntu,
Docker, OAuth and TUI gates pass with the new workspace included.
