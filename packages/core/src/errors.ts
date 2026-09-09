export const ERROR_CODES = Object.freeze({
  HISTORY_INVALID: { opcode: 1013, message: 'invalid_history' },
  STATUS_ARGUMENTS_INVALID: { opcode: 3012, message: 'Usage: teamcodex status [--compact | --json] [--no-color]' },
  STATUS_READ_FAILED: { opcode: 3013, message: 'Cannot read TeamCodex status ({message}). Check teamcodex ps or start with teamcodex serve.' },
  OAUTH_PKCE_INVALID: { opcode: 2019, message: 'OAuth response is missing a valid authorization code or PKCE verifier' },
  DEVICE_RESPONSE_INVALID: { opcode: 2020, message: 'Device authorization response is missing its device ID or user code' },
  PROXY_OVERLOADED: { opcode: 3011, message: 'Proxy concurrency limit reached; retry later', type: 'overloaded_error' },
  ROUTING_CONFIG_INVALID: { opcode: 1012, message: 'Invalid routing configuration: check pools, unique account names, weights (1–1000), enabled flags and thresholds (0–1)' },
  ROUTING_POOL_UNKNOWN: { opcode: 3010, message: 'Unknown routing pool: {name}', type: 'invalid_request_error' },
  CONFIG_INVALID: { opcode: 1001, message: 'Config must be a JSON object' },
  CONFIG_PORT_INVALID: { opcode: 1002, message: 'proxy.port must be an integer from 1 to 65535' },
  CONFIG_KEY_INVALID: { opcode: 1003, message: 'proxy.apiKey must be a nonempty string' },
  CONFIG_HOST_INVALID: { opcode: 1004, message: 'proxy.host must be a nonempty string' },
  CONFIG_ACCOUNTS_INVALID: { opcode: 1005, message: 'accounts must be an array of named chatgpt or apikey accounts' },
  CONFIG_THRESHOLD_INVALID: { opcode: 1006, message: 'switchThreshold must be a number from 0 to 1' },
  CONFIG_RETRY_INVALID: { opcode: 1007, message: 'retry requires maxRetries (0–5) and headerTimeoutSeconds/idleTimeoutSeconds (1–600)' },
  CONFIG_RESET_POLICY_INVALID: { opcode: 1008, message: 'autoReset requires enabled (boolean), threshold (0.01–1), and pollIntervalSeconds (30–3600)' },
  CONFIG_RESET_STATE_INVALID: { opcode: 1009, message: 'usageResetState contains invalid reset tracking data; preserve pending redemption IDs when repairing it' },
  CONFIG_UPSTREAM_INVALID: { opcode: 1010, message: '{key} must be an HTTP(S) URL without credentials' },
  CONFIG_LOCKED: { opcode: 1011, message: 'Config is locked at {lock}. If no TeamCodex command is writing it, remove that lock directory and retry.' },
  ACCESS_TOKEN_MISSING: { opcode: 2001, message: 'no access_token found (is this a ChatGPT-mode auth.json?)' },
  TOKEN_REFRESH_FAILED: { opcode: 2002, message: 'Token refresh failed ({status}): {message}' },
  TOKEN_REFRESH_INVALID: { opcode: 2003, message: 'Token refresh response had no access_token' },
  TOKEN_EXCHANGE_FAILED: { opcode: 2004, message: 'Token exchange failed ({status}): {message}' },
  DEVICE_AUTH_UNAVAILABLE: { opcode: 2005, message: 'device code login is not available (404 from auth server)' },
  DEVICE_CODE_FAILED: { opcode: 2006, message: 'device code request failed ({status})' },
  DEVICE_AUTH_TIMEOUT: { opcode: 2007, message: 'device auth timed out after 15 minutes' },
  DEVICE_AUTH_FAILED: { opcode: 2008, message: 'device auth failed ({status}){message}' },
  OAUTH_STATE_MISMATCH: { opcode: 2009, message: 'OAuth state mismatch' },
  OAUTH_PROVIDER_ERROR: { opcode: 2010, message: 'OAuth error: {error}' },
  OAUTH_CODE_MISSING: { opcode: 2011, message: 'Callback URL is missing an authorization code' },
  OAUTH_CALLBACK_ERROR: { opcode: 2012, message: 'OAuth error: {error} - {description}' },
  OAUTH_PORT_BUSY: { opcode: 2014, message: 'Port {port} is in use (the Codex OAuth client requires it). Close any running "codex login" and try again.' },
  OAUTH_LOGIN_TIMEOUT: { opcode: 2015, message: 'Login timed out after 5 minutes' },
  INVALID_PROXY_KEY: { opcode: 3001, message: 'Invalid proxy API key', type: 'authentication_error' },
  RELOAD_UNSUPPORTED: { opcode: 3002, message: 'Reload not supported by this server', type: 'proxy_error' },
  RELOAD_FAILED: { opcode: 3003, message: '{message}', type: 'proxy_error' },
  REQUEST_TOO_LARGE: { opcode: 3004, message: 'Request exceeds 32 MiB' },
  PROXY_INTERNAL_ERROR: { opcode: 3005, message: 'Internal proxy error', type: 'proxy_error' },
  ACCOUNTS_EXHAUSTED: { opcode: 3006, message: 'All {count} accounts exhausted. Retry in {seconds}s.', type: 'rate_limit_error' },
  ACCOUNTS_RATE_LIMITED: { opcode: 3007, message: 'All {count} accounts rate limited. Retry in {seconds}s.', type: 'rate_limit_error' },
  UPSTREAM_FAILED: { opcode: 3008, message: 'Upstream error: {message}', type: 'proxy_error' },
  UPSTREAM_TIMEOUT: { opcode: 3009, message: 'upstream_timeout' },
  UPSTREAM_RESPONSE_TOO_LARGE: { opcode: 3101, message: 'Upstream response exceeds 32 MiB' },
  SSE_EVENT_TOO_LARGE: { opcode: 3102, message: 'SSE event buffer exceeds 1 MiB' },
  UPSTREAM_STREAM_EMPTY: { opcode: 3103, message: 'Upstream stream terminated before any events' },
  USAGE_ACCOUNT_MISMATCH: { opcode: 4009, message: 'usage_account_mismatch' },
  USAGE_INVALID: { opcode: 4001, message: 'invalid_usage_response' },
  USAGE_HTTP_ERROR: { opcode: 4002, message: 'http_{status}' },
  USAGE_RESPONSE_TOO_LARGE: { opcode: 4003, message: 'response_too_large' },
  USAGE_RESPONSE_INVALID: { opcode: 4004, message: 'invalid_response' },
  ACCOUNT_CHANGED: { opcode: 4005, message: 'account_changed' },
  SMOKE_CONFIG_MISSING: { opcode: 5001, message: 'Initialize TeamCodex before running the smoke test' },
  SMOKE_ACCOUNTS_MISSING: { opcode: 5002, message: 'Rotation smoke test requires at least two accounts' },
  SMOKE_HTTP_ERROR: { opcode: 5003, message: 'Hello request failed: HTTP {status}' },
  SMOKE_RESPONSE_INVALID: { opcode: 5004, message: 'Hello response was incomplete or unexpected' },
  SMOKE_ROTATION_FAILED: { opcode: 5005, message: 'Account rotation was not demonstrated' },
  ARGUMENT_VALUE_MISSING: { opcode: 6001, message: '{argument} requires a value' },
  PROXY_HTTP_ERROR: { opcode: 6002, message: 'HTTP {status}' },
  ACCOUNT_NOT_FOUND: { opcode: 6003, message: 'Account "{name}" not found' },
  UNKNOWN_COMMAND: { opcode: 7001, message: 'Unknown command: {command}\n' },
  NO_ACCOUNTS: { opcode: 7002, message: 'No accounts configured.\n' },
  NO_VALID_ACCOUNTS: { opcode: 7003, message: 'No valid accounts after initialization' },
  PROXY_START_FAILED: { opcode: 7004, message: 'Cannot start proxy: {message}' },
  IMPORT_JSON_TOKEN_MISSING: { opcode: 7005, message: 'JSON must contain "access_token" (directly or under "tokens")' },
  IMPORT_JSON_INVALID: { opcode: 7006, message: 'Failed to parse --json: {message}' },
  IMPORT_FILE_FAILED: { opcode: 7007, message: 'Failed to import from {path}: {message}' },
  DEVICE_LOGIN_FAILED: { opcode: 7008, message: 'Device login failed: {message}' },
  API_KEY_MISSING: { opcode: 7009, message: 'No API key provided' },
  OAUTH_LOGIN_FAILED: { opcode: 7010, message: 'OAuth login failed: {message}' },
  CODEX_NOT_FOUND: { opcode: 7011, message: 'Codex CLI not found in PATH. Install it first: npm install -g @openai/codex' },
  CODEX_START_FAILED: { opcode: 7012, message: 'Failed to start codex: {message}' },
  PROXY_UNREACHABLE: { opcode: 7013, message: 'Cannot connect to proxy at localhost:{port}' },
  NO_ACCOUNTS_CLI: { opcode: 7014, message: 'No accounts configured' },
  ACCOUNT_IMPORT_FAILED: { opcode: 7015, message: 'Failed to import "{name}": {message}' },
  TOKEN_PERSIST_FAILED: { opcode: 7016, message: '[TeamCodex] Failed to persist refreshed tokens: {message}' },
  ACCOUNT_REFRESH_FAILED: { opcode: 7017, message: '[TeamCodex] Token refresh failed for "{name}": {message}' },
  UNHANDLED_ERROR: { opcode: 7018, message: '[TeamCodex] Unhandled error:' },
  REQUEST_LOG_FAILED: { opcode: 7019, message: '[TeamCodex] Failed to write log: {message}' },
  ACCOUNT_UPSTREAM_FAILED: { opcode: 7020, message: '[TeamCodex] Upstream error (account "{name}"):' },
  USAGE_MONITOR_FAILED: { opcode: 7021, message: '[TeamCodex] Usage monitor failed: {message}' },
  USAGE_PENDING_CHECK_FAILED: { opcode: 7022, message: '[TeamCodex] Pending reset check failed: {message}' },
  TUI_REMOVE_FAILED: { opcode: 8001, message: 'Remove failed: {message}' },
  TUI_ADD_FAILED: { opcode: 8002, message: 'Add failed: {message}' },
  TUI_SYNC_FAILED: { opcode: 8003, message: 'Sync failed: {message}' },
  TUI_IMPORT_FAILED: { opcode: 8004, message: 'Import failed: {message}' },
  USAGE_PROVIDER_UNAVAILABLE: { opcode: 4006, message: 'provider_unavailable' },
  USAGE_REFRESH_FAILED: { opcode: 4007, message: 'refresh_failed' },
  USAGE_UNKNOWN_OUTCOME: { opcode: 4008, message: 'unknown_outcome' },
  CREDENTIAL_IMPORT_SKIPPED: { opcode: 7023, message: 'No credentials imported: {message}' },
  RELOAD_NOTIFICATION_FAILED: { opcode: 7024, message: 'Note: could not reload running server ({message}) — restart it or press R in the TUI' },
  OAUTH_CALLBACK_REJECTED_PAGE: { opcode: 2016, message: '<html><body><h2>Authentication failed</h2><p>You can close this tab.</p></body></html>' },
  OAUTH_STATE_REJECTED_PAGE: { opcode: 2017, message: '<html><body><h2>Authentication failed</h2><p>State mismatch. You can close this tab.</p></body></html>' },
  OAUTH_NOT_FOUND: { opcode: 2018, message: 'Not found' },
  DOCKER_REQUIRED: { opcode: 9001, message: 'Docker with the Compose plugin is required. See README.md for macOS and Ubuntu setup.' },
  DOCKER_UNAVAILABLE: { opcode: 9002, message: 'Docker is not running or your user cannot access it. Start Docker and retry.' },
  HOST_CODEX_REQUIRED: { opcode: 9003, message: 'Install Codex CLI on the host before using teamcodex run.' },
  LAUNCH_SETTINGS_INVALID: { opcode: 9004, message: 'Failed to read Codex launch settings.' },
  DOCKER_BROWSER_LOGIN_UNSUPPORTED: { opcode: 9005, message: 'Docker login uses device authorization. Run teamcodex login --device-auth.' },
  INSTALL_ARGUMENT_INVALID: { opcode: 9006, message: 'Usage: ./install.sh [--reset]' },
  INSTALL_PATH_EXISTS: { opcode: 9007, message: 'A file already exists at {path}; use {launcher} directly.' },
  BOOT_USER_INVALID: { opcode: 9010, message: 'Run this installer as the account that owns TeamCodex; it uses sudo for the service definition.' },
  BOOT_COLIMA_REQUIRED: { opcode: 9011, message: 'Unattended macOS boot requires Colima. With Docker Desktop, enable its Start at login setting instead.' },
  BOOT_PLATFORM_UNSUPPORTED: { opcode: 9012, message: 'Supported platforms: Ubuntu Linux and macOS with Colima' },
  BOOT_START_FAILED: { opcode: 9013, message: 'TeamCodex boot startup failed: {message}' },
});
for (const definition of Object.values(ERROR_CODES)) Object.freeze(definition);

