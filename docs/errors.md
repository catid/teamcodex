# Error codes

Generated from [packages/core/src/errors.ts](../packages/core/src/errors.ts) by `bun run errors:generate`.
Edit the registry, then regenerate this table and the shell/Python message adapters.
`bun run errors:check` detects stale generated files.

Codes and numeric opcodes are stable application identifiers, not HTTP statuses or
CPU instructions. Never renumber or reuse them. Groups: 1000 config, 2000 OAuth,
3000 proxy, 4000 usage resets, 5000 smoke, 6000 CLI errors, 7000 diagnostics,
8000 TUI, 9000 installation/boot.

Use `createError(code, parameters, { cause })` for thrown errors,
`errorMessage(code, parameters)` for diagnostics, and `errorResponse` for proxy JSON.
Thrown errors expose `code` and `opcode`; proxy-generated JSON adds both fields
while retaining existing messages/types and HTTP statuses. CLI/TUI/host messages
keep their existing text. Do not expose credentials in message parameters.

Native errors retain their original codes and causes. Provider responses, retry
status codes, and persisted reset outcomes keep their existing contracts. Successful
lifecycle messages and command-help text are not error definitions. Healthcheck
failures retain the container's exit-status-only interface. Registry misuse throws
native TypeError to avoid recursively calling a broken registry.

