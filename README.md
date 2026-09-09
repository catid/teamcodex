# TeamCodex

A multi-account proxy for Codex CLI, with quota tracking, automatic account rotation, and OAuth token refresh. The proxy runs in Docker on Ubuntu Linux and macOS, including Apple Silicon MacBooks. Codex runs on the host and retains access to your working directory.

## Install with Docker

Prerequisites:

- **Mac:** install and start [Docker Desktop for Mac](https://docs.docker.com/desktop/setup/install/mac-install/), choosing the build for your processor.
- **Ubuntu:** install `bubblewrap` for host Codex (`sudo apt install bubblewrap`), then install [Docker Engine and the Compose plugin](https://docs.docker.com/engine/install/ubuntu/). Configure Docker access for your regular user using Docker's [Linux post-install instructions](https://docs.docker.com/engine/install/linux-postinstall/), then sign in again if your group membership changed.
- **Both:** Git, Bash, Python 3.9+ (for updates and the session picker), and a host installation of [Codex CLI](https://developers.openai.com/codex/cli/). The proxy image includes Node.js; a host Node.js installation is only needed if your Codex installation method requires it or you develop TeamCodex.

Verify Docker before installing:

```bash
docker info
docker compose version

git clone https://github.com/catid/teamcodex.git
cd teamcodex
./install.sh
```

The installer builds this checkout, initializes configuration, imports an existing Codex `auth.json` when no accounts are configured, and links the Docker launcher into `~/.local/bin/teamcodex`. Run the installer as your regular user so config ownership matches the container user.

If `~/.local/bin` is missing from your PATH, add this line to `~/.zshrc` on a typical Mac or `~/.bashrc` on a typical Ubuntu installation, then open a new terminal:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

You can always use `./teamcodex.sh` from this checkout. Keep the checkout in place: the installed launcher points to it. No nested TeamCodex checkout, global npm installation, or tmux session is required.

If no credentials were imported, add an account:

```bash
./teamcodex.sh login --device-auth
```

Start the proxy and run Codex:

```bash
./teamcodex.sh serve
./teamcodex.sh status
./teamcodex.sh run
```

`serve` starts the container in the background and waits for its health check. `run` also starts the container if necessary, then launches host Codex in your current directory. Docker publishes the proxy at `http://127.0.0.1:1456` and requires its generated proxy key on every request.

`teamcodex run` retains the existing behavior of adding `--dangerously-bypass-approvals-and-sandbox`. Use `teamcodex run --safe` to let Codex use its own approval and sandbox settings. Docker isolates the proxy; Codex's commands execute on the host.

## Start automatically at boot

On Ubuntu, Docker Engine must be enabled and the proxy container started. To also recreate the service at boot after a `teamcodex stop`, install the included systemd unit as your regular user:

```bash
python3 scripts/install-boot.py
sudo systemctl status teamcodex
```

On a Mac Studio or other unattended Mac, install [Colima](https://github.com/abiosoft/colima/blob/main/docs/FAQ.md#does-colima-support-autostart), Docker CLI, Compose, and Buildx with Homebrew. The installer uses a system LaunchDaemon running as your user to start Colima and TeamCodex at boot, with retries if startup fails:

```bash
brew install colima docker docker-compose docker-buildx
mkdir -p ~/.docker/cli-plugins
ln -sfn /opt/homebrew/opt/docker-compose/bin/docker-compose ~/.docker/cli-plugins/docker-compose
ln -sfn /opt/homebrew/opt/docker-buildx/bin/docker-buildx ~/.docker/cli-plugins/docker-buildx
colima start
python3 scripts/install-boot.py
sudo launchctl print system/com.teamcodex.boot
```

Use `/usr/local` instead of `/opt/homebrew` for Intel Homebrew. The boot installer uses the default config location and requires passwordless sudo for installing the service definition. On a MacBook using Docker Desktop, enable **Start Docker Desktop when you sign in** in Docker settings instead; Desktop requires a user login. FileVault must be unlocked after a Mac powers on before user data and services can start.

The regular commands remain `teamcodex start`, `teamcodex stop`, and `teamcodex restart` on both platforms. With the optional boot unit installed, a manual stop lasts until you start it again or reboot. To disable boot startup, use `sudo systemctl disable --now teamcodex` on Ubuntu, or `sudo launchctl bootout system/com.teamcodex.boot` followed by `sudo launchctl disable system/com.teamcodex.boot` on Colima macOS. Mac boot logs are under `~/Library/Logs/TeamCodex/`.

Each machine can keep independent credentials and operate without depending on another machine. Copies of the same OAuth login can later diverge when refresh tokens rotate; if needed, re-login on that machine or securely copy a current config/account login again. Keep config and backups private (mode 600); account reset cooldowns are local to each install.

For Linux sandbox warnings, follow the [Codex sandbox prerequisites](https://developers.openai.com/codex/concepts/sandboxing#prerequisites). Ubuntu 24.04 may also need the distribution's `bwrap-userns-restrict` AppArmor profile loaded. If Codex reports missing metadata for a supported model, update the host Codex CLI (`codex update` for standalone installations, or update the npm package for npm installations), then retry.

## Accounts and login

Add each account that should participate in rotation:

```bash
teamcodex login --device-auth --name personal
teamcodex login --device-auth --name work
teamcodex accounts
teamcodex status
```

Sign into a different ChatGPT account for each login. If the browser has kept the previous account signed in, switch accounts there before authorizing. Re-authorizing the same account updates it. Every configured account participates in rotation immediately; no service restart is needed.

Each proxy startup creates an independently shuffled rotation order and starts with its first account. The proxy follows that order when quota limits, rejected credentials, or transient failures require another account. Added accounts enter a random position; config and display order stay unchanged. This spreads starting accounts across independent machines without coordination. A healthy active account continues serving until rotation is needed, preserving connection reuse. `teamcodex status` includes the current `rotationOrder`.

### Device authorization

Docker login uses device authorization on both operating systems:

```bash
teamcodex login
teamcodex login --device-auth --name secondary
```

Open the printed URL in any browser, enter the one-time code, and complete sign-in. The command waits up to 15 minutes. No browser callback port or display server is needed. `--browser` is available only with the native development CLI.

### Import existing Codex credentials

```bash
codex login
teamcodex import
teamcodex accounts -v
```

The launcher mounts `$CODEX_HOME` (default `~/.codex`) at `/codex`, so `import` reads `/codex/auth.json`. File-based ChatGPT credentials are required for import; if your Codex installation uses an OS credential store, use device authorization instead.

An explicit `--from` path must exist **inside** the container:

```bash
teamcodex import --from /codex/another-auth.json --name secondary
```

Importing or logging into an existing account updates its entry by account ID, then by name. `login`, `import`, and `remove` notify the running container to reload accounts immediately. `accounts` lists local metadata without rotating tokens or modifying config.

### API key accounts

```bash
teamcodex login --api --name api-fallback
```

API key support is experimental and uses your OpenAI platform account. The proxy rewrites `/backend-api/codex/...` to `/v1/...` for API accounts, including `/responses` and `/responses/compact`. Model access and request compatibility depend on your API account. Use ChatGPT accounts for subscription access.

## Automatic earned usage resets

TeamCodex checks every ChatGPT account at startup and every five minutes, including accounts currently waiting for their usage limits to reset. It reads the provider's usage windows and available **earned reset credits**. At or above 98% usage in the most-used reported window, an account with a confirmed available credit automatically redeems one. Accounts require a known ChatGPT account ID for automatic redemption; `login` and normal Codex imports populate it.

The threshold applies separately to each account's own usage and credit balance. Pool averages, the number of accounts polled, and the currently selected account do not determine eligibility. For example, if account A is at 99% and account B is at 20%, only A qualifies for a new redemption, using A's credits and credentials. Conversely, an account at 97.99% remains ineligible even when the pool average exceeds 98%. The check uses the highest utilization across that account's reported windows, including its five-hour and weekly windows.

This implements the provider contract inspected in [Bifrost's ChatGPT reset controller](https://github.com/c0ldfront/bifrost/blob/fa8ee27/deploy/oauth/pi-account.mjs) and its [reset policies](https://github.com/c0ldfront/bifrost/blob/fa8ee27/plugins/oauthprovider/README.md). TeamCodex uses a threshold for each account, fitting its account rotation model.

The defaults are enabled, including when an older config omits this section:

```json
"autoReset": {
  "enabled": true,
  "threshold": 0.98,
  "pollIntervalSeconds": 300
}
```

Set `enabled` to `false` to disable automatic redemption, or change the threshold from `0.01` to `1`. The polling interval can be 30–3600 seconds. Restart the service after editing settings. Usage monitoring continues when redemption is disabled, so quota and available-credit information remains visible in `teamcodex status`.

Only credits explicitly reported as available can initiate a new redemption. Missing availability remains **unknown**, and the proxy does not purchase credits. There is at most one new logical redemption per account per hour, including unsuccessful outcomes. Transient HTTP and network failures get two bounded retries with the same ID; uncertain redemptions are checked again after one minute using that ID. The cooldown and any pending redemption ID are stored in `usageResetState` in config and survive restarts, upgrades, account renaming, and `teamcodex reset`. Preserve this generated state when editing config.

The provider chooses which usage windows a credit restores. `reset` and `already_redeemed` outcomes require a fresh usage read before TeamCodex reports completion or reactivates a throttled account. `no_credit` and `nothing_to_reset` are unsuccessful outcomes. After a timeout, unknown outcome, or failed usage refresh, retries reuse the same persisted ID—even if the last credit has already been consumed—to avoid spending another credit for the same attempt. A completed reset that still reports exhausted usage does not reactivate the account.

```bash
teamcodex status  # Available credits and last automatic reset result
teamcodex logs   # Automatic usage reset events
```

## Retries and task recovery

The proxy retries transient connection errors, response timeouts, and HTTP 408/500/502/503/504 up to twice, switching accounts between attempts. HTTP 401 gets one token refresh per account before rotation; HTTP 429 and embedded rate-limit errors immediately rotate through the available pool. Request bodies and any supplied idempotency key are preserved. Transient token-refresh outages temporarily back off an account and allow recovery instead of permanently disabling it.

```json
"retry": { "maxRetries": 2, "headerTimeoutSeconds": 60, "idleTimeoutSeconds": 120 }
```

Each attempt waits at most 60 seconds for headers and 120 seconds between response chunks. Active streams can run longer; activity renews the idle deadline. A stalled connection is aborted. Retries only occur before any response reaches the client. If a stream fails after output begins, the proxy closes it so Codex can handle recovery without the proxy replaying partial output. A retry before output can still repeat provider work if the provider accepted the earlier request but its response was lost.

When every account is unavailable, the proxy allows up to five seconds for a coalesced usage/reset recovery check, then returns a bounded response with `Retry-After`. Usage polling handles three accounts concurrently so one slow account does not block the whole pool. Fresh reduced usage can restore a throttled account. Request and buffered response bodies are limited to 32 MiB; individual SSE events to 1 MiB. Retry counts can be 0–5, timeouts 1–600 seconds. Restart after editing settings.

## Updating

From any directory, run:

```bash
teamcodex update
```

The command fast-forwards the installed checkout's current branch from its configured Git upstream, builds the new Docker image, and applies it with a health check. The existing service keeps running during the build; Compose replaces it when the image or service configuration changes. Existing accounts, configuration, and session history are retained. A stopped service starts after a successful build.

Tracked local edits stop the update before pulling. Commit or stash those edits first. Local commits are retained; diverged branches require you to resolve the Git history. Untracked files are preserved, and Git refuses an update that would overwrite them. Updates to the same checkout are serialized with an automatically released lock. Git commands have a two-minute deadline, image builds ten minutes, and deployment waits up to two minutes for health. A failed build leaves the running service in place; a failed health check reports failure so you can inspect `teamcodex logs` and retry after fixing it.

For an older installation that does not yet recognize `update`, run `git -C ~/teamcodex pull --ff-only`, then `~/teamcodex/teamcodex.sh update`. If an existing shell still invokes an older npm launcher, use `type -a teamcodex` and `rehash` (zsh) or `hash -r` (Bash) to refresh command lookup. The expected installed command is `~/.local/bin/teamcodex`, pointing to this checkout's `teamcodex.sh`.

## Commands

| Command | Behavior |
| --- | --- |
| `teamcodex build` | Build the Docker image from this checkout |
| `teamcodex update` | Fast-forward the installed checkout, rebuild, apply the image, and wait for service health |
| `teamcodex serve` | Start in the background and wait for health; aliases: `start`, `server` |
| `teamcodex stop` | Stop and remove the container and Compose network; retain host config |
| `teamcodex restart` | Recreate the container and wait for health |
| `teamcodex logs` | Follow recent proxy logs; Ctrl-C stops following |
| `teamcodex ps` | Show container state and health |
| `teamcodex smoke [--model MODEL]` | Send a live hello through the running service (uses model tokens) |
| `teamcodex smoke --rotate` | Start an isolated diagnostic on the second account, inject a 429, and verify rotation followed by a real hello; does not alter live pool state |
| `teamcodex status` | Show account health, quota bars, reset credits, token totals, and usage charts |
| `teamcodex status --compact` | Show aggregate statistics and a compact account table |
| `teamcodex status --json` | Export the complete live status snapshot for scripts |
| `teamcodex init` | Create config; import host Codex credentials if accounts are empty |
| `teamcodex login` | Add or update an account using device authorization |
| `teamcodex import` | Import a Codex credential file |
| `teamcodex accounts [-v]` | List configured accounts and optionally token expiry |
| `teamcodex remove NAME` | Remove an account and reload the server |
| `teamcodex reset` | Stop the server, back up config, reset settings and proxy key, retain accounts |
| `teamcodex run [--safe] [ARGS...]` | Run host Codex through the proxy |
| `teamcodex resume [ARGS...]` | Resume a saved Codex session through the proxy; shorthand for `teamcodex run resume` |
| `teamcodex fork [ARGS...]` | Branch a saved Codex conversation into a new session through the proxy; shorthand for `teamcodex run fork` |
| `teamcodex env` | Print a shell command for host Codex, including the proxy key |
| `teamcodex api PATH` | Call an upstream endpoint directly with a configured account |
| `teamcodex help` | Show command help |

Arguments pass through to Codex without shell evaluation:

```bash
teamcodex run resume
teamcodex run resume --last
teamcodex resume
teamcodex resume --all
teamcodex fork
teamcodex run "fix the tests"
teamcodex run --safe exec "explain this repository"
```

Codex allows one active writer per session. If `resume` reports **already has an active writer**, that session is still open in another Codex process, including a detached tmux session. Return to its existing tmux pane, or exit that Codex process with `/quit` before resuming it elsewhere. To continue a separate branch while the original stays open, use `teamcodex fork SESSION_ID` (or `teamcodex fork` for the picker). Forking creates a new conversation with the saved history; see the [official OpenAI command reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli#codex-fork). Do not delete a live writer's lock file.

The Docker launcher's resume/fork picker includes saved conversations from **all providers**, including sessions created with regular Codex before TeamCodex was installed. Type to search, use the arrow keys to select, and press Enter. By default it shows the current directory; `--all` includes other directories, `--last` continues the most recently updated matching session, and `--include-non-interactive` also lists `codex exec` sessions. Explicit session IDs and names pass directly to Codex. Selection uses Codex's local `thread/list` API with a 30-second deadline; it does not rewrite, copy, or fork history. The selected original session ID is resumed through the TeamCodex provider. The host and container use the same `TEAMCODEX_CODEX_HOME`/`CODEX_HOME` directory.

The `env` output is a complete, shell-quoted command to copy and run. It contains a credential; avoid sharing it. The old `codex $(teamcodex env ...)` invocation is no longer valid. Prefer `teamcodex run`.

For upstream diagnostics:

```bash
teamcodex api /backend-api/wham/usage --account secondary
teamcodex api /v1/models --account api-fallback
```

`api` also accepts `--method POST` and `--data JSON`. It bypasses proxy rotation and uses the selected account's stored credentials.

## Status and usage history

```bash
teamcodex status
teamcodex status --compact
teamcodex status --json > teamcodex-status.json
```

The dashboard shows the selected account and rotation order, service uptime and requests in flight, each account's plan and health, quota bars with reset countdowns, polling freshness, earned reset credits and pending redemptions, and access-token expiry and refresh availability. Unknown usage and credits remain distinct from zero. Window labels follow the provider's reported duration. Status reads the local snapshot; it does not trigger an upstream usage poll or redeem a credit.

Aggregate statistics include input, output, and cached input tokens; finished client requests; upstream attempts and retries; final HTTP errors; disconnected requests; and average request duration. Cached input is a subset of input, so the total is **input + output**. A request that rotates through three accounts counts as one finished request, three attempts, and two retries. Attempts belong to the account attempted; the finished request belongs to the final routed account. Disconnected requests are included among finished requests and reported separately from HTTP errors. Status, health checks, reloads, and automatic usage/reset polling do not inflate traffic counts.

Two terminal charts show tokens per hour for 24 UTC hour buckets and per day for 30 UTC day buckets, including the current partial bucket. Each chart scales to its own highest bucket; dots mean no recorded tokens. Today and last-seven-day totals use UTC calendar days. The JSON snapshot includes the bucket timestamps and exact counters for your own graphs. Use `--no-color` or `NO_COLOR=1` for plain output; colors are automatically disabled when redirected. `COLUMNS=80 teamcodex status` selects a narrower layout.

History starts when the updated service starts; the dashboard displays its tracking start time. It cannot reconstruct earlier usage. Counts cover requests passing through **this machine's proxy**, across all its accounts. Provider quota percentages can include other clients and machines; they are separate from these token totals. Missing upstream token usage is not estimated. Repeated cumulative usage events within an upstream response are counted once. History is independent on each machine, with no central service dependency.

Totals survive service restarts, updates, account rotation, and configuration resets. Docker stores them in `~/.config/teamcodex/config.json.usage.json` (or beside your custom config); native mode uses `<config-path>.usage.json`. The file contains counters and hashed account identifiers, with owner-only permissions, and no credentials or prompts. ChatGPT account history follows its account ID across renames; API-key accounts use their configured name. Removing an account keeps its historical contribution to the aggregate. Cumulative totals are retained indefinitely, with 48 hourly and 30 daily buckets on disk.

Writes are debounced by one second and saved atomically; normal shutdown flushes pending counters. An abrupt kill or power loss can lose the latest unsaved activity. Back up this file alongside your config to preserve history. If saving fails, the dashboard reports the error while retaining current counters in memory. Damaged or unsupported history is preserved without overwriting it; stop the service and restore a valid backup, or move the damaged file aside to start fresh tracking.

## Configuration and persistence

Docker stores configuration at `~/.config/teamcodex/config.json`, or `$XDG_CONFIG_HOME/teamcodex/config.json`. The directory is mounted into the container, so atomic file replacement, account updates, and backups survive container restarts and upgrades. Config and backup files use owner-only permissions.

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `TEAMCODEX_CONFIG_DIR` | `$XDG_CONFIG_HOME/teamcodex` or `~/.config/teamcodex` | Host directory containing `config.json` and backups |
| `TEAMCODEX_CODEX_HOME` | `$CODEX_HOME` or `~/.codex` | Host Codex auth directory mounted at `/codex` |
| `TEAMCODEX_PORT` | `1456` | Published host port and Codex proxy URL |
| `TEAMCODEX_BIN_DIR` | `~/.local/bin` | Launcher installation directory, used by `install.sh` |

Set custom variables consistently for installation and subsequent commands, for example in your shell profile:

```bash
export TEAMCODEX_CONFIG_DIR="$HOME/.config/teamcodex-work"
export TEAMCODEX_PORT=2456
./install.sh
teamcodex serve
```

The launcher sets the container UID and GID to those of the host user. This allows writes to mounted config on Ubuntu and macOS without root-owned files. The Compose project is named `teamcodex`; these settings relocate a single installation, rather than creating independent concurrent instances. Use environment exports with the launcher; a repository `.env` file is not its configuration interface.

Generated config looks like this; the real key is randomly generated:

```json
{
  "proxy": {
    "host": "127.0.0.1",
    "port": 1456,
    "apiKey": "tcx-generated-secret"
  },
  "upstream": "https://chatgpt.com",
  "apiUpstream": "https://api.openai.com",
  "switchThreshold": 0.98,
  "autoReset": { "enabled": true, "threshold": 0.98, "pollIntervalSeconds": 300 },
  "accounts": []
}
```

See [config.example.json](config.example.json) for an import-based account example. Run the installer or `init` to generate a unique key instead of copying the example key into service.

For weighted routing, per-account thresholds, named pools, and concurrency limits,
see [routing configuration](docs/routing.md). Follow-up work is tracked in [ROADMAP.md](ROADMAP.md).

| JSON field | Meaning |
| --- | --- |
| `proxy.host`, `proxy.port` | Native listening address; Docker overrides these to `0.0.0.0:1456` inside the container |
| `proxy.apiKey` | Proxy credential accepted via bearer authorization or `x-api-key` |
| `upstream` | ChatGPT backend origin |
| `apiUpstream` | OpenAI platform API origin |
| `switchThreshold` | Quota utilization from 0 to 1 at which rotation prefers another account |
| `retry` | Bounded transient retries and response header/idle timeouts; see task recovery above |
| `autoReset` | Automatic earned-credit redemption policy; defaults to enabled at 98%, polling every five minutes |
| `usageResetState` | Generated per-account cooldowns and pending redemption IDs; preserve when editing config |
| `accounts` | Named `chatgpt` or `apikey` entries |

ChatGPT entries store `accessToken`, `refreshToken`, `idToken`, `accountId`, `expiresAt` (milliseconds), and optional `planType` and `source`. An `importFrom` entry loads its credential file if stored credentials are absent. API entries store `apiKey`. Files referred to by `importFrom` must be available inside Docker; `~/.codex/auth.json` maps to the mounted Codex auth directory.

Account changes hot-reload. Changes to proxy keys, origins, thresholds, or automatic-reset settings require `teamcodex restart`. Change Docker's host port through `TEAMCODEX_PORT`.

### Reset and migrate an installation

```bash
# Reset installation settings, preserve accounts, and create a backup if config exists
./install.sh --reset
teamcodex serve
```

Or reset an already installed system:

```bash
teamcodex reset
teamcodex serve
```

Reset restores default proxy settings and generates a new proxy key. Existing `run` sessions using the old key need restarting. Backups are named `config.json.backup-<timestamp>-<random>` beside the live config. Malformed JSON is backed up before generating a fresh config; existing valid account lists are retained.

On the first Docker installation, `install.sh` copies an existing native config from `$TEAMCODEX_CONFIG` or `~/.config/teamcodex.json` if the Docker config does not already exist. The old file is retained. The launcher is named `teamcodex.sh` in the checkout so it can coexist with a `teamcodex/` directory created by the older installer. Stop a native proxy or old tmux server before starting Docker on the same port. `TEAMCODEX_CONFIG` is a native file-path override and a migration source; use `TEAMCODEX_CONFIG_DIR` for Docker.

The legacy `install-team-repos.sh` and `run-team-servers.sh` scripts now delegate to this Docker installation and startup. They manage TeamCodex only; existing TeamClaude installations are managed separately.

### Upgrade, backups, and removal

```bash
git pull --ff-only
teamcodex build --pull
teamcodex restart
```

The image uses Node.js 24 and builds for the host architecture; it has no npm runtime dependencies. The container restarts when Docker restarts unless you explicitly stopped it. Enable Docker Desktop at login on macOS or the Docker service at boot on Ubuntu if you want automatic startup.

To restore a backup, stop the proxy, copy the selected backup over `config.json`, ensure mode `600`, and start the proxy. To uninstall, run `teamcodex stop` and remove the launcher symlink. Host config, backups, and Codex credentials remain available until you explicitly remove them.

## How requests work

1. The launcher gives host Codex a custom provider pointing to the local Docker port and supplies `TEAMCODEX_API_KEY` in its environment. It uses the documented [Codex provider settings](https://developers.openai.com/codex/config-reference/) with `env_key`, `requires_openai_auth=false`, and HTTP Responses streaming.
2. The proxy authenticates the client, selects an account, replaces the authorization header, and supplies that account's ChatGPT account ID when known.
3. ChatGPT tokens nearing expiry refresh in the proxy. Config updates use a cross-process lock and atomic rename. A matching file-based host Codex login receives refreshed credentials through its mounted directory.
4. Rate-limit headers update per-account quota tracking. Near the configured threshold, requests prefer a less-used account. The threshold is a preference: a usable account can still serve requests until the backend throttles it.
5. The usage monitor polls all ChatGPT accounts and automatically redeems available earned reset credits at the configured per-account threshold. Every redemption is persisted before the provider request and verified afterward.
6. A 401 triggers refresh or marks the account rejected. A 429 or embedded rate-limit failure throttles the account and rotates immediately. Failed credentials remain unavailable until replaced.
7. SSE streams track usage, including CRLF events and `data:` fields without a space. An embedded 429 can retry another account before any output is sent; after output starts, the connection closes so Codex can retry.
8. If no account is available, the proxy returns 429 with a retry delay. Aggregate and per-account token/traffic statistics are persisted beside the config, with hourly and daily history available in `teamcodex status`.

Use TeamCodex to launch sessions using its accounts. Independently running a native Codex session against the same upstream login can still compete to refresh that login; account listing no longer refreshes tokens.

## Native development and TUI

The Docker launcher is the normal installation. For development, use Node.js 22.13+ on the Node 22 line, or Node.js 24+:

```bash
node src/index.js init
node src/index.js login --browser
node src/index.js serve
# Another terminal:
node src/index.js run --safe
```

Native config defaults to `~/.config/teamcodex.json` or `$XDG_CONFIG_HOME/teamcodex.json`, overridden by `TEAMCODEX_CONFIG`. Native listening defaults to `127.0.0.1`. Native loopback clients are accepted without a proxy key; other connections require the key. Docker always requires it.

A native server attached to a terminal displays the interactive dashboard. Keys: `s` switches accounts, `a` adds an account, `r` removes one, `R` reloads additions/changes/removals, and `q` quits. Use arrows or `j`/`k`, Enter, and Escape in selections. API key paste is supported and input is masked. Docker runs without the TUI; use `status` and `logs`.

Full request/response logging is available with native `serve --log-to DIR`. To enable it in Docker, set `"logDir": "/config/requests"` in config and restart. Request logs may include prompts, model output, and account metadata. Keep them private. Docker's normal service logs rotate at 10 MB, keeping three files.

## Verification

```bash
bun install --frozen-lockfile
bun run check
bash -n teamcodex.sh install.sh install-team-repos.sh run-team-servers.sh

docker build -f test/Dockerfile.ubuntu -t teamcodex-test:ubuntu .
docker run --rm teamcodex-test:ubuntu
```

`bun run check` checks generated errors, strict types, ESLint, Knip, Bun workspace tests,
and the remaining Node tests. Use Bun 1.4.2 for development; the runtime migration
is tracked in [IMPLEMENTATION_CHECKLIST.md](IMPLEMENTATION_CHECKLIST.md).
The proxy depends only on internal workspaces at runtime.

Application errors are centralized in [the error code table](docs/errors.md).
Proxy-generated JSON errors include stable `code` and numeric `opcode` fields.

Run `npm run test:e2e` for the isolated Docker/mock-provider integration suite.
See [Docker E2E coverage and requirements](docs/e2e.md).
Run `npm run test:tui` for interactive mock TUI screenshots; the review gallery is
written to `artifacts/tui/index.html` (Chromium installation is described in the E2E guide).

In the native TUI, press `u` for pool and account usage since proxy startup;
use arrows or `j`/`k` to scroll and `u`/Escape to return. Pool totals aggregate
member accounts; shared accounts appear in each pool.

Account indicators distinguish `active`, `disabled` (configured off), `refreshing`
(token refresh in progress), `throttled`, `exhausted`, and `auth error`. Disabling an
account takes precedence over other display states; the status API exposes its
original state as `underlyingStatus` for diagnosis.

In the TUI add menu (`a`), choose `k` for an API key, `o` for browser OAuth,
`d` for device authorization, or `i` to import Codex credentials. OAuth temporarily
hands the terminal to the login flow and restores the dashboard afterward.
Browser OAuth uses S256 PKCE; device authorization uses the provider-issued verifier
at code exchange. API keys do not use PKCE. Docker login uses device authorization.

Tests cover concurrent config writes, reset backups and permissions, account reload/removal during active requests, token-refresh races, 401/429 rotation, SSE framing, OAuth state checks, automatic usage-reset thresholds and credit availability, persisted cooldowns and idempotent retries, and literal argument handling through the native and Docker launchers. They use fake credentials and local upstream servers. CI runs Node.js 22 and 24 on macOS and Ubuntu, plus the Docker/Ubuntu test image.
Statistics tests cover retry accounting, duplicate stream usage, in-flight disconnect cleanup, restart persistence, UTC bucket retention, damaged history, write recovery, and terminal layout at narrow and wide widths.

Run Python helper tests with `python3 -m unittest discover -s test -p 'test_*.py'`.

## Troubleshooting

- **Docker cannot connect:** start Docker Desktop on Mac; on Ubuntu check `systemctl status docker` and your user's Docker access. Verify `docker info` succeeds as the same user running TeamCodex.
- **Docker works over fresh SSH but fails in tmux:** an old tmux server can retain the groups from before Docker was installed. On Linux the launcher automatically uses `sg docker` to activate your existing Docker group membership for that invocation, preserving the working directory and arguments. This requires your user to already belong to the Docker group; it does not change group membership or use sudo. If `sg` is unavailable, use a fresh login outside the old tmux server or run `newgrp docker` in the affected shell.
- **Resume reports an active writer:** return to the original Codex pane (`tmux list-panes -a` can locate it), quit it before resuming elsewhere, or use `teamcodex fork` for a separate conversation with the same history.
- **Older sessions missing:** update the Docker launcher and use `teamcodex resume`; it includes regular Codex and TeamCodex sessions. Use `--all` if the conversation belongs to a different directory. Check `CODEX_HOME`/`TEAMCODEX_CODEX_HOME` if using a custom history directory.
- **No accounts configured:** run `teamcodex login --device-auth` or `teamcodex import`, then `teamcodex serve`.
- **Port already allocated:** stop the old proxy using that port or set `TEAMCODEX_PORT` consistently for both server and launcher.
- **Config permission denied:** check ownership of `TEAMCODEX_CONFIG_DIR`. Run the installer and launcher as your regular user. Avoid mixing root and regular-user installations.
- **Config is locked:** wait for another command to finish. If a process crashed while writing, stop TeamCodex and all its CLI commands, then remove the empty `config.json.lock` directory next to the config and retry. Config writes themselves remain atomic.
- **Import file not found:** `--from` paths are container paths. Use `/codex/auth.json`, another file inside `/codex`, or `/config/...`.
- **Credential rejected or revoked:** run `teamcodex login --device-auth` again; the server reloads the replacement credentials.
- **Unhealthy container:** inspect `teamcodex logs` and `teamcodex ps`. The health check verifies the local authenticated status endpoint; it does not spend tokens or confirm upstream model access.
- **Automatic resets are not triggering:** check `teamcodex status` for the current usage, available credits, policy, and last result. A new redemption requires the threshold, confirmed credit availability, a known account ID, and an expired one-hour cooldown. Usage checks must succeed. Unknown availability is never treated as an available credit.
- **An old npm command runs or `resume` is unknown:** check `type -a teamcodex`; put `~/.local/bin` before an old global npm bin directory in PATH, then run `rehash` in zsh or `hash -r` in Bash. Existing shells can cache the old path after installation. You can also invoke `~/teamcodex/teamcodex.sh` explicitly.

## License

MIT

Adaptive account routing is available per pool with `"strategy": "adaptive"`; see
[configuration and feedback semantics](docs/routing.md#adaptive-routing).
