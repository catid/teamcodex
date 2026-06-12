import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { exec } from 'node:child_process';
import { createInterface } from 'node:readline';
import http from 'node:http';

// OAuth config (matches the Codex CLI's registered client)
const OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const OAUTH_ISSUER = 'https://auth.openai.com';
const OAUTH_AUTHORIZE = `${OAUTH_ISSUER}/oauth/authorize`;
const OAUTH_TOKEN = `${OAUTH_ISSUER}/oauth/token`;
const OAUTH_SCOPES = 'openid profile email offline_access';
// The Codex client only allows localhost:1455 as a redirect URI
const OAUTH_CALLBACK_PORT = 1455;

export function defaultCodexAuthPath() {
  const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex');
  return join(codexHome, 'auth.json');
}

/**
 * Decode the payload of a JWT without verifying the signature.
 * Returns null on any parse failure.
 */
export function parseJwtClaims(token) {
  try {
    const payload = token.split('.')[1];
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));
  } catch {
    return null;
  }
}

/**
 * Extract account metadata from a Codex token set.
 * Returns { accountId, email, planType, expiresAt } with nulls where unknown.
 */
export function accountInfoFromTokens({ accessToken, idToken, accountId }) {
  const access = accessToken ? parseJwtClaims(accessToken) : null;
  const id = idToken ? parseJwtClaims(idToken) : null;
  const accessAuth = access?.['https://api.openai.com/auth'] || {};
  const idAuth = id?.['https://api.openai.com/auth'] || {};

  return {
    accountId: accountId
      || accessAuth.chatgpt_account_id
      || idAuth.chatgpt_account_id
      || null,
    email: id?.email
      || access?.['https://api.openai.com/profile']?.email
      || null,
    planType: accessAuth.chatgpt_plan_type || idAuth.chatgpt_plan_type || null,
    expiresAt: access?.exp ? access.exp * 1000 : null,
  };
}

/**
 * Import credentials from a Codex CLI auth.json file.
 */
export async function importCredentials(filePath) {
  const resolvedPath = (filePath || defaultCodexAuthPath()).replace(/^~/, homedir());
  const raw = JSON.parse(await readFile(resolvedPath, 'utf-8'));

  const tokens = raw.tokens || raw;
  if (!tokens.access_token && !tokens.accessToken) {
    throw new Error('no access_token found (is this a ChatGPT-mode auth.json?)');
  }

  const creds = {
    accessToken: tokens.access_token || tokens.accessToken,
    refreshToken: tokens.refresh_token || tokens.refreshToken,
    idToken: tokens.id_token || tokens.idToken || null,
    accountId: tokens.account_id || tokens.accountId || null,
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
export async function refreshAccessToken(refreshToken, endpoint = OAUTH_TOKEN) {
  const maxRetries = 2;
  const baseDelayMs = 500;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        const delay = baseDelayMs * 2 ** (attempt - 1);
        await new Promise(resolve => setTimeout(resolve, delay));
      }

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: OAUTH_CLIENT_ID,
          scope: 'openid profile email',
        }),
      });

      if (!res.ok) {
        if (res.status >= 500 && attempt < maxRetries) {
          await res.body?.cancel();
          continue;
        }
        const text = await res.text();
        throw new Error(`Token refresh failed (${res.status}): ${text}`);
      }

      const data = await res.json();
      const accessToken = data.access_token;
      const claims = parseJwtClaims(accessToken);
      return {
        accessToken,
        refreshToken: data.refresh_token || refreshToken,
        idToken: data.id_token || null,
        expiresAt: claims?.exp
          ? claims.exp * 1000
          : Date.now() + (data.expires_in || 3600) * 1000,
      };
    } catch (err) {
      const isNetworkError = err instanceof Error &&
        (err.message.includes('fetch failed') ||
          (err.code === 'ECONNRESET' || err.code === 'ECONNREFUSED' ||
           err.code === 'ETIMEDOUT' || err.code === 'UND_ERR_CONNECT_TIMEOUT'));

      if (attempt < maxRetries && isNetworkError) {
        continue;
      }
      throw err;
    }
  }
}

/**
 * Check if a token is expiring within the given threshold.
 */
export function isTokenExpiringSoon(expiresAt, thresholdMs = 5 * 60 * 1000) {
  if (!expiresAt) return false;
  return Date.now() + thresholdMs >= expiresAt;
}

/**
 * Perform OAuth login via browser with PKCE flow.
 * Opens the user's browser, waits for the callback, exchanges the code for tokens.
 */
