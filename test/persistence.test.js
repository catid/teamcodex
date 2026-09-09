import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

for (const changed of ['disk-identity', 'disk-access-token', 'host-login', 'matching-login', 'imported-login']) {
  test(`refresh persistence handles ${changed}`, { timeout: 10_000 }, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'teamcodex-persistence-'));
    let child, exited, upstream;
    t.after(async () => {
      if (child) {
        if (child.exitCode === null && child.signalCode === null) child.kill();
        await exited;
      }
      upstream?.closeAllConnections();
      upstream?.close();
      await rm(dir, { recursive: true, force: true });
    });
    const configPath = join(dir, 'config.json');
    const authPath = join(dir, 'auth.json');
    const original = { name: 'same-name', type: 'chatgpt', accountId: 'old-id', accessToken: `e30.${Buffer.from('{"exp":1}').toString('base64url')}.fake`, refreshToken: 'old-refresh', expiresAt: 1 };
    const replacement = { ...original, accountId: changed === 'disk-identity' ? 'new-id' : 'old-id', accessToken: 'new-login', expiresAt: Date.now() + 3600_000 };
    // A replacement login need not have a refresh token; absence is not permission to overwrite it.
    if (changed === 'disk-identity') delete replacement.refreshToken;
    const hostLogin = { tokens: { account_id: 'old-id', access_token: 'new-host-access', refresh_token: 'new-host-refresh' } };
    const matching = ['matching-login', 'imported-login'].includes(changed);
    if (matching) Object.assign(hostLogin.tokens, { access_token: original.accessToken, refresh_token: original.refreshToken });
    await writeFile(authPath, JSON.stringify(hostLogin));
    const { promise: polled, resolve: finish } = Promise.withResolvers();
    let config;
    upstream = http.createServer(async (req, res) => {
      await req.toArray();
      if (req.url === '/oauth/token') {
        if (changed.startsWith('disk-')) await writeFile(configPath, JSON.stringify({ ...config, accounts: [replacement] }));
        res.end(JSON.stringify({ access_token: 'refreshed-old-access', refresh_token: 'refreshed-old-refresh' }));
      } else {
        res.end(JSON.stringify({ rate_limit: { primary_window: { used_percent: 0 } } }));
        finish();
      }
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const base = `http://127.0.0.1:${upstream.address().port}`;
    config = { proxy: { host: '127.0.0.1', port: 1456, apiKey: 'fake-proxy' }, accounts: [original], upstream: base, autoReset: { enabled: false } };
    if (changed === 'imported-login') config.accounts = [{ name: original.name, type: 'chatgpt', importFrom: authPath }];
    await writeFile(configPath, JSON.stringify(config));
    const transport = join(dir, 'transport.mjs');
    await writeFile(transport, `const original = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const url = new URL(input);
  if (url.origin === 'https://auth.openai.com') return original(new URL(url.pathname, ${JSON.stringify(base)}), options);
  if (url.origin !== ${JSON.stringify(base)}) throw new Error('Unexpected test destination');
  return original(input, options);
};\n`);
    child = spawn(process.execPath, ['--import', transport, resolve('src/index.js'), 'serve'], {
      env: { ...process.env, TEAMCODEX_CONFIG: configPath, CODEX_HOME: dir, TEAMCODEX_LISTEN_HOST: '127.0.0.1', TEAMCODEX_LISTEN_PORT: '0', NODE_OPTIONS: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    exited = once(child, 'exit');
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    await Promise.race([polled, exited.then(() => { throw new Error(output); })]);
    const saved = JSON.parse(await readFile(configPath, 'utf8'));
    if (changed === 'host-login' || matching) assert.equal(saved.accounts[0].accessToken, 'refreshed-old-access');
    else assert.deepEqual(saved.accounts[0], replacement);
    const savedAuth = JSON.parse(await readFile(authPath, 'utf8'));
    if (matching) {
      assert.equal(savedAuth.tokens.access_token, 'refreshed-old-access');
      assert.equal(savedAuth.tokens.refresh_token, 'refreshed-old-refresh');
      assert.equal(savedAuth.tokens.account_id, 'old-id');
    } else assert.deepEqual(savedAuth, hostLogin);
  });
}
