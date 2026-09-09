import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { isRecord } from '@teamcodex/core/config';

import type { Credentials } from './tokens.ts';
import { accountInfoFromTokens, defaultCodexAuthPath } from './tokens.ts';

async function writeCodexAuth(authPath: string, auth: Record<string, unknown>): Promise<void> {
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
export async function updateCodexAuthIfMatching(account: { name: string; accountId?: string | null }, newTokens: Credentials): Promise<void> {
  const authPath = defaultCodexAuthPath();
  let auth: Record<string, unknown>;
  try {
    const raw: unknown = JSON.parse(await readFile(authPath, 'utf-8'));
    if (!isRecord(raw)) return;
    auth = raw;
  } catch {
    return; // no codex auth.json (or unreadable) — nothing to sync
  }

  const tokens = isRecord(auth.tokens) ? auth.tokens : {};
  const authInfo = accountInfoFromTokens({
    accessToken: typeof tokens.access_token === 'string' ? tokens.access_token : null,
    idToken: typeof tokens.id_token === 'string' ? tokens.id_token : null,
    accountId: typeof tokens.account_id === 'string' ? tokens.account_id : null,
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

