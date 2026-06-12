#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { loadOrCreateConfig, loadConfig, saveConfig, atomicConfigUpdate, getConfigPath } from './config.js';
import { AccountManager } from './account-manager.js';
import { createProxyServer } from './server.js';
import {
  importCredentials, loginOAuth, accountInfoFromTokens,
  refreshAccessToken, isTokenExpiringSoon, defaultCodexAuthPath,
} from './oauth.js';
import { TUI } from './tui.js';

const args = process.argv.slice(2);
const command = args[0];

switch (command) {
  case 'serve':
  case 'server':
    await serveCommand();
    break;
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
      console.error(`Unknown command: ${command}\n`);
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
    console.error('No accounts configured.\n');
    console.error('Add an account first:');
    console.error('  teamcodex import            Import from Codex CLI');
    console.error('  teamcodex login             OAuth login via browser');
    console.error('  teamcodex login --api       Add an OpenAI API key');
    process.exit(1);
  }

  const accounts = await resolveAccounts(config);
  if (accounts.length === 0) {
    console.error('No valid accounts after initialization');
    process.exit(1);
  }

  const threshold = config.switchThreshold || 0.98;
  const accountManager = new AccountManager(accounts, threshold);

  // Persist refreshed tokens back to config (re-read from disk to avoid clobbering
  // accounts added externally, e.g. by `teamcodex import` while server is running)
  accountManager.onTokenRefresh((idx, newTokens) => {
    const account = accountManager.accounts[idx];
    if (!account) return;
    // Keep config.accounts in sync so TUI saveConfig doesn't clobber fresh tokens
    if (config.accounts[idx]) {
      config.accounts[idx].accessToken = newTokens.accessToken;
      config.accounts[idx].refreshToken = newTokens.refreshToken;
      if (newTokens.idToken) config.accounts[idx].idToken = newTokens.idToken;
      config.accounts[idx].expiresAt = newTokens.expiresAt;
    }
    atomicConfigUpdate(diskConfig => {
      // Pick up any new accounts from disk so index matching stays correct
      // (only add, don't refresh credentials — we're about to write the authoritative tokens)
      for (const diskAcct of diskConfig.accounts) {
        const known = (diskAcct.accountId && config.accounts.some(a => a.accountId === diskAcct.accountId))
          || config.accounts.some(a => a.name === diskAcct.name);
        if (!known) {
          config.accounts.push(diskAcct);
          accountManager.addAccount(diskAcct);
        }
      }
      // Match by account id first, then by name — index may have shifted
      const cfgIdx = findConfigAccount(diskConfig, account);
      if (cfgIdx >= 0) {
        diskConfig.accounts[cfgIdx].accessToken = newTokens.accessToken;
        diskConfig.accounts[cfgIdx].refreshToken = newTokens.refreshToken;
        if (newTokens.idToken) diskConfig.accounts[cfgIdx].idToken = newTokens.idToken;
        diskConfig.accounts[cfgIdx].expiresAt = newTokens.expiresAt;
      }
    }).catch(err => console.error(`[TeamCodex] Failed to save refreshed token: ${err.message}`));
  });
  const port = config.proxy.port;
  const useTUI = process.stdout.isTTY && process.stdin.isTTY;

  let tui = null;
  let hooks = {};

  if (useTUI) {
    tui = new TUI({
      accountManager, config,
      saveConfig: () => atomicConfigUpdate(async diskConfig => {
        // Write in-memory accounts as the authoritative state, preserving
        // extra disk-only fields (e.g. importFrom) where the account still exists.
        // Use live tokens from AccountManager (not the stale config.accounts copy).
        diskConfig.accounts = config.accounts.map((a, i) => {
          const am = accountManager.accounts[i];
          const live = am ? {
            ...a,
            accessToken: am.credential,
            refreshToken: am.refreshToken,
            idToken: am.idToken,
            expiresAt: am.expiresAt,
          } : a;
          const diskAcct = diskConfig.accounts.find(
            d => (a.accountId && d.accountId === a.accountId) || d.name === a.name
          );
          return diskAcct ? { ...diskAcct, ...live } : live;
        });
      }),
      syncAccounts: async () => {
        const diskConfig = await loadConfig();
        if (!diskConfig) return 0;
        return syncAccountsFromDisk(diskConfig, config, accountManager);
      },
      onQuit: () => { server.close(() => process.exit(0)); },
    });
    hooks = {
      onRequestStart: (id, info) => tui.onRequestStart(id, info),
      onRequestRouted: (id, info) => tui.onRequestRouted(id, info),
      onRequestEnd: (id, info) => tui.onRequestEnd(id, info),
    };
  }

  const server = createProxyServer(accountManager, config, hooks);

  server.listen(port, () => {
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
        console.log(`  [${i + 1}] ${a.name} (${a.type}${a.planType ? ', ' + a.planType : ''})`);
      });
      console.log('');
      console.log('  Run Codex through proxy:  teamcodex run');
      console.log('  Show codex overrides:     teamcodex env');
      console.log(sep);
      console.log('');
    }
  });

  if (!tui) {
    process.on('SIGINT', () => {
      console.log('\n[TeamCodex] Shutting down...');
      server.close(() => process.exit(0));
    });
    process.on('SIGTERM', () => {
      console.log('\n[TeamCodex] Shutting down...');
      server.close(() => process.exit(0));
    });
  }
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
        console.error('JSON must contain "access_token" (directly or under "tokens")');
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
      console.error(`Failed to parse --json: ${err.message}`);
      process.exit(1);
    }
  } else {
    const fromPath = argValue('--from');
    try {
      creds = await importCredentials(fromPath);
    } catch (err) {
      console.error(`Failed to import from ${fromPath || defaultCodexAuthPath()}: ${err.message}`);
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
  await loginOAuthCommand();
}

async function loginApiCommand() {
  const config = await loadOrCreateConfig();
  let name = argValue('--name');

  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const apiKey = await new Promise(resolve => rl.question('OpenAI API key: ', resolve));
  rl.close();

  if (!apiKey.trim()) {
    console.error('No API key provided');
    process.exit(1);
  }

  if (!name) {
    const n = config.accounts.filter(a => a.name.startsWith('api-')).length + 1;
    name = `api-${n}`;
  }

  config.accounts.push({ name, type: 'apikey', apiKey: apiKey.trim() });
  await saveConfig(config);
  console.log(`Added API key account "${name}"`);
  console.log(`Saved to ${getConfigPath()}`);
}

async function loginOAuthCommand() {
  const config = await loadOrCreateConfig();
  const name = argValue('--name');

  console.log('Starting OAuth login...');
  let creds;
  try {
    creds = await loginOAuth();
  } catch (err) {
    console.error(`OAuth login failed: ${err.message}`);
    console.error('');
    console.error('Alternatives:');
    console.error('  teamcodex import         Import from existing Codex CLI credentials');
    console.error('  teamcodex login --api    Add an OpenAI API key instead');
    process.exit(1);
  }

  await upsertChatGPTAccount(config, name, creds, 'login');
}

// ── env ─────────────────────────────────────────────────────

async function envCommand() {
  const config = await loadOrCreateConfig();
  const o = codexOverrideArgs(config.proxy.port);
  const lines = [];
  for (let i = 0; i < o.length; i += 2) lines.push(`${o[i]} ${o[i + 1]}`);
  console.log(lines.join(' \\\n'));
}

// ── run ─────────────────────────────────────────────────────

function codexOverrideArgs(port) {
  return [
    '-c', 'model_provider=teamcodex',
    '-c', 'model_providers.teamcodex.name=TeamCodex',
    '-c', `model_providers.teamcodex.base_url=http://127.0.0.1:${port}/backend-api/codex`,
    '-c', 'model_providers.teamcodex.wire_api=responses',
    '-c', 'model_providers.teamcodex.requires_openai_auth=true',
    '-c', `chatgpt_base_url=http://127.0.0.1:${port}/backend-api`,
  ];
}

/**
 * Codex reads ChatGPT tokens from $CODEX_HOME/auth.json and refuses to start
 * without them (the proxy replaces them in-flight anyway). If the user never
 * logged into Codex itself, seed auth.json from the first proxy account.
 */
async function ensureCodexAuth(config) {
  const authPath = defaultCodexAuthPath();
  try {
    await readFile(authPath);
    return; // codex already has credentials
  } catch (err) {
    if (err.code !== 'ENOENT') return;
  }

  const acct = config.accounts.find(a => a.type === 'chatgpt' && a.accessToken);
  if (!acct) return;

  console.log(`Codex CLI has no credentials — seeding ${authPath} from account "${acct.name}"`);
  await mkdir(dirname(authPath), { recursive: true });
  await writeFile(authPath, JSON.stringify({
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: {
      id_token: acct.idToken,
      access_token: acct.accessToken,
      refresh_token: acct.refreshToken,
      account_id: acct.accountId,
    },
    last_refresh: new Date().toISOString(),
  }, null, 2) + '\n', { mode: 0o600 });
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

  await ensureCodexAuth(config);

  const fullArgs = [...codexArgs, ...codexOverrideArgs(config.proxy.port)];
  if (bypass) fullArgs.push('--dangerously-bypass-approvals-and-sandbox');

  // Codex keeps its own ChatGPT token in $CODEX_HOME/auth.json — the proxy
  // accepts requests from localhost and swaps in the active account's
  // credentials, so codex stays in subscription mode untouched.
  // Use spawnSync so the Node process blocks entirely — behaves like execvp.
  const result = spawnSync('codex', fullArgs, { stdio: 'inherit' });

  if (result.error) {
    if (result.error.code === 'ENOENT') {
      console.error('Codex CLI not found in PATH. Install it first: npm install -g @openai/codex');
    } else {
      console.error(`Failed to start codex: ${result.error.message}`);
    }
    process.exit(1);
  }

  process.exit(result.status ?? 1);
}

// ── status ──────────────────────────────────────────────────

async function statusCommand() {
  const config = await loadOrCreateConfig();
  const url = `http://localhost:${config.proxy.port}/teamcodex/status`;

  try {
    const res = await fetch(url, { headers: { 'x-api-key': config.proxy.apiKey } });
    const data = await res.json();

    console.log(`Active account: ${data.currentAccount}`);
    console.log(`Switch at:      ${(data.switchThreshold * 100).toFixed(0)}% usage\n`);

    for (const acct of data.accounts) {
      const q = acct.quota;
      const current = acct.name === data.currentAccount ? ' *' : '';
      const plan = acct.planType ? `, ${acct.planType}` : '';

      console.log(`  ${acct.name} (${acct.type}${plan})${current}`);
      console.log(`    Status:   ${acct.status}`);

      if (q.primary != null || q.secondary != null) {
        const p = q.primary != null ? (q.primary * 100).toFixed(1) + '%' : '-';
        const s = q.secondary != null ? (q.secondary * 100).toFixed(1) + '%' : '-';
        console.log(`    5h:       ${p} used    Weekly: ${s} used`);
      } else {
        const tok = q.tokensLimit ? ((1 - q.tokensRemaining / q.tokensLimit) * 100).toFixed(1) + '%' : '-';
        const req = q.requestsLimit ? ((1 - q.requestsRemaining / q.requestsLimit) * 100).toFixed(1) + '%' : '-';
        console.log(`    Tokens:   ${tok} used    Requests: ${req} used`);
      }

      console.log(`    Total:    ${acct.usage.totalInputTokens + acct.usage.totalOutputTokens} tokens, ${acct.usage.totalRequests} requests`);
      if (acct.rateLimitedUntil) console.log(`    Throttled until: ${acct.rateLimitedUntil}`);
      console.log('');
    }
  } catch {
    console.error(`Cannot connect to proxy at localhost:${config.proxy.port}`);
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

  // Refresh expired tokens
  let configDirty = false;
  await Promise.all(config.accounts.map(async (a) => {
    if (a.type !== 'chatgpt' || !a.refreshToken) return;
    if (!isTokenExpiringSoon(a.expiresAt)) return;
    try {
      const newTokens = await refreshAccessToken(a.refreshToken);
      a.accessToken = newTokens.accessToken;
      a.refreshToken = newTokens.refreshToken;
      if (newTokens.idToken) a.idToken = newTokens.idToken;
      a.expiresAt = newTokens.expiresAt;
      configDirty = true;
    } catch {
      // refresh failed — shown as expired below
    }
  }));

  // Deduplicate by account id — keep the last (most recently added) entry
  const seen = new Map();
  let removed = 0;
  for (let i = config.accounts.length - 1; i >= 0; i--) {
    const a = config.accounts[i];
    if (a.type !== 'chatgpt') continue;
    const info = accountInfoFromTokens({ accessToken: a.accessToken, idToken: a.idToken, accountId: a.accountId });
    const id = info.accountId;
    if (id) {
      if (seen.has(id)) {
        config.accounts.splice(i, 1);
        removed++;
        configDirty = true;
      } else {
        seen.set(id, i);
        // Update stored metadata from token claims
        a.accountId = id;
        if (info.email && a.name !== info.email && !a.name.startsWith('account-')) {
          // keep custom names
        } else if (info.email) {
          a.name = info.email;
        }
        if (info.planType) a.planType = info.planType;
      }
    }
  }
  if (configDirty) await saveConfig(config);
  if (removed > 0) console.log(`Removed ${removed} duplicate account(s)\n`);

  for (const [i, a] of config.accounts.entries()) {
    if (a.type === 'apikey') {
      console.log(`  [${i + 1}] ${a.name} (apikey)  ${a.apiKey?.slice(0, 12)}...`);
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
    if (!account) { console.error(`Account "${accountName}" not found`); process.exit(1); }
  } else {
    account = accounts.find(a => a.type === 'chatgpt') || accounts[0];
    if (!account) { console.error('No accounts configured'); process.exit(1); }
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
  const config = await loadOrCreateConfig();
  const name = args[1];

  if (!name) {
    console.error('Usage: teamcodex remove <account-name>');
    process.exit(1);
  }

  const idx = config.accounts.findIndex(a => a.name === name);
  if (idx < 0) {
    console.error(`Account "${name}" not found`);
    process.exit(1);
  }

  config.accounts.splice(idx, 1);
  await saveConfig(config);
  console.log(`Removed account "${name}"`);
}

// ── help ────────────────────────────────────────────────────

function showHelp() {
  console.log(`TeamCodex - Multi-account Codex proxy

Usage: teamcodex [command] [options]

Commands:
  serve               Start the proxy server (default)
  import              Import credentials from Codex CLI (~/.codex/auth.json)
  login               ChatGPT OAuth login via browser
  login --api         Add an OpenAI API key account
  env                 Print codex -c overrides to use the proxy manually
  run [args...]       Run Codex through the proxy; args pass through to codex
                      (e.g. "teamcodex run resume", "teamcodex run <prompt>")
  status              Show proxy & account status (live)
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

async function upsertChatGPTAccount(config, name, creds, source = 'unknown') {
  const info = accountInfoFromTokens(creds);

  if (!name && info.email) {
    name = info.email;
    if (info.planType) console.log(`Detected ChatGPT ${info.planType} account: ${info.email}`);
  }
  if (!name) {
    const n = config.accounts.filter(a => a.name.startsWith('account-')).length + 1;
    name = `account-${n}`;
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

  // Deduplicate: match by account id first, then by name
  let idx = info.accountId
    ? config.accounts.findIndex(a => a.accountId === info.accountId)
    : -1;
  if (idx < 0) idx = config.accounts.findIndex(a => a.name === name);

  if (idx >= 0) {
    config.accounts[idx] = account;
    console.log(`Updated account "${name}"`);
  } else {
    config.accounts.push(account);
    console.log(`Added account "${name}"`);
  }

  await saveConfig(config);
  console.log(`Saved to ${getConfigPath()}`);
}

// ── config sync helpers ─────────────────────────────────────

/**
 * Find a config account entry matching an in-memory account (by account id, then name).
 */
function findConfigAccount(diskConfig, account) {
  if (account.accountId) {
    const idx = diskConfig.accounts.findIndex(a => a.accountId === account.accountId);
    if (idx >= 0) return idx;
  }
  return diskConfig.accounts.findIndex(a => a.name === account.name);
}

/**
 * Sync accounts from disk config: add new accounts and refresh credentials
 * for existing ones (handles re-imported tokens, rotated API keys, etc.).
 * Returns the number of new accounts added.
 */
async function syncAccountsFromDisk(diskConfig, memConfig, accountManager) {
  let added = 0;
  for (const diskAcct of diskConfig.accounts) {
    const matchById = diskAcct.accountId &&
      memConfig.accounts.findIndex(a => a.accountId === diskAcct.accountId);
    const matchByName = memConfig.accounts.findIndex(a => a.name === diskAcct.name);
    const memIdx = (matchById >= 0 ? matchById : null) ?? (matchByName >= 0 ? matchByName : -1);

    if (memIdx < 0) {
      // New account discovered on disk — add to running server
      memConfig.accounts.push(diskAcct);
      accountManager.addAccount(diskAcct);
      added++;
      console.log(`[TeamCodex] Picked up new account "${diskAcct.name}" from config`);
      continue;
    }

    // Existing account — resolve fresh credentials from disk
    let freshCred = null;
    if (diskAcct.type === 'chatgpt' && diskAcct.importFrom) {
      try {
        const creds = await importCredentials(diskAcct.importFrom);
        freshCred = {
          accessToken: creds.accessToken, refreshToken: creds.refreshToken,
          idToken: creds.idToken, expiresAt: creds.expiresAt,
        };
      } catch (err) {
        console.error(`[TeamCodex] Re-import failed for "${diskAcct.name}": ${err.message}`);
      }
    } else if (diskAcct.type === 'chatgpt' && diskAcct.accessToken) {
      freshCred = {
        accessToken: diskAcct.accessToken, refreshToken: diskAcct.refreshToken,
        idToken: diskAcct.idToken, expiresAt: diskAcct.expiresAt,
      };
    } else if (diskAcct.type === 'apikey' && diskAcct.apiKey) {
      freshCred = { apiKey: diskAcct.apiKey };
    }

    if (!freshCred) continue;

    // Find the corresponding AccountManager entry and update credentials
    const mgr = accountManager.accounts.find(a =>
      (diskAcct.accountId && a.accountId === diskAcct.accountId) || a.name === diskAcct.name
    );
    if (!mgr) continue;

    if (freshCred.accessToken) {
      const changed = mgr.credential !== freshCred.accessToken ||
        mgr.refreshToken !== freshCred.refreshToken;
      // Don't overwrite in-memory credentials with staler ones from disk
      // (e.g. after a TUI import updated the AM before saveConfig wrote to disk)
      const diskIsStaler = freshCred.expiresAt && mgr.expiresAt &&
        freshCred.expiresAt < mgr.expiresAt;
      if (changed && !diskIsStaler) {
        accountManager.updateAccountTokens(mgr.index, freshCred);
        console.log(`[TeamCodex] Refreshed credentials for "${mgr.name}"`);
      }
    } else if (freshCred.apiKey && mgr.credential !== freshCred.apiKey) {
      mgr.credential = freshCred.apiKey;
      if (mgr.status === 'error') mgr.status = 'active';
      console.log(`[TeamCodex] Updated API key for "${mgr.name}"`);
    }
  }
  return added;
}

// ── helpers ─────────────────────────────────────────────────

async function resolveAccounts(config) {
  const accounts = [];
  for (const acct of config.accounts) {
    if (acct.type === 'chatgpt') {
      if (acct.importFrom) {
        try {
          const creds = await importCredentials(acct.importFrom);
          accounts.push({ name: acct.name, type: 'chatgpt', planType: acct.planType, ...creds });
          console.log(`Imported "${acct.name}" from ${acct.importFrom}`);
        } catch (err) {
          console.error(`Failed to import "${acct.name}": ${err.message}`);
        }
      } else if (acct.accessToken) {
        accounts.push(acct);
      } else {
        console.error(`No token for "${acct.name}", skipping`);
      }
    } else if (acct.type === 'apikey' && acct.apiKey) {
      accounts.push(acct);
    }
  }
  return accounts;
}

function argValue(flag) {
  const i = args.indexOf(flag);
  return (i >= 0 && args[i + 1]) ? args[i + 1] : null;
}
