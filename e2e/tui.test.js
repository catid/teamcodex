import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import * as pty from 'node-pty';
import { chromium } from 'playwright';

/** Real PTY output, rendered by xterm; no reconstructed dashboard or production mocks. */
test('interactive TUI states with mock requests and review screenshots', { timeout: 60_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'teamcodex-tui-'));
  const artifacts = resolve('artifacts/tui');
  await mkdir(artifacts, { recursive: true });
  /** @type {http.ServerResponse | undefined} */
  let pending;
  let throttle = false;
  let authorize;
  let deviceReady = false;
  let loginKind = 'browser';
  const bin = join(dir, 'bin');
  await mkdir(bin);
  for (const command of ['open', 'xdg-open']) await writeFile(join(bin, command), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const calls = [];
  const upstream = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    if (req.url === '/api/accounts/deviceauth/usercode') {
      res.end(JSON.stringify({ device_auth_id: 'mock-device', user_code: 'TUI-CODE', interval: 5 }));
      return;
    }
    if (req.url === '/api/accounts/deviceauth/token') {
      res.writeHead(deviceReady ? 200 : 403);
      res.end(JSON.stringify(deviceReady ? { authorization_code: 'device-code', code_verifier: 'v'.repeat(64) } : {}));
      return;
    }
    if (req.url === '/oauth/token') {
      const form = new URLSearchParams(raw);
      if (loginKind === 'browser') {
        assert.equal(createHash('sha256').update(form.get('code_verifier')).digest('base64url'), authorize.searchParams.get('code_challenge'));
      } else assert.equal(form.get('code_verifier'), 'v'.repeat(64));
      const token = `e30.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, 'https://api.openai.com/auth': { chatgpt_account_id: `tui-${loginKind}` } })).toString('base64url')}.fake`;
      res.end(JSON.stringify({ access_token: token, refresh_token: 'fake-login-refresh' }));
      return;
    }
    if (req.url === '/backend-api/wham/usage') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ rate_limit: { primary_window: { used_percent: 25, reset_after_seconds: 3600 } }, rate_limit_reset_credits: { available_count: 3 } }));
      return;
    }
    calls.push({ path: req.url, authorization: req.headers.authorization, accountId: req.headers['chatgpt-account-id'] });
    if (throttle) {
      res.writeHead(429, { 'retry-after': '60' });
      res.end('{}');
    } else pending = res;
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const address = upstream.address();
  assert.ok(address && typeof address !== 'string');
  const probe = http.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const proxyAddress = probe.address();
  assert.ok(proxyAddress && typeof proxyAddress !== 'string');
  await new Promise(resolve => probe.close(resolve));
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({
    proxy: { port: proxyAddress.port, host: '127.0.0.1', apiKey: 'fake-proxy' },
    apiUpstream: `http://127.0.0.1:${address.port}`,
    upstream: `http://127.0.0.1:${address.port}`,
    autoReset: { enabled: false },
    accounts: [{ name: 'primary', type: 'apikey', apiKey: 'fake-primary' }, { name: 'oauth-plus', type: 'chatgpt', accountId: 'mock-oauth-account', planType: 'plus', accessToken: 'fake-oauth-access', refreshToken: 'fake-refresh', expiresAt: Date.now() + 3600000 }],
  }), { mode: 0o600 });
  t.after(async () => {
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  t.after(async () => {
    await browser.close();
  });
  const page = await browser.newPage({ viewport: { width: 1200, height: 660 }, deviceScaleFactor: 1 });
  await page.setContent('<html><body style="margin:0;background:#111;padding:16px"><div id="terminal"></div></body></html>');
  await page.addStyleTag({ path: 'node_modules/@xterm/xterm/css/xterm.css' });
  await page.addScriptTag({ path: 'node_modules/@xterm/xterm/lib/xterm.js' });
  await page.evaluate(() => {
    window.terminal = new window.Terminal({ cols: 120, rows: 32, fontSize: 15, fontFamily: 'monospace', theme: { background: '#111111' }, allowProposedApi: true });
    window.terminal.open(document.querySelector('#terminal'));
  });
  const child = pty.spawn(process.execPath, ['src/index.js', 'serve'], {
    name: 'xterm-256color', cols: 120, rows: 32, cwd: process.cwd(),
    env: { ...process.env, TEAMCODEX_CONFIG: configPath, CODEX_HOME: dir, NODE_OPTIONS: `--import=${resolve('e2e/oauth-transport.js')}`, MOCK_OAUTH_URL: `http://127.0.0.1:${address.port}`, PATH: `${bin}:${process.env.PATH}`, TERM: 'xterm-256color' },
  });
  let exited = false;
  const exit = new Promise(resolve => child.onExit(event => { exited = true; resolve(event); }));
  t.after(() => { if (!exited) child.kill(); });
  let writes = Promise.resolve();
  let loginOutput = '';
  child.onData(data => {
    loginOutput += data;
    const match = loginOutput.match(/https:\/\/auth\.openai\.com\/oauth\/authorize\?[^\s]+/);
    if (match && !authorize) authorize = new URL(match[0]);
    writes = writes.then(() => page.evaluate(data => new Promise(resolve => window.terminal.write(data, resolve)), data));
    // Keep asynchronous browser errors visible at the next capture.
    writes.catch(() => {});
  });
  const text = () => page.evaluate(() => {
    const buffer = window.terminal.buffer.active;
    return Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i)?.translateToString(true) ?? '').join('\n');
  });
  /** @param {string} expected */
  const waitFor = async expected => {
    await page.waitForFunction(expected => {
      const b = window.terminal.buffer.active;
      return Array.from({ length: b.length }, (_, i) => b.getLine(i)?.translateToString(true)).join('\n').includes(expected);
    }, expected, { timeout: 10_000 });
  };
  /** @type {string[]} */
  const captures = [];
  /** @param {string} name @param {string} expected */
  const capture = async (name, expected) => {
    await waitFor(expected);
    await writes;
    const screen = await text();
    assert.ok(!screen.includes('fake-pasted-secret'), 'API key must remain masked');
    await page.locator('.xterm-screen').screenshot({ path: join(artifacts, `${name}.png`) });
    await writeFile(join(artifacts, `${name}.txt`), screen);
    captures.push(name);
  };
  await capture('01-dashboard', 'Resets 3');
  assert.match(await text(), /Resets available 3/);
  assert.match(await text(), /Resets —/);
  assert.match(await text(), /API key/);
  child.write('s');
  await capture('02-switch-account', 'select');
  child.write('\x1b');
  child.write('a');
  await capture('03-add-account', 'API key');
  child.write('k');
  await waitFor('API key:');
  child.write('fake-pasted-secret');
  await capture('04-masked-key', '******************');
  child.write('\r');
  await capture('05-account-added', 'api-1');
  const saved = JSON.parse(await readFile(configPath, 'utf8'));
  assert.equal(saved.accounts.at(-1).apiKey, 'fake-pasted-secret');
  child.write('r');
  await capture('06-remove-account', 'select');
  child.write('\x1b');
  const response = fetch(`http://127.0.0.1:${proxyAddress.port}/responses`, { method: 'POST', body: '{}', signal: AbortSignal.timeout(15000) });
  await capture('07-active-request', '1 active');
  assert.ok(pending);
  pending.setHeader('content-type', 'application/json');
  pending.end('{"usage":{"input_tokens":12,"output_tokens":8}}');
  await (await response).text();
  await capture('08-request-complete', '200');
  assert.equal(calls[0].authorization, 'Bearer fake-primary');
  assert.equal(calls[0].accountId, undefined);
  child.write('s');
  await waitFor('Enter switch');
  child.write('j');
  await page.waitForTimeout(50);
  child.write('\r');
  await waitFor('Switched to');
  const oauthResponse = fetch(`http://127.0.0.1:${proxyAddress.port}/backend-api/codex/responses`, { method: 'POST', body: '{}', signal: AbortSignal.timeout(15000) });
  await capture('15-oauth-request', '1 active');
  pending.setHeader('content-type', 'application/json');
  pending.end('{"usage":{"input_tokens":12,"output_tokens":8}}');
  await (await oauthResponse).text();
  assert.deepEqual(calls.at(-1), { path: '/backend-api/codex/responses', authorization: 'Bearer fake-oauth-access', accountId: 'mock-oauth-account' });
  child.write('u');
  await capture('12-pool-account-usage', 'Pools (member account totals)');
  assert.match(await text(), /in 12 \| out 8/);
  child.write('\x1b');
  throttle = true;
  const limited = await fetch(`http://127.0.0.1:${proxyAddress.port}/responses`);
  assert.equal(limited.status, 429);
  await limited.text();
  await capture('09-throttled', 'throttled');
  await page.evaluate(() => { window.terminal.resize(60, 20); window.terminal.clear(); });
  child.resize(60, 20);
  await page.waitForTimeout(600);
  await capture('10-narrow-terminal', 'TeamCodex');
  await page.evaluate(() => { window.terminal.resize(30, 6); window.terminal.clear(); });
  child.resize(30, 6);
  await page.waitForTimeout(600);
  await capture('11-too-small', 'Minimum: 40 x 8');
  const small = await text();
  assert.match(small, /Current: 30 x 6/);
  const smallLines = small.split('\n');
  assert.equal(smallLines[0].trim(), '');
  assert.equal(smallLines[1].indexOf('Terminal too small'), 6);
  assert.equal(smallLines[2].indexOf('Minimum: 40 x 8'), 7);
  assert.ok(!small.split('\n').some(line => line.trim() === ')'));
  await page.evaluate(() => { window.terminal.resize(120, 32); window.terminal.clear(); });
  child.resize(120, 32);
  await capture('13-resize-recovered', 'TeamCodex');
  const disabled = JSON.parse(await readFile(configPath, 'utf8'));
  disabled.accounts[0].enabled = false;
  await writeFile(configPath, JSON.stringify(disabled));
  child.write('R');
  await capture('16-disabled-account', 'disabled');
  const many = JSON.parse(await readFile(configPath, 'utf8'));
  for (let i = 1; i <= 30; i++) many.accounts.push({ name: `extra-${i}`, type: 'apikey', apiKey: `fake-extra-${i}` });
  await writeFile(configPath, JSON.stringify(many));
  child.write('R');
  await waitFor('of 33');
  child.write('s');
  for (let i = 0; i < 33; i++) { child.write('j'); await page.waitForTimeout(15); }
  await capture('14-many-accounts', 'extra-30');
  assert.match(await text(), /Enter switch/);
  child.write('\x1b');
  await waitFor('usage');
  throttle = false;
  child.write('a');
  await waitFor('OAuth browser');
  child.write('o');
  await capture('17-browser-login', 'Paste callback URL');
  assert.ok(authorize);
  const callback = await fetch(`http://127.0.0.1:1455/auth/callback?code=tui-browser&state=${authorize.searchParams.get('state')}`);
  await callback.text();
  await capture('18-browser-login-return', 'of 34');
  assert.ok(JSON.parse(await readFile(configPath, 'utf8')).accounts.some(account => account.accountId === 'tui-browser'));
  loginKind = 'device';
  child.write('a');
  await waitFor('OAuth browser');
  child.write('d');
  await capture('19-device-login', 'TUI-CODE');
  deviceReady = true;
  await capture('20-device-login-return', 'of 35');
  assert.ok(JSON.parse(await readFile(configPath, 'utf8')).accounts.some(account => account.accountId === 'tui-device'));
  child.write('q');
  const result = await exit;
  assert.equal(result.exitCode, 0);
  await writeFile(join(artifacts, 'index.html'), `<!doctype html><title>TeamCodex TUI review</title><style>body{background:#222;color:#eee;font:16px sans-serif}img{max-width:100%}section{margin:32px}</style><h1>TeamCodex TUI mock E2E</h1>${captures.map(name => `<section><h2>${name}</h2><img src="${name}.png"><p><a href="${name}.txt">Terminal text</a></p></section>`).join('')}`);
});
