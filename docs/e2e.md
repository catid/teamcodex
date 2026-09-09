# Docker E2E tests

Run `npm run test:e2e` with Node 22.13+ or 24+, Docker, and Docker Compose.
Run as a non-root user with Docker access. The suite builds the production image,
resolves the production Compose configuration, and uses temporary config/auth
folders and a uniquely named project. Cleanup removes its containers, network,
temporary image, and fixtures, including after assertion failures.

The suite keeps production permissions, mounts, API-key enforcement, and healthcheck.
It replaces the image name, port allocations, health polling interval, and upstreams
for isolation. A mock service runs on an internal Docker network. Test requests run
inside that network. A test-only Node preload redirects the fixed OAuth refresh URL
to the mock and rejects unexpected fetch destinations. No real credentials are used.
Image creation may download the public Node base image; provider traffic stays local.

Coverage includes non-root execution, read-only root filesystem, dropped capabilities,
config/auth modes, health and authentication, CLI status/accounts/API, JSON/SSE
forwarding, request headers and body, token accounting, 401/429 rotation, exhausted
accounts, credential import/removal, OAuth refresh and host-auth synchronization,
earned reset credits, restart persistence, installation reset and backup permissions.
Weighted routing checks a 3:1 distribution over eight requests, rejects unknown
pools, and verifies that pool-selection headers never reach the provider.
Admission checks reject excess requests before forwarding, keep another pool usable,
and recover capacity after cancellation. A paused TCP consumer resumes and receives
a complete 16 MiB SSE response, followed by another successful request.

Permission failure cases cover unreadable config files, unwritable config directories,
and a mismatched container UID. They verify that failed writes preserve the config
and leave no lock/temp files, and that repaired permissions restore operation.
Both config and auth mount paths contain spaces. Runtime probes check actual UID/GID,
file ownership, atomic rename on writable mounts, effective capabilities, and
`NoNewPrivs`. Additional checks cover loopback port bindings, init/restart settings,
tmpfs, wrong API keys, healthcheck failure/recovery after malformed config, and
graceful shutdown followed by restart without losing configuration.

This is mock integration coverage, not proof of current vendor API compatibility.
It does not automate real browser/device consent, host Codex, or OS boot installation.
The local test suite remains separate: `npm test` does not require Docker.

## TUI screenshot review

Run `npm ci`, `npx playwright install chromium`, then `npm run test:tui`.
Alternatively set `CHROMIUM_PATH` to an installed Chromium executable. `node-pty`
requires its native install script (explicitly allowed in package.json); building
from source requires Python and a C++ toolchain.

The native TeamCodex CLI runs inside a real 120×32 PTY. Its ANSI output is rendered
by xterm.js in Chromium. Keyboard actions exercise selection, add/remove menus,
masked key entry and persisted account creation. Local HTTP mocks drive active,
completed and throttled request states. Resize tests cover narrow and too-small
terminals; quitting must exit successfully. No live provider is used.

The dashboard includes API-key and ChatGPT OAuth accounts. Requests verify the
selected credential, API path rewriting, and OAuth account-ID headers. Captures also
cover pool/account usage, a centered minimum-size warning, resize recovery and
selection scrolling across 33 accounts while keeping footer controls visible.
The Docker suite separately validates OAuth refresh and token persistence.
Browser and device menu actions launch the real CLI login subprocess; a local issuer
checks PKCE, temporary config confirms account persistence, and captures 17–20 show
the login prompts and resumed dashboards. Browser-opening commands are inert mocks.

Review `artifacts/tui/index.html`, the PNG screenshots, and matching terminal text.
CI uploads these as `tui-review`, including partial captures when a test fails.
Artifacts are ignored by Git. These are state assertions and review captures,
not pixel-diff baselines; timing and the ephemeral proxy port can vary.
Knip excludes `@xterm/xterm` from dependency reporting because the test loads its
browser JavaScript and CSS assets by path instead of importing the Node module.

## Offline CLI authentication

Run `npm run test:oauth` separately from unit tests (both bind the registered
loopback callback port 1455). Six scenarios spawn the real CLI with temporary
configuration and a local mock issuer: browser S256 PKCE, device authorization
with pending polling, API-key entry, wrong callback state, invalid token response,
and missing device verifier. They check grant fields, persisted account type,
credential file permissions, and that rejected flows never save an account.
The test-only preload redirects authentication fetches and blocks unexpected
fetch destinations; browser launchers are replaced with inert temporary commands.
No real provider credentials or approval are required. CI runs this on Linux and macOS.
These mocks validate client behavior, not live provider acceptance.

`npm run test:coverage` reports Node unit/integration coverage. It does not include
Docker, browser rendering, or subprocess CLI execution in the parent coverage totals.
