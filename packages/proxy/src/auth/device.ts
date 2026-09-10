import { isRecord } from '@teamcodex/core/config';
import { createError } from '@teamcodex/core/errors';
import { httpClient } from '@teamcodex/shared/api-client';

import { OAUTH_CLIENT_ID, OAUTH_ISSUER } from './constants.ts';
import { exchangeCodeForTokens } from './exchange.ts';
import type { Credentials } from './tokens.ts';

/**
 * Device authorization grant (RFC 8628) — for headless servers with no
 * browser and no reachable localhost callback. The OpenAI auth server
 * generates the PKCE pair; we request a user code, the user enters it on
 * another device, we poll until authorized, then exchange for tokens.
 *
 * `onPrompt({ verificationUrl, userCode })` is called once the code is issued.
 */
export async function deviceCodeLogin({ onPrompt }: { onPrompt?: (prompt: { verificationUrl: string; userCode: string }) => void } = {}): Promise<Credentials> {
  const apiBase = `${OAUTH_ISSUER}/api/accounts`;

  // 1. Request a user code
  const ucRes = await httpClient.request({ url: `${apiBase}/deviceauth/usercode`, options: {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({ client_id: OAUTH_CLIENT_ID }),
  } });
  if (!ucRes.ok) {
    if (ucRes.status === 404) {
      throw createError('DEVICE_AUTH_UNAVAILABLE');
    }
    throw createError('DEVICE_CODE_FAILED', { status: ucRes.status });
  }
  const raw: unknown = await ucRes.json();
  const uc = isRecord(raw) ? raw : {};
  const deviceAuthId = uc.device_auth_id;
  const userCode = uc.user_code || uc.usercode;
  if (typeof deviceAuthId !== 'string' || !deviceAuthId || typeof userCode !== 'string' || !userCode) throw createError('DEVICE_RESPONSE_INVALID');
  const interval = Math.max(5, parseInt(typeof uc.interval === 'string' || typeof uc.interval === 'number' ? String(uc.interval) : '', 10) || 5);
  const verificationUrl = `${OAUTH_ISSUER}/codex/device`;

  onPrompt?.({ verificationUrl, userCode });

  // 2. Poll until the user authorizes (403/404 = pending), max 15 minutes
  const tokenUrl = `${apiBase}/deviceauth/token`;
  const deadline = Date.now() + 15 * 60 * 1000;
  let codeResp: Record<string, unknown>;
  while (true) {
    const r = await httpClient.request({ url: tokenUrl, options: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(Math.max(1, Math.min(30_000, deadline - Date.now()))),
      body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
    } });
    if (r.ok) { const raw: unknown = await r.json(); codeResp = isRecord(raw) ? raw : {}; break; }
    if (r.status === 403 || r.status === 404) {
      await r.body?.cancel();
      if (Date.now() >= deadline) throw createError('DEVICE_AUTH_TIMEOUT');
      const wait = Math.min(interval * 1000, deadline - Date.now());
      await new Promise(resolve => setTimeout(resolve, wait));
      continue;
    }
    const text = await r.text().catch(() => '');
    throw createError('DEVICE_AUTH_FAILED', { status: r.status, message: text ? `: ${  text}` : '' });
  }

  // 3. Exchange the issued code (with the server-provided verifier) for tokens
  const redirectUri = `${OAUTH_ISSUER}/deviceauth/callback`;
  return exchangeCodeForTokens(codeResp.authorization_code, codeResp.code_verifier, redirectUri);
}

