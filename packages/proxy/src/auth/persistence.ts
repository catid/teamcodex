import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { isRecord } from '@teamcodex/core/config';

import type { Credentials } from './tokens.ts';
import { accountInfoFromTokens, defaultCodexAuthPath } from './tokens.ts';

async function writeCodexAuth(authPath: string, auth: Record<string, unknown>, expectedContent: string, isCurrent: () => boolean): Promise<boolean> {
  await mkdir(dirname(authPath), { recursive: true });
  const tmpPath = `${authPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmpPath, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    if (await readFile(authPath, 'utf8') !== expectedContent || !isCurrent()) return false;
    await rename(tmpPath, authPath);
    return true;
  } finally { await rm(tmpPath, { force: true }); }
}

/**
 * Mirror freshly refreshed tokens into the Codex CLI's auth.json when it
 * holds tokens for the same account. Codex reloads auth.json before
 * refreshing (guarded reload) and skips its own refresh when the file has
 * newer tokens — without this, codex eventually tries to refresh a rotated
 * refresh token and dies with "refresh token was revoked".
 */
export async function updateCodexAuthIfMatching(account: { name: string; accountId?: string | null }, newTokens: Credentials, previousRefreshToken: string, previousCredential: string | undefined, isCurrent: () => boolean): Promise<void> {
  const authPath = defaultCodexAuthPath();
  let auth: Record<string, unknown>;
  let content: string;
  try {
    content = await readFile(authPath, 'utf8');
    const raw: unknown = JSON.parse(content);
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
  if (!acctId || authInfo.accountId !== acctId || !isCurrent() ||
      tokens.refresh_token !== previousRefreshToken || tokens.access_token !== previousCredential) return;

  const saved = await writeCodexAuth(authPath, {
    ...auth,
    tokens: {
      ...tokens,
      id_token: newTokens.idToken ?? tokens.id_token,
      access_token: newTokens.accessToken,
      refresh_token: newTokens.refreshToken,
      account_id: acctId,
    },
    last_refresh: new Date().toISOString(),
  }, content, isCurrent);
  if (saved) console.log(`[TeamCodex] Synced refreshed tokens to codex auth.json ("${account.name}")`);
}