export type ErrorCode = keyof typeof ERROR_CODES;
export type ErrorParameters = Readonly<Record<string, string | number>>;
export interface ErrorResponse {
  error: { code: ErrorCode; opcode: number; message: string; type?: string };
}

export function errorMessage(code: ErrorCode, parameters: ErrorParameters = {}): string {
  const definition = ERROR_CODES[code];
  if (!definition) throw new TypeError(`Unknown error code: ${code}`);
  return definition.message.replace(/\{(\w+)\}/g, (_: string, key: string) => {
    if (!Object.hasOwn(parameters, key)) throw new TypeError(`Missing error parameter: ${key}`);
    return String(parameters[key]);
  });
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly opcode: number;
  constructor(code: ErrorCode, parameters: ErrorParameters, options: ErrorOptions) {
    super(errorMessage(code, parameters), options);
    this.name = 'AppError';
    this.code = code;
    this.opcode = ERROR_CODES[code].opcode;
  }
}

export function createError(code: ErrorCode, parameters: ErrorParameters = {}, options: ErrorOptions = {}): AppError {
  return new AppError(code, parameters, options);
}

export function errorResponse(code: ErrorCode, parameters: ErrorParameters = {}): ErrorResponse {
  const message = errorMessage(code, parameters);
  const definition = ERROR_CODES[code];
  return { error: {
    code, opcode: definition.opcode,
    ...('type' in definition ? { type: definition.type } : {}),
    message,
  } };
}
