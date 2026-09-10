import { isRecord } from '@teamcodex/core/config';
import { createError } from '@teamcodex/core/errors';
import { ApiClient } from '@teamcodex/shared/api-client';

import { OAUTH_CLIENT_ID, OAUTH_TOKEN } from './constants.ts';
import type { Credentials } from './tokens.ts';
import { accountInfoFromTokens } from './tokens.ts';

interface CodeExchange { code: string; verifier: string }
const tokenClient = new ApiClient<CodeExchange, Credentials, { redirectUri: string }, unknown>({
  encode: ({ code, verifier }, { redirectUri }) => ({ url: OAUTH_TOKEN, options: {
    method: 'POST',
    signal: AbortSignal.timeout(30_000),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code,
      redirect_uri: redirectUri, client_id: OAUTH_CLIENT_ID, code_verifier: verifier }),
  } }),
  decode: async response => {
    if (!response.ok) throw createError('TOKEN_EXCHANGE_FAILED', { status: response.status, message: await response.text() });
    const raw: unknown = await response.json();
    const tokens = isRecord(raw) ? raw : {};
    if (typeof tokens.access_token !== 'string' || !tokens.access_token) throw createError('TOKEN_REFRESH_INVALID');
    const credentials: Credentials = {
      expiresAt: null,
      accessToken: tokens.access_token,
      refreshToken: typeof tokens.refresh_token === 'string' ? tokens.refresh_token : null,
      idToken: typeof tokens.id_token === 'string' ? tokens.id_token : null,
    };
    const info = accountInfoFromTokens(credentials);
    credentials.accountId = info.accountId;
    credentials.expiresAt = info.expiresAt
      || Date.now() + (typeof tokens.expires_in === 'number' && Number.isFinite(tokens.expires_in) && tokens.expires_in ? tokens.expires_in : 3600) * 1000;
    return credentials;
  },
  mapError: error => error,
});

export async function exchangeCodeForTokens(code: unknown, codeVerifier: unknown, redirectUri: string): Promise<Credentials> {
  if (typeof code !== 'string' || !code || typeof codeVerifier !== 'string' ||
      !/^[A-Za-z0-9._~-]{43,128}$/.test(codeVerifier)) throw createError('OAUTH_PKCE_INVALID');
  return tokenClient.request({ code, verifier: codeVerifier }, { redirectUri });
}
