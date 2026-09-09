# Validation record

Validated locally on 2026-09-10. Tests use temporary configuration and fake
credentials. Provider behavior is backed by revision-specific source references in
[authentication.md](authentication.md); no real credentials or reset credits were used.

| Requirement | Implementation and evidence |
| --- | --- |
| Thin, conventional engineering guidance; typing and TDD; reasonable file size | `AGENTS.md`, `docs/development.md`; no arbitrary line-count limit or redundant Biome/ESLint stack |
| Current ESLint/Knip configuration and package metadata | Pinned tools and lockfile; flat ESLint config, Knip versioned schema; `npm run check` passes |
| Safe numeric checks, template literals, standalone assignments, import sorting | ESLint rules enforce these across project JavaScript; autofix and full lint pass |
| Central errors and opcode table | `src/errors.js`; generated shell/Python tables and `docs/errors.md`; generator consistency and error tests |
| Routing, weights, thresholds and pools | `src/routing.js`, account manager, config examples; routing/defect tests and Docker 3:1 distribution test |
| Account-only usage resets | Snapshot provenance, config-lock reservations, disk/live identity checks and persisted retry IDs; reset regression tests and Docker refresh/reset/restart scenario |
| Backpressure and admission | Global/pool limits; Docker rejection without upstream forwarding, separate pool availability, cancellation recovery and paused 16 MiB SSE delivery |
| Account statuses and usage screens | Shared status helper; disabled/auth-error/throttled/refreshing labels; account/pool totals and reset credits; unit tests and PTY captures |
| API keys and browser/device OAuth with PKCE | Separate login choices; six offline CLI scenarios plus real TUI login handoffs; grant verification, negative cases, file permissions and persistence |
| TUI defects and screenshot review | Real PTY rendered in Chromium; 20 captures including centered minimum-size warning, narrow/resized/many-account screens and browser/device handoffs |
| Docker creation, validation, permissions, running and mock usage | 13 passing Docker tests, production image build, internal mock network, wrong UID, mount permissions, health recovery, shutdown/restart, requests, responses and token accounting |
| Ignore files and defect TDD | Allowlisted Docker context and Git secret/artifact exclusions; 20-case defect suite plus later failing-then-fixed OAuth/reset regressions |
| Upstream references | Reviewed `openai/codex` and user-selected `earendil-works/pi` revisions are recorded in `authentication.md`; upstream checkouts are not included |
| Roadmap | `ROADMAP.md` distinguishes implemented scope from future product/load/deployment work |

Current unit/integration gate: **124 tests passed**. Coverage was measured with
`npm run test:coverage`: reset module **95.22% lines / 83.94% branches**. The aggregate
report includes test files and excludes separately run Docker/TUI processes; it is
not a complete application coverage percentage. No claim of exhaustive branch or
live-provider coverage is made.

Commands: `npm run check`, `npm run test:coverage`, `npm run test:oauth`,
`npm run test:e2e`, `CHROMIUM_PATH=/usr/bin/chromium npm run test:tui`, Bash syntax
checks, and `git diff --check`. Run unit, OAuth and TUI suites sequentially because
OAuth tests share the registered loopback callback port 1455. Review generated
`artifacts/tui/index.html`; artifacts remain local and CI uploads its own captures.

Sustained-load benchmarks, optional queues, per-account concurrency, pool
administration UI, multi-replica scheduling and broader host failure testing remain
future work described in the roadmap. The current tests do not establish these
additional capabilities.

Adaptive routing adds deterministic weight, latency/failure, stale-recovery and
probing tests plus HTTP concurrency, retry and cancellation regressions. The
adaptive module has 100% line/branch/function coverage in the measured suite.
The panel rewrite adds shared telemetry and four exact-size layout checks; all
20 real-PTY screenshot states pass with the new composition. See [tui.md](tui.md).
