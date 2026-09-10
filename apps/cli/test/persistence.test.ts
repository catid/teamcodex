import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { AccountConfig, Config } from '@teamcodex/core/config';
import { isRecord, validateConfig } from '@teamcodex/core/config';
import { mkdtemp, readFile, rm, writeFile } from '@teamcodex/shared/filesystem';
import { afterEach, test } from 'bun:test';

for (const changed of ['disk-identity', 'disk-access-token', 'host-login', 'matching-login', 'imported-login']) {
  test(`refresh persistence handles ${changed}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'teamcodex-persistence-'));
    const configPath = join(dir, 'config.json');
    const authPath = join(dir, 'auth.json');
    const original: AccountConfig = { name: 'same-name', type: 'chatgpt', accountId: 'old-id', accessToken: `e30.${Buffer.from('{"exp":1}').toString('base64url')}.fake`, refreshToken: 'old-refresh', expiresAt: 1 };
    const replacement = { ...original, accountId: changed === 'disk-identity' ? 'new-id' : 'old-id', accessToken: 'new-login', expiresAt: Date.now() + 3600_000 };
    // A replacement login need not have a refresh token; absence is not permission to overwrite it.
    if (changed === 'disk-identity') delete replacement.refreshToken;
    const hostLogin = { tokens: { account_id: 'old-id', access_token: 'new-host-access', refresh_token: 'new-host-refresh' } };
    const matching = ['matching-login', 'imported-login'].includes(changed);
    if (matching) Object.assign(hostLogin.tokens, { access_token: original.accessToken, refresh_token: original.refreshToken });
    await writeFile(authPath, JSON.stringify(hostLogin));
    const { promise: polled, resolve: finish } = Promise.withResolvers<void>();
    const upstream = http.createServer(async (req, res) => {
      for await (const chunk of req) { void chunk; }
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
    const address = upstream.address(); assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    const config: Config = { proxy: { host: '127.0.0.1', port: 1456, apiKey: 'fake-proxy' }, accounts: [original], upstream: base, autoReset: { enabled: false } };
    if (changed === 'imported-login') config.accounts = [{ name: original.name, type: 'chatgpt', importFrom: authPath }];
    await writeFile(configPath, JSON.stringify(config));
    const transport = join(dir, 'transport.ts');
    await writeFile(transport, `const original = globalThis.fetch;
globalThis.fetch = Object.assign((input: Parameters<typeof fetch>[0], options?: RequestInit) => {
  const url = new URL(String(input));
  if (url.origin === 'https://auth.openai.com') return original(new URL(url.pathname, ${JSON.stringify(base)}), options);
  if (url.origin !== ${JSON.stringify(base)}) throw new Error('Unexpected test destination');
  return original(input, options);
}, { preconnect: original.preconnect });\n`);
    const child = spawn(process.execPath, ['--preload', transport, resolve('apps/cli/src/index.ts'), 'serve'], {
      env: { ...process.env, TEAMCODEX_CONFIG: configPath, CODEX_HOME: dir, TEAMCODEX_LISTEN_HOST: '127.0.0.1', TEAMCODEX_LISTEN_PORT: '0', NODE_OPTIONS: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exited = once(child, 'exit');
    afterEach(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
      await new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()));
      await rm(dir, { recursive: true, force: true });
    });
    let output = '';
    assert.ok(child.stdout && child.stderr);
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    await Promise.race([polled, exited.then(() => { throw new Error(output); })]);
    const saved: unknown = JSON.parse(await readFile(configPath, 'utf8'));
    validateConfig(saved);
    if (changed === 'host-login' || matching) assert.equal(saved.accounts[0]?.accessToken, 'refreshed-old-access');
    else assert.deepEqual(saved.accounts[0], replacement);
    const savedAuth: unknown = JSON.parse(await readFile(authPath, 'utf8'));
    assert.ok(isRecord(savedAuth) && isRecord(savedAuth.tokens));
    if (matching) {
      assert.equal(savedAuth.tokens.access_token, 'refreshed-old-access');
      assert.equal(savedAuth.tokens.refresh_token, 'refreshed-old-refresh');
      assert.equal(savedAuth.tokens.account_id, 'old-id');
    } else assert.deepEqual(savedAuth, hostLogin);
  }, 10_000);
}