| Opcode | Code | Message template |
| --- | --- | --- |
| 1001 | `CONFIG_INVALID` | Config must be a JSON object |
| 1002 | `CONFIG_PORT_INVALID` | proxy.port must be an integer from 1 to 65535 |
| 1003 | `CONFIG_KEY_INVALID` | proxy.apiKey must be a nonempty string |
| 1004 | `CONFIG_HOST_INVALID` | proxy.host must be a nonempty string |
| 1005 | `CONFIG_ACCOUNTS_INVALID` | accounts must be an array of named chatgpt or apikey accounts |
| 1006 | `CONFIG_THRESHOLD_INVALID` | switchThreshold must be a number from 0 to 1 |
| 1007 | `CONFIG_RETRY_INVALID` | retry requires maxRetries (0–5) and headerTimeoutSeconds/idleTimeoutSeconds (1–600) |
| 1008 | `CONFIG_RESET_POLICY_INVALID` | autoReset requires enabled (boolean), threshold (0.01–1), and pollIntervalSeconds (30–3600) |
| 1009 | `CONFIG_RESET_STATE_INVALID` | usageResetState contains invalid reset tracking data; preserve pending redemption IDs when repairing it |
| 1010 | `CONFIG_UPSTREAM_INVALID` | {key} must be an HTTP(S) URL without credentials |
| 1011 | `CONFIG_LOCKED` | Config is locked at {lock}. If no TeamCodex command is writing it, remove that lock directory and retry. |
| 1012 | `ROUTING_CONFIG_INVALID` | Invalid routing configuration: check pools, unique account names, weights (1–1000), enabled flags and thresholds (0–1) |
| 1013 | `HISTORY_INVALID` | invalid_history |
| 2001 | `ACCESS_TOKEN_MISSING` | no access_token found (is this a ChatGPT-mode auth.json?) |
| 2002 | `TOKEN_REFRESH_FAILED` | Token refresh failed ({status}): {message} |
| 2003 | `TOKEN_REFRESH_INVALID` | Token refresh response had no access_token |
| 2004 | `TOKEN_EXCHANGE_FAILED` | Token exchange failed ({status}): {message} |
| 2005 | `DEVICE_AUTH_UNAVAILABLE` | device code login is not available (404 from auth server) |
| 2006 | `DEVICE_CODE_FAILED` | device code request failed ({status}) |
| 2007 | `DEVICE_AUTH_TIMEOUT` | device auth timed out after 15 minutes |
| 2008 | `DEVICE_AUTH_FAILED` | device auth failed ({status}){message} |
| 2009 | `OAUTH_STATE_MISMATCH` | OAuth state mismatch |
| 2010 | `OAUTH_PROVIDER_ERROR` | OAuth error: {error} |
| 2011 | `OAUTH_CODE_MISSING` | Callback URL is missing an authorization code |
| 2012 | `OAUTH_CALLBACK_ERROR` | OAuth error: {error} - {description} |
| 2014 | `OAUTH_PORT_BUSY` | Port {port} is in use (the Codex OAuth client requires it). Close any running "codex login" and try again. |
| 2015 | `OAUTH_LOGIN_TIMEOUT` | Login timed out after 5 minutes |
| 2016 | `OAUTH_CALLBACK_REJECTED_PAGE` | &lt;html&gt;&lt;body>&lt;h2>Authentication failed&lt;/h2>&lt;p>You can close this tab.&lt;/p>&lt;/body>&lt;/html> |
| 2017 | `OAUTH_STATE_REJECTED_PAGE` | &lt;html&gt;&lt;body>&lt;h2>Authentication failed&lt;/h2>&lt;p>State mismatch. You can close this tab.&lt;/p>&lt;/body>&lt;/html> |
| 2018 | `OAUTH_NOT_FOUND` | Not found |
| 2019 | `OAUTH_PKCE_INVALID` | OAuth response is missing a valid authorization code or PKCE verifier |
| 2020 | `DEVICE_RESPONSE_INVALID` | Device authorization response is missing its device ID or user code |
| 3001 | `INVALID_PROXY_KEY` | Invalid proxy API key |
| 3002 | `RELOAD_UNSUPPORTED` | Reload not supported by this server |
| 3003 | `RELOAD_FAILED` | {message} |
| 3004 | `REQUEST_TOO_LARGE` | Request exceeds 32 MiB |
| 3005 | `PROXY_INTERNAL_ERROR` | Internal proxy error |
| 3006 | `ACCOUNTS_EXHAUSTED` | All {count} accounts exhausted. Retry in {seconds}s. |
| 3007 | `ACCOUNTS_RATE_LIMITED` | All {count} accounts rate limited. Retry in {seconds}s. |
| 3008 | `UPSTREAM_FAILED` | Upstream error: {message} |
| 3009 | `UPSTREAM_TIMEOUT` | upstream_timeout |
| 3010 | `ROUTING_POOL_UNKNOWN` | Unknown routing pool: {name} |
| 3011 | `PROXY_OVERLOADED` | Proxy concurrency limit reached; retry later |
| 3012 | `STATUS_ARGUMENTS_INVALID` | Usage: teamcodex status [--compact \| --json] [--no-color] |
| 3013 | `STATUS_READ_FAILED` | Cannot read TeamCodex status ({message}). Check teamcodex ps or start with teamcodex serve. |
| 3101 | `UPSTREAM_RESPONSE_TOO_LARGE` | Upstream response exceeds 32 MiB |
| 3102 | `SSE_EVENT_TOO_LARGE` | SSE event buffer exceeds 1 MiB |
| 3103 | `UPSTREAM_STREAM_EMPTY` | Upstream stream terminated before any events |
| 4001 | `USAGE_INVALID` | invalid_usage_response |
| 4002 | `USAGE_HTTP_ERROR` | http_{status} |
| 4003 | `USAGE_RESPONSE_TOO_LARGE` | response_too_large |
| 4004 | `USAGE_RESPONSE_INVALID` | invalid_response |
| 4005 | `ACCOUNT_CHANGED` | account_changed |
| 4006 | `USAGE_PROVIDER_UNAVAILABLE` | provider_unavailable |
| 4007 | `USAGE_REFRESH_FAILED` | refresh_failed |
| 4008 | `USAGE_UNKNOWN_OUTCOME` | unknown_outcome |
| 4009 | `USAGE_ACCOUNT_MISMATCH` | usage_account_mismatch |
| 5001 | `SMOKE_CONFIG_MISSING` | Initialize TeamCodex before running the smoke test |
| 5002 | `SMOKE_ACCOUNTS_MISSING` | Rotation smoke test requires at least two accounts |
| 5003 | `SMOKE_HTTP_ERROR` | Hello request failed: HTTP {status} |
| 5004 | `SMOKE_RESPONSE_INVALID` | Hello response was incomplete or unexpected |
| 5005 | `SMOKE_ROTATION_FAILED` | Account rotation was not demonstrated |
| 6001 | `ARGUMENT_VALUE_MISSING` | {argument} requires a value |
| 6002 | `PROXY_HTTP_ERROR` | HTTP {status} |
| 6003 | `ACCOUNT_NOT_FOUND` | Account "{name}" not found |
| 7001 | `UNKNOWN_COMMAND` | Unknown command: {command}&lt;br> |
| 7002 | `NO_ACCOUNTS` | No accounts configured.&lt;br> |
| 7003 | `NO_VALID_ACCOUNTS` | No valid accounts after initialization |
| 7004 | `PROXY_START_FAILED` | Cannot start proxy: {message} |
| 7005 | `IMPORT_JSON_TOKEN_MISSING` | JSON must contain "access_token" (directly or under "tokens") |
| 7006 | `IMPORT_JSON_INVALID` | Failed to parse --json: {message} |
| 7007 | `IMPORT_FILE_FAILED` | Failed to import from {path}: {message} |
| 7008 | `DEVICE_LOGIN_FAILED` | Device login failed: {message} |
| 7009 | `API_KEY_MISSING` | No API key provided |
| 7010 | `OAUTH_LOGIN_FAILED` | OAuth login failed: {message} |
| 7011 | `CODEX_NOT_FOUND` | Codex CLI not found in PATH. Install it first: npm install -g @openai/codex |
| 7012 | `CODEX_START_FAILED` | Failed to start codex: {message} |
| 7013 | `PROXY_UNREACHABLE` | Cannot connect to proxy at localhost:{port} |
| 7014 | `NO_ACCOUNTS_CLI` | No accounts configured |
| 7015 | `ACCOUNT_IMPORT_FAILED` | Failed to import "{name}": {message} |
| 7016 | `TOKEN_PERSIST_FAILED` | [TeamCodex] Failed to persist refreshed tokens: {message} |
| 7017 | `ACCOUNT_REFRESH_FAILED` | [TeamCodex] Token refresh failed for "{name}": {message} |
| 7018 | `UNHANDLED_ERROR` | [TeamCodex] Unhandled error: |
| 7019 | `REQUEST_LOG_FAILED` | [TeamCodex] Failed to write log: {message} |
| 7020 | `ACCOUNT_UPSTREAM_FAILED` | [TeamCodex] Upstream error (account "{name}"): |
| 7021 | `USAGE_MONITOR_FAILED` | [TeamCodex] Usage monitor failed: {message} |
| 7022 | `USAGE_PENDING_CHECK_FAILED` | [TeamCodex] Pending reset check failed: {message} |
| 7023 | `CREDENTIAL_IMPORT_SKIPPED` | No credentials imported: {message} |
| 7024 | `RELOAD_NOTIFICATION_FAILED` | Note: could not reload running server ({message}) — restart it or press R in the TUI |
| 8001 | `TUI_REMOVE_FAILED` | Remove failed: {message} |
| 8002 | `TUI_ADD_FAILED` | Add failed: {message} |
| 8003 | `TUI_SYNC_FAILED` | Sync failed: {message} |
| 8004 | `TUI_IMPORT_FAILED` | Import failed: {message} |
| 9001 | `DOCKER_REQUIRED` | Docker with the Compose plugin is required. See README.md for macOS and Ubuntu setup. |
| 9002 | `DOCKER_UNAVAILABLE` | Docker is not running or your user cannot access it. Start Docker and retry. |
| 9003 | `HOST_CODEX_REQUIRED` | Install Codex CLI on the host before using teamcodex run. |
| 9004 | `LAUNCH_SETTINGS_INVALID` | Failed to read Codex launch settings. |
| 9005 | `DOCKER_BROWSER_LOGIN_UNSUPPORTED` | Docker login uses device authorization. Run teamcodex login --device-auth. |
| 9006 | `INSTALL_ARGUMENT_INVALID` | Usage: ./install.sh [--reset] |
| 9007 | `INSTALL_PATH_EXISTS` | A file already exists at {path}; use {launcher} directly. |
| 9010 | `BOOT_USER_INVALID` | Run this installer as the account that owns TeamCodex; it uses sudo for the service definition. |
| 9011 | `BOOT_COLIMA_REQUIRED` | Unattended macOS boot requires Colima. With Docker Desktop, enable its Start at login setting instead. |
| 9012 | `BOOT_PLATFORM_UNSUPPORTED` | Supported platforms: Ubuntu Linux and macOS with Colima |
| 9013 | `BOOT_START_FAILED` | TeamCodex boot startup failed: {message} |