export async function loginOAuth() {
  // Generate PKCE
  const codeVerifier = randomBytes(64).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  const state = randomBytes(32).toString('base64url');

  // The Codex OAuth client only accepts http://localhost:1455/auth/callback
  const redirectUri = `http://localhost:${OAUTH_CALLBACK_PORT}/auth/callback`;
  const { codePromise, server } = await startCallbackServer(state);

  const authUrl = new URL(OAUTH_AUTHORIZE);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', OAUTH_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('scope', OAUTH_SCOPES);
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('id_token_add_organizations', 'true');
  authUrl.searchParams.set('codex_cli_simplified_flow', 'true');
  authUrl.searchParams.set('originator', 'codex_cli_rs');

  console.log('Opening browser for authentication...');
  console.log(`If it doesn't open, visit:\n  ${authUrl.toString()}\n`);
  openBrowser(authUrl.toString());

  // Wait for either the callback server or manual paste from stdin
  let authResult;
  try {
    authResult = await raceWithStdinCode(codePromise, state);
  } finally {
    server.close();
  }

  // Exchange code for tokens
  console.log('Exchanging authorization code for tokens...');
  const tokenRes = await fetch(OAUTH_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: authResult.code,
      redirect_uri: redirectUri,
      client_id: OAUTH_CLIENT_ID,
      code_verifier: codeVerifier,
    }),
  });

  if (!tokenRes.ok) {
    const text = await tokenRes.text();
    throw new Error(`Token exchange failed (${tokenRes.status}): ${text}`);
  }

  const tokens = await tokenRes.json();
  const creds = {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    idToken: tokens.id_token || null,
  };
  const info = accountInfoFromTokens(creds);
  creds.accountId = info.accountId;
  creds.expiresAt = info.expiresAt
    || Date.now() + (tokens.expires_in || 3600) * 1000;
  return creds;
}

/**
 * Race the callback server promise against manual code entry from stdin.
 * The user can paste the full callback URL or just the authorization code.
 */
function raceWithStdinCode(callbackPromise, expectedState) {
  if (!process.stdin.isTTY) return callbackPromise;

  return new Promise((resolve, reject) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    let settled = false;

    const settle = (fn, val) => {
      if (settled) return;
      settled = true;
      rl.close();
      fn(val);
    };

    rl.question('Paste callback URL or code here (or wait for browser callback): ', answer => {
      try {
        const result = parseManualAuthInput(answer, expectedState);
        if (!result) return; // empty input, keep waiting for callback
        settle(resolve, result);
      } catch (err) {
        settle(reject, err);
      }
    });

    callbackPromise.then(
      code => settle(resolve, code),
      err => settle(reject, err),
    );
  });
}

function parseManualAuthInput(input, expectedState) {
  const trimmed = input.trim();
  if (!trimmed) return null;

  try {
    const url = new URL(trimmed);
    const query = new URLSearchParams(url.search);
    const code = query.get('code');
    const state = query.get('state');
    if (code) {
      assertOAuthState(state, expectedState);
      return { code };
    }
  } catch {}

  if (trimmed.includes('=') && trimmed.includes('&')) {
    const params = new URLSearchParams(trimmed);
    const code = params.get('code');
    if (code) {
      assertOAuthState(params.get('state'), expectedState);
      return { code };
    }
  }

  return { code: trimmed };
}

function assertOAuthState(actualState, expectedState) {
  if (expectedState && actualState && actualState !== expectedState) {
    throw new Error('OAuth state mismatch');
  }
}

function startCallbackServer(expectedState) {
  return new Promise((resolve, reject) => {
    let resolveCode, rejectCode;
    const codePromise = new Promise((res, rej) => { resolveCode = res; rejectCode = rej; });

    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');

      if (url.pathname === '/auth/callback') {
        const code = url.searchParams.get('code');
        const error = url.searchParams.get('error');
        const state = url.searchParams.get('state');

        if (error) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<html><body><h2>Authentication failed</h2><p>You can close this tab.</p></body></html>');
          rejectCode(new Error(`OAuth error: ${error} - ${url.searchParams.get('error_description') || ''}`));
          return;
        }

        if (expectedState && state !== expectedState) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<html><body><h2>Authentication failed</h2><p>State mismatch. You can close this tab.</p></body></html>');
          rejectCode(new Error('OAuth state mismatch'));
          return;
        }

        if (code) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<html><body><h2>Login successful</h2><p>You can close this tab and return to the terminal.</p></body></html>');
          resolveCode({ code });
          return;
        }
      }

      res.writeHead(404);
      res.end('Not found');
    });

    server.listen(OAUTH_CALLBACK_PORT, () => {
      resolve({ codePromise, server });
    });
    server.on('error', err => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(
          `Port ${OAUTH_CALLBACK_PORT} is in use (the Codex OAuth client requires it). ` +
          'Close any running "codex login" and try again.'
        ));
      } else {
        reject(err);
      }
    });

    // Timeout after 5 minutes (unref so it doesn't keep the process alive)
    const timer = setTimeout(() => {
      rejectCode(new Error('Login timed out after 5 minutes'));
      server.close();
    }, 300_000);
    timer.unref();
  });
}

function openBrowser(url) {
  const platform = process.platform;
  const cmd = platform === 'darwin' ? 'open'
    : platform === 'win32' ? 'start'
    : 'xdg-open';
  exec(`${cmd} ${JSON.stringify(url)}`, () => {});
}
