#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rename,writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';

import { AccountManager } from './account-manager.js';
import { findConfigAccount, resolveAccounts, syncAccountsFromDisk } from './accounts.js';
import { atomicConfigUpdate, getConfigPath, loadConfig, loadOrCreateConfig, resetConfig } from './config.js';
import { createError, errorMessage } from './errors.js';
import {
accountInfoFromTokens,
  defaultCodexAuthPath,
deviceCodeLogin,   importCredentials, loginOAuth, } from './oauth.js';
import { preserveAccountRouting } from './routing.js';
import { createProxyServer } from './server.js';
import { TUI } from './tui.js';
import { UsageResetMonitor } from './usage-reset.js';

const args = process.argv.slice(2);
const command = args[0];

switch (command) {
  case 'smoke': {
    const { smokeCommand } = await import('./smoke.js');
    await smokeCommand(args.slice(1));
    break;
  }
  case 'serve':
  case 'server':
    await serveCommand();
    break;
  case 'init': {
    const config = await loadOrCreateConfig();
    if (config.accounts.length === 0) {
      try {
        const creds = await importCredentials();
        await upsertChatGPTAccount(config, null, creds, 'import');
      } catch (err) {
        console.log(errorMessage('CREDENTIAL_IMPORT_SKIPPED', { message: err.message }));
        console.log('Add an account with: teamcodex login --device-auth');
      }
    }
    break;
  }
  case 'reset': {
    const { backupPath } = await resetConfig();
    console.log(`Reset config at ${getConfigPath()} (accounts preserved)`);
    if (backupPath) console.log(`Backup: ${backupPath}`);
    console.log('Restart any running TeamCodex server to apply the new settings.');
    break;
  }
  case 'run':
    await runCommand();
    break;
  case 'import':
    await importCommand();
    process.exit(0);
    break;
  case 'login':
    await loginCommand();
    process.exit(0);
    break;
  case 'env':
    await envCommand();
    process.exit(0);
    break;
  case 'status':
    await statusCommand();
    process.exit(0);
    break;
  case 'accounts':
    await accountsCommand();
    process.exit(0);
    break;
  case 'remove':
    await removeCommand();
    process.exit(0);
    break;
  case 'api':
    await apiCommand();
    process.exit(0);
    break;
  case 'help':
  case '--help':
  case '-h':
    showHelp();
    break;
  default:
    // No command or unknown command → start server
    if (command && !command.startsWith('-')) {
      console.error(errorMessage('UNKNOWN_COMMAND', { command }));
      showHelp();
      process.exit(1);
    }
    await serveCommand();
    break;
}

// ── serve ───────────────────────────────────────────────────

