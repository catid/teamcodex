# TeamCodex

Multi-account Codex proxy with automatic quota-based rotation for [OpenAI Codex CLI](https://developers.openai.com/codex/cli/).

Sits transparently between Codex and the ChatGPT backend, managing multiple ChatGPT (Plus/Pro/Team) accounts and automatically switching when one approaches its 5-hour or weekly usage limit.

## Features

- **Automatic account rotation** — switches to the next account when the 5h or weekly usage window reaches the configured threshold (default 98%)
- **Smart 429 handling** — short rate limits wait and retry the same account; usage-limit 429s switch to the next account immediately
- **Interactive TUI** — real-time dashboard with color-coded quota bars, reset countdowns, activity log, and keyboard controls
- **OAuth token management** — automatically refreshes tokens nearing expiry and persists them to config
- **Hot-reload accounts** — add accounts via `import` or `login` while the server is running, press **R** to pick them up
- **Account deduplication** — detects duplicate accounts by ChatGPT account id and keeps the most recent
- **Request logging** — optional full request/response logging for debugging
- **Zero dependencies** — uses only Node.js built-in modules

## Quick Start

Requires Node.js 18+ and the Codex CLI (`npm install -g @openai/codex`).

```bash
# Install
npm install -g teamcodex

# Add your first account (opens browser for ChatGPT OAuth)
teamcodex login

# Add a second account
teamcodex login

# Start the proxy
teamcodex serve

# In another terminal, run Codex through the proxy
teamcodex run
```

You can also import existing Codex CLI credentials instead of logging in:

```bash
codex login            # Log into an account in Codex
teamcodex import       # Import its credentials
```

## Adding Accounts

### OAuth Login (recommended)

The easiest way to add accounts — opens your browser for authentication:

```bash
teamcodex login
```

Uses the same OAuth flow as the Codex CLI. Auto-detects the account email and plan type (Plus/Pro/Team). Logging in with the same account again updates its credentials.

You can add accounts while the server is running — press **R** in the TUI to reload.

> Note: the OAuth callback uses port 1455 (the only redirect the Codex OAuth client allows), so close any concurrent `codex login` first.

### Import from Codex CLI

If you already have Codex set up, import its credentials directly:

```bash
codex login            # Log into an account in Codex
teamcodex import       # Import its credentials
```

Re-importing the same account updates its credentials. You can also import from a custom path:

```bash
teamcodex import --from /path/to/auth.json
```

### API Key (experimental)

For OpenAI API key accounts (billed via the platform):

```bash
teamcodex login --api
```

When an API key account is active, the proxy rewrites Codex's `/responses` calls to the public `api.openai.com/v1/responses` endpoint. Model availability and request compatibility depend on your API access.

## Usage

### Start the proxy server

```bash
teamcodex serve
```

When running from a TTY, shows an interactive TUI with:
- Account table with 5h/weekly quota progress bars and reset countdowns
- Real-time activity log with request tracking
- Keyboard shortcuts (see below)

Falls back to plain log output when not a TTY (e.g. running as a service).

#### TUI Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `s` | Switch active account |
| `a` | Add account (import or API key) |
| `r` | Remove an account |
| `R` | Reload accounts from config |
| `q` | Quit |

In selection mode, use `j`/`k` or arrow keys to navigate, `Enter` to confirm, `Esc` to cancel.

### Run Codex through the proxy

```bash
teamcodex run
```

`teamcodex run` starts Codex with `--dangerously-bypass-approvals-and-sandbox` (pass `--safe` to skip that). All other arguments pass through to Codex:

```bash
teamcodex run resume            # resume a previous session (picker)
teamcodex run resume --last     # continue the most recent session
teamcodex run "fix the tests"   # start with a prompt
teamcodex run exec "do thing"   # non-interactive exec mode
```

Or apply the config overrides manually:

```bash
codex $(teamcodex env | tr -d '\\')
```

### Other commands

```bash
teamcodex accounts          # List accounts with plan type
teamcodex accounts -v       # Also show token expiry times
teamcodex status            # Show live proxy status (requires running server)
teamcodex remove <name>     # Remove an account
teamcodex api <path>        # Call an API endpoint with account credentials
teamcodex help              # Show all commands
```

### Request logging

Log full request/response details to a directory (one file per request):

```bash
teamcodex serve --log-to /tmp/requests
```

## Configuration

Config is stored at `~/.config/teamcodex.json` (or `$XDG_CONFIG_HOME/teamcodex.json`). A random proxy API key is generated on first use.

Override the config path with `TEAMCODEX_CONFIG`:

```bash
TEAMCODEX_CONFIG=./my-config.json teamcodex serve
```

### Config format

```json
{
  "proxy": {
    "port": 1456,
    "apiKey": "tcx-auto-generated-key"
  },
  "upstream": "https://chatgpt.com",
  "apiUpstream": "https://api.openai.com",
  "switchThreshold": 0.98,
  "accounts": [
    {
      "name": "user@example.com",
      "type": "chatgpt",
      "accountId": "...",
      "planType": "pro",
      "accessToken": "eyJ...",
      "refreshToken": "rt.1...",
      "idToken": "eyJ...",
      "expiresAt": 1781933846000
    }
  ]
}
```

| Field | Description |
|-------|-------------|
| `proxy.port` | Local port the proxy listens on |
| `proxy.apiKey` | API key remote clients use to authenticate with the proxy (localhost is always allowed) |
| `upstream` | ChatGPT backend base URL |
| `apiUpstream` | OpenAI platform API base URL (API key accounts) |
| `switchThreshold` | Quota utilization (0–1) at which to switch accounts |

## How It Works

1. `teamcodex run` starts Codex with a custom model provider pointing at the local proxy (`-c model_providers.teamcodex.base_url=http://127.0.0.1:1456/backend-api/codex -c model_providers.teamcodex.requires_openai_auth=true`), plus `chatgpt_base_url` for auxiliary endpoints
2. The proxy selects the active account and replaces the `Authorization` and `chatgpt-account-id` headers with that account's credentials
3. Tokens expiring within 5 minutes are automatically refreshed against `auth.openai.com` and persisted to config
4. Rate limit headers from the backend (`x-codex-primary-*` = 5h window, `x-codex-secondary-*` = weekly window) track quota utilization per account
5. When usage reaches the threshold, the proxy switches to the next available account via round-robin
6. On 429 responses with a short `retry-after`, the proxy waits and retries the same account; usage-limit 429s mark the account throttled until its reset time and switch immediately
7. Transient network errors (connection reset, timeout) drop the connection so the client can retry
8. If all accounts are exhausted, returns 429 with the soonest reset time
9. Codex manages its own token lifecycle independently (refreshes go directly to `auth.openai.com`); the proxy swaps credentials in-flight, so what Codex stores never matters

## License

MIT
