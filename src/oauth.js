export { parseManualAuthInput } from '@teamcodex/proxy/auth/callback';
export { deviceCodeLogin } from '@teamcodex/proxy/auth/device';
import { parseManualAuthInput,startCallbackServer } from '@teamcodex/proxy/auth/callback';
import { OAUTH_AUTHORIZE, OAUTH_CALLBACK_PORT, OAUTH_CLIENT_ID, OAUTH_SCOPES } from '@teamcodex/proxy/auth/constants';
import { exchangeCodeForTokens } from '@teamcodex/proxy/auth/exchange';
export { accountInfoFromTokens, defaultCodexAuthPath, importCredentials } from '@teamcodex/proxy/auth/tokens';
import { spawn } from 'node:child_process';
import { createHash,randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';

import { browserPrompt } from './tui-login.js';
import { ESC } from './tui-style.js';

/**
 * Perform OAuth login via browser with PKCE flow.
 * Opens the user's browser, waits for the callback, exchanges the code for tokens.
 */
export async function loginOAuth({ onAuthorize } = {}) {
  // Generate PKCE
  const codeVerifier = randomBytes(64).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  const state = randomBytes(32).toString('base64url');

  // The Codex OAuth client only accepts http://localhost:1455/auth/callback
  const redirectUri = `http://localhost:${OAUTH_CALLBACK_PORT}/auth/callback`;
  const { codePromise, server } = await startCallbackServer(state);
  // A callback can fail while an asynchronous authorization hook is still running.
  // Observe it immediately; the original promise still rejects when awaited below.
  codePromise.catch(() => {});

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

  if (process.stdout.isTTY) {
    process.stdout.write(`${ESC}H${ESC}2J`);
    console.log(browserPrompt(authUrl.toString(), Math.max(40, Math.min(100, (process.stdout.columns || 80) - 1))).join('\n'));
  } else {
    console.log('Opening browser for authentication...');
    console.log(`If it doesn't open, visit:\n  ${authUrl.toString()}\n`);
  }

  // Wait for either the callback server or manual paste from stdin
  let authResult;
  try {
    if (onAuthorize) await onAuthorize(authUrl.toString());
    else openBrowser(authUrl.toString());
    authResult = await raceWithStdinCode(codePromise, state);
  } finally {
    server.close();
  }

  // Exchange code for tokens
  console.log('Exchanging authorization code for tokens...');
  return exchangeCodeForTokens(authResult.code, codeVerifier, redirectUri);
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

function openBrowser(url) {
  const child = process.platform === 'darwin'
    ? spawn('open', [url], { stdio: 'ignore' })
    : spawn('xdg-open', [url], { stdio: 'ignore' });
  child.on('error', () => {}); // The URL is also printed for manual opening.
  child.unref();
}
