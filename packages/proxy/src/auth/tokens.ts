import { homedir } from 'node:os';
import { join } from 'node:path';

import { isRecord } from '@teamcodex/core/config';
import { createError } from '@teamcodex/core/errors';
import { httpClient } from '@teamcodex/shared/api-client';
import { readFile } from '@teamcodex/shared/filesystem';

import { OAUTH_CLIENT_ID, OAUTH_TOKEN } from './constants.ts';
export interface Credentials {
  accessToken: string;
  refreshToken: string | null;
  idToken: string | null;
  accountId?: string | null;
  expiresAt: number | null;
}
export interface AccountInfo {
  accountId: string | null;
  email: string | null;
  planType: string | null;
  expiresAt: number | null;
}
const string = (value: unknown): string | null => typeof value === 'string' && value ? value : null;
const record = (value: unknown): Record<string, unknown> => isRecord(value) ? value : {};

export function defaultCodexAuthPath(): string {
  const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex');
  return join(codexHome, 'auth.json');
}

/**
 * Decode the payload of a JWT without verifying the signature.
 * Returns null on any parse failure.
 */
function parseJwtClaims(token: string): Record<string, unknown> | null {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    const claims: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));
    return isRecord(claims) ? claims : null;
  } catch {
    return null;
  }
}

/**
 * Extract account metadata from a Codex token set.
 * Returns { accountId, email, planType, expiresAt } with nulls where unknown.
 */
export function accountInfoFromTokens({ accessToken, idToken, accountId }: { accessToken?: string | null; idToken?: string | null; accountId?: string | null }): AccountInfo {
  const access = accessToken ? parseJwtClaims(accessToken) : null;
  const id = idToken ? parseJwtClaims(idToken) : null;
  const accessAuth = record(access?.['https://api.openai.com/auth']);
  const idAuth = record(id?.['https://api.openai.com/auth']);

  return {
    accountId: accountId
      || string(accessAuth.chatgpt_account_id)
      || string(idAuth.chatgpt_account_id)
      || null,
    email: string(id?.email)
      || string(record(access?.['https://api.openai.com/profile']).email)
      || null,
    planType: string(accessAuth.chatgpt_plan_type) || string(idAuth.chatgpt_plan_type) || null,
    expiresAt: typeof access?.exp === 'number' && Number.isFinite(access.exp) ? access.exp * 1000 : null,
  };
}

/**
 * Import credentials from a Codex CLI auth.json file.
 */
export async function importCredentials(filePath?: string): Promise<Credentials> {
  const resolvedPath = (filePath || defaultCodexAuthPath()).replace(/^~/, homedir());
  const raw = record(JSON.parse(await readFile(resolvedPath, 'utf-8')));

  const tokens = record(raw.tokens || raw);
  const accessToken = string(tokens.access_token) || string(tokens.accessToken);
  if (!accessToken) {
    throw createError('ACCESS_TOKEN_MISSING');
  }

  const creds: Credentials = {
    expiresAt: null,
    accessToken,
    refreshToken: string(tokens.refresh_token) || string(tokens.refreshToken),
    idToken: string(tokens.id_token) || string(tokens.idToken),
    accountId: string(tokens.account_id) || string(tokens.accountId),
  };
  const info = accountInfoFromTokens(creds);
  creds.accountId = info.accountId;
  creds.expiresAt = info.expiresAt;
  return creds;
}

/**
 * Refresh an access token using the refresh token.
 * Retries on 5xx and network errors with exponential backoff.
 */
export async function refreshAccessToken(refreshToken: string, endpoint = OAUTH_TOKEN): Promise<Credentials> {
  const maxRetries = 2;
  const baseDelayMs = 500;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        const delay = baseDelayMs * 2 ** (attempt - 1);
        await new Promise(resolve => setTimeout(resolve, delay));
      }

      // Matches the Codex CLI's refresh request exactly: a JSON body with
      // client_id / grant_type / refresh_token and no scope field.
      const res = await httpClient.request({ url: endpoint, options: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({
          client_id: OAUTH_CLIENT_ID,
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
        }),
      } });

      if (!res.ok) {
        if (res.status >= 500 && attempt < maxRetries) {
          await res.body?.cancel();
          continue;
        }
        const text = await res.text();
        throw createError('TOKEN_REFRESH_FAILED', { status: res.status, message: text });
      }

      const data = record(await res.json());
      const accessToken = string(data.access_token);
      if (!accessToken) {
        throw createError('TOKEN_REFRESH_INVALID');
      }
      const claims = parseJwtClaims(accessToken);
      return {
        accessToken,
        refreshToken: string(data.refresh_token) || refreshToken,
        idToken: string(data.id_token),
        expiresAt: typeof claims?.exp === 'number' && Number.isFinite(claims.exp)
          ? claims.exp * 1000
          : Date.now() + (typeof data.expires_in === 'number' && Number.isFinite(data.expires_in) && data.expires_in ? data.expires_in : 3600) * 1000,
      };
    } catch (err) {
      const code = isRecord(err) ? err.code : undefined;
      const isNetworkError = err instanceof Error &&
        (err.message.includes('fetch failed') || err.name === 'TimeoutError' ||
          (code === 'ECONNRESET' || code === 'ECONNREFUSED' ||
           code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT'));

      if (attempt < maxRetries && isNetworkError) {
        continue;
      }
      throw err;
    }
  }
  throw createError('TOKEN_REFRESH_INVALID');
}

/**
 * Check if a token is expiring within the given threshold.
 */
export function isTokenExpiringSoon(expiresAt: number | null | undefined, thresholdMs = 5 * 60 * 1000): boolean {
  if (!expiresAt) return false;
  return Date.now() + thresholdMs >= expiresAt;
}

