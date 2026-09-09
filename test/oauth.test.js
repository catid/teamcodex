import assert from 'node:assert/strict';
import test from 'node:test';

import { AccountManager } from '../src/account-manager.js';
import { parseManualAuthInput } from '../src/oauth.js';
import { TUI } from '../src/tui.js';

test('pasted callback URLs enforce state and never swallow a mismatch', () => {
  assert.throws(() => parseManualAuthInput('http://localhost:1455/auth/callback?code=abc&state=wrong', 'expected'), /state mismatch/);
  assert.throws(() => parseManualAuthInput('http://localhost:1455/auth/callback?code=abc', 'expected'), /state mismatch/);
  assert.deepEqual(parseManualAuthInput('http://localhost:1455/auth/callback?code=abc&state=expected', 'expected'), { code: 'abc' });
  assert.deepEqual(parseManualAuthInput('abc', 'expected'), { code: 'abc' });
});

test('TUI accepts pasted API keys and masks the input display', () => {
  const tui = new TUI({ accountManager: new AccountManager([]), config: { accounts: [] } });
  tui.mode = 'input';
  tui._onData('sk-pasted-key');
  assert.equal(tui.inputBuf, 'sk-pasted-key');
  assert.ok(!tui._renderFooter().includes('sk-pasted-key'));
});

test('account reset credits distinguish known zero, unknown and unsupported accounts', () => {
  const accountManager = new AccountManager([{ name: 'oauth', type: 'chatgpt' }, { name: 'api', type: 'apikey' }]);
  const tui = new TUI({ accountManager, config: {} });
  assert.match(tui._renderAcct(0, 8, true), /Resets .*\?/);
  accountManager.accounts[0].usageReset.availableCredits = 0;
  assert.match(tui._renderAcct(0, 8, true), /Resets .*0/);
  accountManager.accounts[0].usageReset.availableCredits = 3;
  assert.match(tui._renderAcct(0, 8, true), /Resets .*3/);
  assert.match(tui._renderAcct(1, 8, true), /Resets .*—/);
});

test('device OAuth exchanges the provider PKCE verifier and rejects missing verifiers', async t => {
  const { deviceCodeLogin } = await import('../src/oauth.js');
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const verifier = 'v'.repeat(64);
  let missing = false;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('/usercode')) return Response.json({ device_auth_id: 'device-id', user_code: 'ABCD-EFGH', interval: 5 });
    if (url.endsWith('/deviceauth/token')) return Response.json({ authorization_code: 'code', ...(missing ? {} : { code_verifier: verifier }) });
    return Response.json({ access_token: 'mock-access', refresh_token: 'mock-refresh' });
  };
  let prompt;
  const credentials = await deviceCodeLogin({ onPrompt: value => { prompt = value; } });
  assert.equal(prompt.userCode, 'ABCD-EFGH');
  assert.equal(credentials.accessToken, 'mock-access');
  const exchange = requests.at(-1);
  assert.equal(exchange.options.body.get('code_verifier'), verifier);
  assert.equal(exchange.options.body.get('redirect_uri'), 'https://auth.openai.com/deviceauth/callback');
  assert.equal(exchange.options.body.get('grant_type'), 'authorization_code');
  missing = true;
  requests.length = 0;
  await assert.rejects(deviceCodeLogin(), { code: 'OAUTH_PKCE_INVALID' });
  assert.equal(requests.length, 2);
});

test('browser OAuth binds the S256 challenge, callback state and token verifier', async t => {
  const { createHash } = await import('node:crypto');
  const { loginOAuth } = await import('../src/oauth.js');
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let challenge;
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith('http://127.0.0.1:')) return original(url, options);
    assert.equal(url, 'https://auth.openai.com/oauth/token');
    const verifier = options.body.get('code_verifier');
    assert.match(verifier, /^[A-Za-z0-9_-]{43,128}$/);
    assert.equal(createHash('sha256').update(verifier).digest('base64url'), challenge);
    assert.equal(options.body.get('code'), 'browser-code');
    return Response.json({ access_token: 'browser-access' });
  };
  const credentials = await loginOAuth({ onAuthorize: async value => {
    const url = new URL(value);
    challenge = url.searchParams.get('code_challenge');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    const response = await fetch(`http://127.0.0.1:1455/auth/callback?code=browser-code&state=${url.searchParams.get('state')}`);
    assert.equal(response.status, 200);
    await response.text();
  } });
  assert.equal(credentials.accessToken, 'browser-access');
});

test('browser callback rejection stays handled while authorization hook is pending', async () => {
  const { loginOAuth } = await import('../src/oauth.js');
  await assert.rejects(loginOAuth({ onAuthorize: async () => {
    const response = await fetch('http://127.0.0.1:1455/auth/callback?code=mock&state=wrong');
    await response.text();
    await new Promise(resolve => setTimeout(resolve, 20));
  } }), { code: 'OAUTH_STATE_MISMATCH' });
});
