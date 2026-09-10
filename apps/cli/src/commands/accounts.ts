import { createError, errorMessage } from '@teamcodex/core/errors';
import { resolveAccounts } from '@teamcodex/proxy/accounts';
import { accountInfoFromTokens } from '@teamcodex/proxy/auth/tokens';
import { atomicConfigUpdate, loadOrCreateConfig } from '@teamcodex/proxy/config';
import { httpClient } from '@teamcodex/shared/api-client';

import { notifyServerReload } from '../accounts.ts';
import { argValue } from '../arguments.ts';

export async function accountsCommand(args: string[]): Promise<void> {
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

    const info = accountInfoFromTokens({ accessToken: a.accessToken ?? null, idToken: a.idToken ?? null, accountId: a.accountId ?? null });
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

export async function apiCommand(args: string[]): Promise<void> {
  const config = await loadOrCreateConfig();
  const path = args[1];

  if (!path) {
    console.error('Usage: teamcodex api <path> [--account NAME] [--method POST] [--data JSON]');
    console.error('Example: teamcodex api /backend-api/wham/usage');
    process.exit(1);
  }

  // Find account to use
  const accountName = argValue(args, '--account');
  const method = (argValue(args, '--method') || 'GET').toUpperCase();
  const data = argValue(args, '--data');

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
  const base = new URL(upstream);
  let url: URL;
  const endpoint = path.startsWith('/') && !path.startsWith('//') ? `.${path}` : path;
  try { url = new URL(endpoint, `${upstream.replace(/\/$/, '')}/`); }
  catch { throw createError('API_DESTINATION_INVALID'); }
  if (url.origin !== base.origin || url.username || url.password) throw createError('API_DESTINATION_INVALID');

  const headers: Record<string, string> = { 'Authorization': `Bearer ${credential}` };
  if (account.type === 'chatgpt' && account.accountId) {
    headers['chatgpt-account-id'] = account.accountId;
  }

  const fetchOpts: RequestInit = { method, headers, redirect: 'manual', signal: AbortSignal.timeout(30_000) };
  if (data) {
    headers['Content-Type'] = 'application/json';
    fetchOpts.body = data;
  }

  const res = await httpClient.request({ url: url, options: fetchOpts });

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

export async function removeCommand(args: string[]): Promise<void> {
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
