# Developer reference

## Upstream source

Use the official [Codex source](https://github.com/openai/codex) and
[user-selected Pi source](https://github.com/earendil-works/pi) as references.
Reviewed revisions and relevant files are recorded in
[authentication references](authentication.md). Upstream checkouts are not included
in this repository.

## Code map

| Area | Files |
| --- | --- |
| CLI dispatch, service wiring, token persistence, host Codex launch | `src/index.js` |
| HTTP forwarding, authentication, SSE parsing, request retries | `src/server.js`, `src/retry.js` |
| Account selection, quota state, token refresh | `src/account-manager.js` |
| Account resolution, matching, hot reload | `src/accounts.js` |
| Config validation, locking, atomic writes, backup/reset | `src/config.js` |
| OAuth browser/device flows and credential import | `src/oauth.js` |
| Error codes, numeric identifiers, and messages | `packages/core/src/errors.ts`, [error table](errors.md) |
| Usage polling and earned reset-credit redemption | `src/usage-reset.js` |
| Native terminal dashboard | `src/tui.js`, `src/tui-view.js`, `src/tui-panels.js`; [extension guide](tui.md) |
| Live diagnostic and container health probe | `src/smoke.js`, `src/healthcheck.js` |
| Docker launcher and installation | `teamcodex.sh`, `install.sh`, `compose.yaml`, `Dockerfile` |
| Boot integration | `scripts/install-boot.py`, `scripts/start-at-boot.py` |

Operational instructions belong in [README.md](../README.md). The native entry point
is `node src/index.js`; `teamcodex.sh` manages Docker and launches Codex on the host.
The two paths have different config locations, documented in the README.

## Invariants to preserve

- **Config transactions:** use `atomicConfigUpdate` for read/modify/write operations.
  It re-reads under a cross-process lock; saving a stale in-memory config can discard
  concurrent CLI changes. Preserve atomic rename, restrictive file permissions,
  and reset backups (`test/config.test.js`).
- **Account identity across awaits:** reload can remove, replace, or reorder accounts
  while a request or refresh is pending. Retain the account object and recheck
  identity/credentials before applying results; an old array index must not update
  another account. Token persistence must not overwrite newer imported credentials
  (`test/accounts.test.js`, `test/server.test.js`).
- **Forwarding and retries:** ChatGPT paths pass through; API-key accounts rewrite
  Codex response paths to the public API. Preserve bounded retries and immediate
  429 rotation. Once output is sent, close a failed stream instead of replaying the
  request. Preserve client-disconnect cancellation, idle deadlines, and incremental
  SSE parsing (`test/server.test.js`).
- **Usage-reset persistence:** reserve a redemption on disk before its POST. Retain
  its request ID when the outcome is uncertain, reuse that ID on retry, and preserve
  pending IDs and cooldowns through installation reset. Verify usage afterward
  before recovering an exhausted account (`test/usage-reset.test.js`).
- **Credentials and launchers:** authenticate proxy sessions with the proxy key;
  refresh upstream tokens in the proxy. Sync host auth only for a matching account.
  Preserve literal argument boundaries, paths with spaces, and the caller's working
  directory. Native loopback access bypasses the key unless
  `TEAMCODEX_REQUIRE_API_KEY=1`; Compose sets that flag (`test/cli.test.js`,
  `test/oauth.test.js`, `test/server.test.js`).

## Verification

`test/defects.test.js` covers 20 regression scenarios across routing validation,
pool isolation, credential handling, OAuth state, error serialization, usage totals,
ignore patterns, request validation, and account status. The Git-ignore case runs
only in a checkout; the runtime Docker test image intentionally contains no `.git`.

`.gitignore` excludes local secrets, reports, caches and editor files while retaining
examples and lockfiles. `.dockerignore` uses an explicit allowlist
for both Dockerfiles, with credential/log exclusions applied last.

Use Bun 1.4.2 and `bun install --frozen-lockfile` for development. Node 22.13+
or 24+ still runs legacy entry points during migration. `bun run check` checks
generated errors, strict types, ESLint, Knip, Bun workspace tests and legacy tests.
Use `npm run lint` or `npm run knip` for individual checks. The test runner itself
(`node --test`) needs no dependencies and uses temporary files, fake credentials,
mocked commands, and local HTTP servers.

ESLint uses the current flat config API and recommended rules with Node globals.
Import/export sorting is automatic with `npm run lint:fix` using simple-import-sort.
Global `isNaN` is forbidden; use explicit numeric conversion and `Number.isNaN`.
Use template literals for interpolation. Keep assignments in standalone statements;
`for` loop initialization and updates are allowed, but assignments in conditions are not.
Knip discovers the CLI and tests from package metadata and its Node plugin; its
explicit healthcheck entry is invoked by Compose. `codex` and `xdg-open` are external
host binaries, intentionally excluded from npm dependency reporting.

Configuration references: [ESLint](https://eslint.org/docs/latest/use/configure/configuration-files)
and [Knip](https://knip.dev/reference/configuration). Knip's schema is pinned to the
installed version. Update tool versions, lockfile, and schema together.

Register application errors in `packages/core/src/errors.ts`; see [the error table](errors.md).
Run `bun run errors:generate` after changing definitions. Shell and Python adapters
are generated so host launchers do not require Node. Do not edit generated files.

CI in `.github/workflows/test.yaml` runs Node.js 22 and 24 on Ubuntu and macOS,
checks Bash syntax, builds the application image, and runs the Ubuntu test image:

```sh
docker build -t teamcodex:local .
docker build -f test/Dockerfile.ubuntu -t teamcodex-test:ubuntu .
docker run --rm teamcodex-test:ubuntu
```

Use these for container changes and report any unavailable checks. Native tests
do not establish Docker or boot-service integration. `smoke`, including `--rotate`,
uses configured accounts and live upstream requests; it is not an offline test.

Run `npm run test:e2e` for Docker lifecycle and mock-provider integration checks;
see [E2E coverage](e2e.md). CI runs this separately from the local suite.

Reset reservation regressions include credential replacement on disk, removal from
the live manager, and unchanged/replaced imported credentials. Provider denial after
redemption cannot clear throttling solely because a displayed percentage decreased.
See [authentication references](authentication.md#account-usage-reset-contract)
for the upstream implementation and fixture evidence behind these rules.

## Upstream integration (cbdbd32)

The main-branch integration adds `stats.js` for persistent usage history and
`status.js` for the CLI status dashboard, plus Python resume/update helpers.
Run `python3 -m unittest discover -s test -p 'test_*.py'` for helper changes.
History counters remain separate from the TUI's since-start account totals and
from provider quota/reset-credit policy. Explicit pools retain their configured
strategy; randomized initial/rotation order applies to legacy unpooled routing.
The AccountManager test RNG is the fourth constructor argument, leaving the third
argument available for routing configuration.
