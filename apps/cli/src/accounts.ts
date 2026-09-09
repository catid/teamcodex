import type { AccountConfig, Config } from '@teamcodex/core/config';
import { isRecord } from '@teamcodex/core/config';
import { createError, errorMessage } from '@teamcodex/core/errors';
import { preserveAccountRouting } from '@teamcodex/core/routing';
import { findConfigAccount } from '@teamcodex/proxy/accounts';
import type { Credentials } from '@teamcodex/proxy/auth/tokens';
import { accountInfoFromTokens } from '@teamcodex/proxy/auth/tokens';
import { atomicConfigUpdate, getConfigPath } from '@teamcodex/proxy/config';

export async function upsertChatGPTAccount(name: string | null, creds: Credentials, source = 'unknown'): Promise<void> {
  const info = accountInfoFromTokens(creds);

  if (!name && info.email) {
    name = info.email;
    if (info.planType) console.log(`Detected ChatGPT ${info.planType} account: ${info.email}`);
  }
  const account: AccountConfig = {
    name: name ?? '',
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
      const previous = diskConfig.accounts[idx];
      if (previous) preserveAccountRouting(diskConfig, previous, account);
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
export async function notifyServerReload(config: Config, { removeMissing = false }: { removeMissing?: boolean } = {}): Promise<void> {
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
    const raw: unknown = await res.json();
    const data = isRecord(raw) ? raw : {};
    const parts = [];
    if (data.added) parts.push(`${data.added} added`);
    if (data.updated) parts.push(`${data.updated} updated`);
    if (data.removed) parts.push(`${data.removed} removed`);
    console.log(`Running server reloaded${parts.length ? ` (${parts.join(', ')})` : ' (no changes)'}`);
  } catch (err) {
    const code = isRecord(err) ? err.code || (isRecord(err.cause) ? err.cause.code : undefined) : undefined;
    if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN') return; // server not running — it'll load the config on start
    console.log(errorMessage('RELOAD_NOTIFICATION_FAILED', { message: (err instanceof Error ? err.message : String(err)) }));
  }
}