async function serveCommand() {
  const config = await loadOrCreateConfig();

  // --log-to <dir>
  const logTo = argValue('--log-to');
  if (logTo) config.logDir = logTo;

  if (config.accounts.length === 0) {
    console.error(errorMessage('NO_ACCOUNTS'));
    console.error('Add an account first:');
    console.error('  teamcodex import            Import from Codex CLI');
    console.error('  teamcodex login             OAuth login via browser');
    console.error('  teamcodex login --api       Add an OpenAI API key');
    process.exit(1);
  }

  const accounts = await resolveAccounts(config);
  if (accounts.length === 0) {
    console.error(errorMessage('NO_VALID_ACCOUNTS'));
    process.exit(1);
  }

  config.accounts = accounts;
  const threshold = config.switchThreshold ?? 0.98;
  const accountManager = new AccountManager(accounts, threshold, config.routing);

  // Persist refreshed tokens back to config (re-read from disk to avoid clobbering
  // accounts added externally, e.g. by `teamcodex import` while server is running)
  accountManager.onTokenRefresh(async (idx, newTokens, previousRefreshToken) => {
    const account = accountManager.accounts[idx];
    if (!account) return;
    const memIdx = findConfigAccount(config, account);
    if (memIdx >= 0) Object.assign(config.accounts[memIdx], newTokens);
    let persisted = false;
    await atomicConfigUpdate(diskConfig => {
      const cfgIdx = findConfigAccount(diskConfig, account);
      const diskAccount = diskConfig.accounts[cfgIdx];
      if (diskAccount && (!diskAccount.refreshToken || diskAccount.refreshToken === previousRefreshToken)) {
        Object.assign(diskAccount, newTokens);
        persisted = true;
      }
    });
    if (persisted) await updateCodexAuthIfMatching(account, newTokens);
  });
  const port = Number(process.env.TEAMCODEX_LISTEN_PORT || config.proxy.port);
  const useTUI = process.stdout.isTTY && process.stdin.isTTY;

  // Re-read config from disk and sync accounts into the running server.
  // Reached from the TUI (R key) and the /teamcodex/reload endpoint that
  // `teamcodex login/import/remove` hit after writing the config.
  let reloadPending = Promise.resolve();
  const reloadAccounts = (options = {}) => {
    const next = reloadPending.then(async () => {
      const diskConfig = await loadConfig();
      if (!diskConfig) return { added: 0, updated: 0, removed: 0 };
      return syncAccountsFromDisk(diskConfig, config, accountManager, options);
    });
    reloadPending = next.catch(() => {});
    return next;
  };

  let tui = null;
  const hooks = { reloadAccounts };

  if (useTUI) {
    tui = new TUI({
      accountManager, config,
      saveConfig: ({ upsert, remove }) => atomicConfigUpdate(diskConfig => {
        if (remove) {
          const idx = findConfigAccount(diskConfig, remove);
          if (idx >= 0) {
            const name = diskConfig.accounts[idx].name;
            diskConfig.accounts.splice(idx, 1);
            for (const pool of Object.values(diskConfig.routing?.pools ?? {})) pool.accounts = pool.accounts.filter(member => member !== name);
          }
        }
        if (upsert) {
          const idx = findConfigAccount(diskConfig, upsert);
          if (idx >= 0) {
            preserveAccountRouting(diskConfig, diskConfig.accounts[idx], upsert);
            diskConfig.accounts[idx] = { ...diskConfig.accounts[idx], ...upsert };
          }
          else diskConfig.accounts.push(upsert);
        }
      }),
      syncAccounts: reloadAccounts,
      onQuit: () => shutdown(),
    });
    hooks.onRequestStart = (id, info) => tui.onRequestStart(id, info);
    hooks.onRequestRouted = (id, info) => tui.onRequestRouted(id, info);
    hooks.onRequestEnd = (id, info) => tui.onRequestEnd(id, info);
  }

  const usageMonitor = new UsageResetMonitor(accountManager, config);
  hooks.onAccountsUnavailable = () => usageMonitor.recover();
  const server = createProxyServer(accountManager, config, hooks);
  server.once('close', () => usageMonitor.stop());

  server.on('error', err => {
    if (tui?.running) tui.stop();
    console.error(errorMessage('PROXY_START_FAILED', { message: err.message }));
    process.exitCode = 1;
  });
  server.listen(port, process.env.TEAMCODEX_LISTEN_HOST || config.proxy.host || '127.0.0.1', () => {
    usageMonitor.start();
    if (tui) {
      tui.start();
      console.log(`Listening on port ${port} with ${accounts.length} account(s)`);
    } else {
      const sep = '='.repeat(60);
      console.log('');
      console.log(sep);
      console.log('  TeamCodex Proxy');
      console.log(sep);
      console.log(`  Port:       ${port}`);
      console.log(`  Accounts:   ${accounts.length}`);
      console.log(`  Threshold:  ${(threshold * 100).toFixed(0)}%`);
      console.log(`  Upstream:   ${config.upstream || 'https://chatgpt.com'}`);
      console.log('');
      accounts.forEach((a, i) => {
        console.log(`  [${i + 1}] ${a.name} (${a.type}${a.planType ? `, ${  a.planType}` : ''})`);
      });
      console.log('');
      console.log('  Run Codex through proxy:  teamcodex run');
      console.log('  Show codex overrides:     teamcodex env');
      console.log(sep);
      console.log('');
    }
  });

  function shutdown() {
    usageMonitor.stop();
    if (tui?.running) tui.stop();
    server.close(() => process.exit(0));
    const timer = setTimeout(() => { server.closeAllConnections(); process.exit(0); }, 5000);
    timer.unref();
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// ── import ──────────────────────────────────────────────────

async function importCommand() {
  const config = await loadOrCreateConfig();

  const name = argValue('--name');
  const jsonStr = argValue('--json');

  let creds;
  if (jsonStr) {
    // Accept raw JSON: --json '{"tokens":{"access_token":"...","refresh_token":"...","account_id":"..."}}'
    // or flat: --json '{"access_token":"...","refresh_token":"..."}'
    try {
      const raw = JSON.parse(jsonStr);
      const data = raw.tokens || raw;
      const accessToken = data.access_token || data.accessToken;
      if (!accessToken) {
        console.error(errorMessage('IMPORT_JSON_TOKEN_MISSING'));
        process.exit(1);
      }
      creds = {
        accessToken,
        refreshToken: data.refresh_token || data.refreshToken,
        idToken: data.id_token || data.idToken || null,
        accountId: data.account_id || data.accountId || null,
      };
      const info = accountInfoFromTokens(creds);
      creds.accountId = info.accountId;
      creds.expiresAt = info.expiresAt;
    } catch (err) {
      console.error(errorMessage('IMPORT_JSON_INVALID', { message: err.message }));
      process.exit(1);
    }
  } else {
    const fromPath = argValue('--from');
    try {
      creds = await importCredentials(fromPath);
    } catch (err) {
      console.error(errorMessage('IMPORT_FILE_FAILED', { path: fromPath || defaultCodexAuthPath(), message: err.message }));
      process.exit(1);
    }
  }

  await upsertChatGPTAccount(config, name, creds, 'import');
}

// ── login ───────────────────────────────────────────────────

async function loginCommand() {
  if (args.includes('--api')) {
    await loginApiCommand();
    return;
  }
  if (args.includes('--device-auth') || args.includes('--device')) {
    await loginDeviceCommand();
    return;
  }
  if (args.includes('--browser')) {
    await loginOAuthCommand();
    return;
  }
  // On a headless box the browser flow's localhost:1455 callback is
  // unreachable — steer those users to device-auth automatically.
  const headless = process.platform === 'linux' &&
    !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
  if (headless) {
    console.log('No display detected (headless) — using device-code login.');
    console.log('(Force the browser flow with: teamcodex login --browser)');
    await loginDeviceCommand();
    return;
  }
  await loginOAuthCommand();
}

async function loginDeviceCommand() {
  const config = await loadOrCreateConfig();
  const name = argValue('--name');

  let creds;
  try {
    creds = await deviceCodeLogin({
      onPrompt: ({ verificationUrl, userCode }) => {
        const sep = '─'.repeat(52);
        console.log(`\n${sep}`);
        console.log('  Sign in to ChatGPT with a device code');
        console.log(sep);
        console.log('  1. On any device, open:');
        console.log(`       ${verificationUrl}`);
        console.log('  2. Enter this one-time code (expires in 15 min):');
        console.log(`       ${userCode}`);
        console.log(sep);
        console.log('  Waiting for you to authorize…\n');
      },
    });
  } catch (err) {
    console.error(errorMessage('DEVICE_LOGIN_FAILED', { message: err.message }));
    console.error('');
    console.error('Alternatives:');
    console.error('  teamcodex import         Import from existing Codex CLI credentials');
    console.error('  teamcodex login --api    Add an OpenAI API key instead');
    process.exit(1);
  }

  await upsertChatGPTAccount(config, name, creds, 'device');
}

async function loginApiCommand() {
  await loadOrCreateConfig();
  let name = argValue('--name');

  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const apiKey = await new Promise(resolve => rl.question('OpenAI API key: ', resolve));
  rl.close();

  if (!apiKey.trim()) {
    console.error(errorMessage('API_KEY_MISSING'));
    process.exit(1);
  }

  const saved = await atomicConfigUpdate(diskConfig => {
    if (!name) {
      let n = 1;
      while (diskConfig.accounts.some(a => a.name === `api-${n}`)) n++;
      name = `api-${n}`;
    }
    const entry = { name, type: 'apikey', apiKey: apiKey.trim() };
    const idx = diskConfig.accounts.findIndex(a => a.name === name);
    if (idx >= 0) {
      preserveAccountRouting(diskConfig, diskConfig.accounts[idx], entry);
      diskConfig.accounts[idx] = entry;
    }
    else diskConfig.accounts.push(entry);
  });
  console.log(`Added API key account "${name}"`);
  console.log(`Saved to ${getConfigPath()}`);
  await notifyServerReload(saved);
}

async function loginOAuthCommand() {
  const config = await loadOrCreateConfig();
  const name = argValue('--name');

  console.log('Starting OAuth login...');
  let creds;
  try {
    creds = await loginOAuth();
  } catch (err) {
    console.error(errorMessage('OAUTH_LOGIN_FAILED', { message: err.message }));
    console.error('');
    console.error('Alternatives:');
    console.error('  teamcodex login --device-auth   Headless / no local browser');
    console.error('  teamcodex import                Import from existing Codex CLI credentials');
    console.error('  teamcodex login --api           Add an OpenAI API key instead');
    process.exit(1);
  }

  await upsertChatGPTAccount(config, name, creds, 'login');
}

// ── env ─────────────────────────────────────────────────────

async function envCommand() {
  const config = await loadOrCreateConfig();
  const overrides = codexOverrideArgs(config);
  if (args.includes('--null')) {
    process.stdout.write(`${[config.proxy.apiKey, ...overrides].join('\0')  }\0`);
    return;
  }
  const quote = value => `'${  value.replaceAll("'", "'\\''")  }'`;
  console.log(`TEAMCODEX_API_KEY=${quote(config.proxy.apiKey)} codex ${overrides.map(quote).join(' ')}`);
}

// ── run ─────────────────────────────────────────────────────

function codexOverrideArgs(config) {
  const port = process.env.TEAMCODEX_PORT || config.proxy.port;
  return [
    '-c', 'model_provider=teamcodex',
    '-c', 'model_providers.teamcodex.name=TeamCodex',
    '-c', `model_providers.teamcodex.base_url=http://127.0.0.1:${port}/backend-api/codex`,
    '-c', 'model_providers.teamcodex.wire_api=responses',
    '-c', 'model_providers.teamcodex.requires_openai_auth=false',
    '-c', 'model_providers.teamcodex.env_key=TEAMCODEX_API_KEY',
    '-c', 'model_providers.teamcodex.supports_websockets=false',
  ];
}

/**
 * Atomically write codex's auth.json — codex reloads this file at runtime,
 * so it must never observe a partially written one.
 */
async function writeCodexAuth(authPath, auth) {
  await mkdir(dirname(authPath), { recursive: true });
  const tmpPath = `${authPath}.${process.pid}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(auth, null, 2)  }\n`, { mode: 0o600 });
  await rename(tmpPath, authPath);
}

/**
 * Mirror freshly refreshed tokens into the Codex CLI's auth.json when it
 * holds tokens for the same account. Codex reloads auth.json before
 * refreshing (guarded reload) and skips its own refresh when the file has
 * newer tokens — without this, codex eventually tries to refresh a rotated
 * refresh token and dies with "refresh token was revoked".
 */
async function updateCodexAuthIfMatching(account, newTokens) {
  const authPath = defaultCodexAuthPath();
  let auth;
  try {
    auth = JSON.parse(await readFile(authPath, 'utf-8'));
  } catch {
    return; // no codex auth.json (or unreadable) — nothing to sync
  }

  const tokens = auth.tokens || {};
  const authInfo = accountInfoFromTokens({
    accessToken: tokens.access_token,
    idToken: tokens.id_token,
    accountId: tokens.account_id,
  });
  const acctId = account.accountId
    || accountInfoFromTokens({ accessToken: newTokens.accessToken, idToken: newTokens.idToken }).accountId;
  if (!acctId || authInfo.accountId !== acctId) return;

  await writeCodexAuth(authPath, {
    ...auth,
    tokens: {
      ...tokens,
      id_token: newTokens.idToken ?? tokens.id_token,
      access_token: newTokens.accessToken,
      refresh_token: newTokens.refreshToken,
      account_id: acctId,
    },
    last_refresh: new Date().toISOString(),
  });
  console.log(`[TeamCodex] Synced refreshed tokens to codex auth.json ("${account.name}")`);
}

async function runCommand() {
  const config = await loadOrCreateConfig();

  // Everything after 'run' (skip -- separator if present)
  const codexArgs = args.slice(1);
  if (codexArgs[0] === '--') codexArgs.shift();

  // --safe: don't add the bypass flag
  let bypass = true;
  const safeIdx = codexArgs.indexOf('--safe');
  if (safeIdx >= 0) { bypass = false; codexArgs.splice(safeIdx, 1); }

  const settings = [];
  for (let i = 0; i < codexArgs.length && codexArgs[i] !== '--';) {
    if (['-c', '--config'].includes(codexArgs[i])) {
      if (i + 1 >= codexArgs.length) throw createError('ARGUMENT_VALUE_MISSING', { argument: codexArgs[i] });
      settings.push(...codexArgs.splice(i, 2));
    } else if (/^(--config|-c)=/.test(codexArgs[i])) settings.push(...codexArgs.splice(i, 1));
    else i++;
  }
  settings.push(...codexOverrideArgs(config));
  if (bypass) settings.push('--dangerously-bypass-approvals-and-sandbox');
  const delimiter = codexArgs.indexOf('--');
  const fullArgs = [...codexArgs];
  fullArgs.splice(delimiter < 0 ? fullArgs.length : delimiter, 0, ...settings);

  // Authenticate to the proxy with its own key; only the proxy refreshes
  // upstream account credentials for this session.
  // Use spawnSync so the Node process blocks entirely — behaves like execvp.
  const result = spawnSync('codex', fullArgs, {
    stdio: 'inherit', env: { ...process.env, TEAMCODEX_API_KEY: config.proxy.apiKey },
  });

  if (result.error) {
    if (result.error.code === 'ENOENT') {
      console.error(errorMessage('CODEX_NOT_FOUND'));
    } else {
      console.error(errorMessage('CODEX_START_FAILED', { message: result.error.message }));
    }
    process.exit(1);
  }

  process.exit(result.status ?? 1);
}

// ── status ──────────────────────────────────────────────────

async function statusCommand() {
  const config = await loadOrCreateConfig();
  const base = process.env.TEAMCODEX_SERVER_URL || `http://127.0.0.1:${config.proxy.port}`;
  const url = `${base}/teamcodex/status`;

  try {
    const res = await fetch(url, { headers: { 'x-api-key': config.proxy.apiKey }, signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw createError('PROXY_HTTP_ERROR', { status: res.status });
    const data = await res.json();

    console.log(`Active account: ${data.currentAccount}`);
    console.log(`Switch at:      ${(data.switchThreshold * 100).toFixed(0)}% usage\n`);
    if (data.autoReset) {
      console.log(`Auto reset:     ${data.autoReset.enabled ? `enabled at ${(data.autoReset.threshold * 100).toFixed(0)}%` : 'disabled'}; checks every ${data.autoReset.pollIntervalSeconds}s\n`);
    }

    for (const acct of data.accounts) {
      const q = acct.quota;
      const current = acct.name === data.currentAccount ? ' *' : '';
      const plan = acct.planType ? `, ${acct.planType}` : '';

      console.log(`  ${acct.name} (${acct.type}${plan})${current}`);
      console.log(`    Status:   ${acct.status}`);
      if (acct.type === 'chatgpt' && acct.usageReset) {
        const reset = acct.usageReset;
        console.log(`    Resets:   ${reset.availableCredits ?? 'unknown'} credit(s) available${reset.lastResult ? `; last attempt: ${reset.lastResult}` : ''}`);
        if (reset.pending) console.log('              Pending redemption retained for a safe retry');
        if (reset.checkError) console.log(`              Usage check unavailable: ${reset.checkError}`);
      }

      if (q.primary != null || q.secondary != null) {
        const p = q.primary != null ? `${(q.primary * 100).toFixed(1)  }%` : '-';
        const s = q.secondary != null ? `${(q.secondary * 100).toFixed(1)  }%` : '-';
        console.log(`    5h:       ${p} used    Weekly: ${s} used`);
      } else {
        const tok = q.tokensLimit ? `${((1 - q.tokensRemaining / q.tokensLimit) * 100).toFixed(1)  }%` : '-';
        const req = q.requestsLimit ? `${((1 - q.requestsRemaining / q.requestsLimit) * 100).toFixed(1)  }%` : '-';
        console.log(`    Tokens:   ${tok} used    Requests: ${req} used`);
      }

      console.log(`    Total:    ${acct.usage.totalInputTokens + acct.usage.totalOutputTokens} tokens, ${acct.usage.totalRequests} requests`);
      if (acct.rateLimitedUntil) console.log(`    Throttled until: ${acct.rateLimitedUntil}`);
      console.log('');
    }
  } catch {
    console.error(errorMessage('PROXY_UNREACHABLE', { port: config.proxy.port }));
    console.error('Is the server running? Start with: teamcodex serve');
    process.exit(1);
  }
}

// ── accounts ────────────────────────────────────────────────

async function accountsCommand() {
  const config = await loadOrCreateConfig();
  const verbose = args.includes('-v') || args.includes('--verbose');

  if (config.accounts.length === 0) {
    console.log('No accounts configured.');
    console.log('Add one with: teamcodex import, teamcodex login, or teamcodex login --api');
    return;
  }

  for (const [i, a] of config.accounts.entries()) {
    if (a.type === 'apikey') {
      console.log(`  [${i + 1}] ${a.name} (apikey)  [configured]`);
      continue;
    }

    const info = accountInfoFromTokens({ accessToken: a.accessToken, idToken: a.idToken, accountId: a.accountId });
    const plan = info.planType ? `ChatGPT ${info.planType}` : 'chatgpt';
    const src = a.source ? `, ${a.source}` : '';
    console.log(`  [${i + 1}] ${a.name} (${plan}${src})`);
    if (info.email && info.email !== a.name) console.log(`       Email: ${info.email}`);
    if (verbose && a.expiresAt) {
      const remaining = a.expiresAt - Date.now();
      if (remaining <= 0) {
        console.log(`       Token: expired`);
      } else {
        const mins = Math.floor(remaining / 60000);
        const hrs = Math.floor(mins / 60);
        const days = Math.floor(hrs / 24);
        const expiry = days > 0 ? `${days}d ${hrs % 24}h` : hrs > 0 ? `${hrs}h ${mins % 60}m` : `${mins}m`;
        console.log(`       Token: expires in ${expiry}`);
      }
    }
  }
}

// ── api ─────────────────────────────────────────────────────

async function apiCommand() {
  const config = await loadOrCreateConfig();
  const path = args[1];

  if (!path) {
    console.error('Usage: teamcodex api <path> [--account NAME] [--method POST] [--data JSON]');
    console.error('Example: teamcodex api /backend-api/wham/usage');
    process.exit(1);
  }

  // Find account to use
  const accountName = argValue('--account');
  const method = (argValue('--method') || 'GET').toUpperCase();
  const data = argValue('--data');

  const accounts = await resolveAccounts(config);
  let account;
  if (accountName) {
    account = accounts.find(a => a.name === accountName);
    if (!account) { console.error(errorMessage('ACCOUNT_NOT_FOUND', { name: accountName })); process.exit(1); }
  } else {
    account = accounts.find(a => a.type === 'chatgpt') || accounts[0];
    if (!account) { console.error(errorMessage('NO_ACCOUNTS_CLI')); process.exit(1); }
  }

  const credential = account.accessToken || account.apiKey;
  const upstream = account.type === 'chatgpt'
    ? (config.upstream || 'https://chatgpt.com')
    : (config.apiUpstream || 'https://api.openai.com');
  const url = path.startsWith('http') ? path : `${upstream}${path}`;

  const headers = { 'Authorization': `Bearer ${credential}` };
  if (account.type === 'chatgpt' && account.accountId) {
    headers['chatgpt-account-id'] = account.accountId;
  }

  const fetchOpts = { method, headers };
  if (data) {
    headers['Content-Type'] = 'application/json';
    fetchOpts.body = data;
  }

  const res = await fetch(url, fetchOpts);

  // Print response headers to stderr
  console.error(`${res.status} ${res.statusText}`);
  for (const [k, v] of res.headers.entries()) {
    console.error(`  ${k}: ${v}`);
  }
  console.error('');

  // Print body to stdout
  const body = await res.text();
  try {
    console.log(JSON.stringify(JSON.parse(body), null, 2));
  } catch {
    console.log(body);
  }
}

// ── remove ──────────────────────────────────────────────────

async function removeCommand() {
  await loadOrCreateConfig();
  const name = args[1];

  if (!name) {
    console.error('Usage: teamcodex remove <account-name>');
    process.exit(1);
  }

  const saved = await atomicConfigUpdate(diskConfig => {
    const idx = diskConfig.accounts.findIndex(a => a.name === name);
    if (idx < 0) throw createError('ACCOUNT_NOT_FOUND', { name });
    diskConfig.accounts.splice(idx, 1);
    for (const pool of Object.values(diskConfig.routing?.pools ?? {})) pool.accounts = pool.accounts.filter(member => member !== name);
  });
  console.log(`Removed account "${name}"`);
  await notifyServerReload(saved, { removeMissing: true });
}

// ── help ────────────────────────────────────────────────────

function showHelp() {
  console.log(`TeamCodex - Multi-account Codex proxy

Usage: teamcodex [command] [options]

Commands:
  serve               Start the proxy server (default)
  import              Import credentials from Codex CLI (~/.codex/auth.json)
  login               ChatGPT OAuth login (browser; auto device-code if headless)
  login --device-auth Device-code login (headless servers, no local browser)
  login --browser     Force the browser/localhost-callback flow
  login --api         Add an OpenAI API key account
  env                 Print a shell command for Codex (includes the proxy key)
  run [args...]       Run Codex through the proxy; args pass through to codex
                      (e.g. "teamcodex run resume", "teamcodex run <prompt>")
  smoke [--rotate]    Test a live hello; --rotate injects 429 in an isolated proxy
  status              Show proxy & account status (live)
  init                Create config and import existing Codex login if empty
  reset               Reset settings and proxy key; back up config, keep accounts
  accounts            List configured accounts
  remove <name>       Remove an account
  api <path>          Call an API endpoint with account credentials
  help                Show this help

Options:
  --name NAME         Set account name (import/login)
  --from PATH         Credentials path (import, default: ~/.codex/auth.json)
  --json JSON         Import from inline JSON (import), e.g.:
                      --json '{"tokens":{"access_token":"...","refresh_token":"..."}}'
  --safe              Don't pass --dangerously-bypass-approvals-and-sandbox (run)
  --log-to DIR        Log full requests/responses to DIR (serve, one file per request)

Config: ${getConfigPath()}
`);
}

// ── shared account upsert ────────────────────────────────────

async function upsertChatGPTAccount(_config, name, creds, source = 'unknown') {
  const info = accountInfoFromTokens(creds);

  if (!name && info.email) {
    name = info.email;
    if (info.planType) console.log(`Detected ChatGPT ${info.planType} account: ${info.email}`);
  }
  const account = {
    name,
    type: 'chatgpt',
    source,
    accountId: info.accountId,
    planType: info.planType,
    accessToken: creds.accessToken,
    refreshToken: creds.refreshToken,
    idToken: creds.idToken,
    expiresAt: creds.expiresAt,
  };

  let updated = false;
  const saved = await atomicConfigUpdate(diskConfig => {
    if (!account.name) {
      let n = 1;
      while (diskConfig.accounts.some(a => a.name === `account-${n}`)) n++;
      account.name = `account-${n}`;
    }
    const idx = findConfigAccount(diskConfig, account);
    if (idx >= 0) {
      preserveAccountRouting(diskConfig, diskConfig.accounts[idx], account);
      diskConfig.accounts[idx] = account;
      updated = true;
    }
    else diskConfig.accounts.push(account);
  });
  console.log(`${updated ? 'Updated' : 'Added'} account "${account.name}"`);
  console.log(`Saved to ${getConfigPath()}`);
  await notifyServerReload(saved);
}

/**
 * Tell a running proxy server to reload accounts from the config file, so
 * logins/imports/removals take effect immediately without a restart.
 * Best-effort: silently a no-op when the server isn't running.
 */
async function notifyServerReload(config, { removeMissing = false } = {}) {
  const port = config.proxy?.port;
  if (!port) return;

  const qs = removeMissing ? '?removeMissing=1' : '';
  const headers = config.proxy?.apiKey ? { 'x-api-key': config.proxy.apiKey } : {};
  try {
    const res = await fetch(`${process.env.TEAMCODEX_SERVER_URL || `http://127.0.0.1:${port}`}/teamcodex/reload${qs}`, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw createError('PROXY_HTTP_ERROR', { status: res.status });
    const data = await res.json();
    const parts = [];
    if (data.added) parts.push(`${data.added} added`);
    if (data.updated) parts.push(`${data.updated} updated`);
    if (data.removed) parts.push(`${data.removed} removed`);
    console.log(`Running server reloaded${parts.length ? ` (${parts.join(', ')})` : ' (no changes)'}`);
  } catch (err) {
    const code = err.code || err.cause?.code;
    if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN') return; // server not running — it'll load the config on start
    console.log(errorMessage('RELOAD_NOTIFICATION_FAILED', { message: err.message }));
  }
}

function argValue(flag) {
  const i = args.indexOf(flag);
  return (i >= 0 && args[i + 1]) ? args[i + 1] : null;
}
