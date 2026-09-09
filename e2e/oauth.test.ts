import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { createDefaultConfig } from '@teamcodex/proxy/config';
import { afterEach, test } from 'bun:test';

import { readConfig } from './fixtures.ts';

for (const scenario of ['browser', 'device', 'wrong-state', 'invalid-token', 'missing-verifier', 'api-key']) {
  test(`offline CLI authentication: ${scenario}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'teamcodex oauth '));
    afterEach(() => rm(dir, { recursive: true, force: true }));
    const bin = join(dir, 'bin');
    await mkdir(bin);
    for (const command of ['open', 'xdg-open']) {
      await writeFile(join(bin, command), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    }
    const requests: { path: string | undefined; body: string }[] = [];
    const verifier = 'v'.repeat(64);
    let authorize: URL | undefined;
    let polls = 0;
    const issuer = http.createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      requests.push({ path: req.url, body });
      res.setHeader('Content-Type', 'application/json');
      if (req.url?.endsWith('/usercode')) {
        res.end(JSON.stringify({ device_auth_id: 'mock-device', user_code: 'MOCK-CODE', interval: 5 }));
      } else if (req.url?.endsWith('/deviceauth/token')) {
        polls++;
        if (polls === 1) {
          res.writeHead(403);
          res.end('{}');
        } else {
          res.end(JSON.stringify({ authorization_code: 'mock-code', ...(scenario === 'missing-verifier' ? {} : { code_verifier: verifier }) }));
        }
      } else if (req.url === '/oauth/token') {
        res.end(JSON.stringify(scenario === 'invalid-token' ? {} : { access_token: 'mock-access', refresh_token: 'mock-refresh' }));
      } else {
        res.writeHead(404);
        res.end('{}');
      }
    });
    issuer.listen(0, '127.0.0.1');
    await once(issuer, 'listening');
    afterEach(() => new Promise<void>((resolve, reject) => issuer.close(error => error ? reject(error) : resolve())));
    const address = issuer.address();
    assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    const configPath = join(dir, 'config.json');
    const config = createDefaultConfig();
    await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
    const device = ['device', 'missing-verifier'].includes(scenario);
    const child = spawn(process.env.TEAMCODEX_BUN || 'bun', ['--preload', resolve('e2e/oauth-transport.ts'), resolve('apps/cli/src/index.ts'), 'login', device ? '--device-auth' : scenario === 'api-key' ? '--api' : '--browser', '--name', 'mock'], {
      env: { ...process.env, NODE_OPTIONS: '', TEAMCODEX_CONFIG: configPath, CODEX_HOME: dir, TEAMCODEX_SERVER_URL: origin, MOCK_OAUTH_URL: origin, PATH: `${bin}:${process.env.PATH}` },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    afterEach(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    const exited = once(child, 'exit');
    let output = '';
    let callback: Promise<string> | undefined;
    child.stderr.on('data', chunk => { output += chunk; });
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/https:\/\/auth\.openai\.com\/oauth\/authorize\?[^\s]+/);
      if (!match || authorize) return;
      authorize = new URL(match[0]);
      const state = scenario === 'wrong-state' ? 'wrong' : authorize.searchParams.get('state');
      callback = fetch(`http://127.0.0.1:1455/auth/callback?code=mock-code&state=${state}`).then(res => res.text());
    });
    if (scenario === 'api-key') child.stdin.end('sk-offline-mock\n');
    const [code] = await exited;
    if (callback) await callback;
    const failed = ['wrong-state', 'invalid-token', 'missing-verifier'].includes(scenario);
    assert.equal(code, failed ? 1 : 0, output);
    const saved = await readConfig(configPath);
    assert.equal(saved.accounts.length, failed ? 0 : 1);
    assert.equal((await stat(configPath)).mode & 0o777, 0o600);
    const exchanges = requests.filter(req => req.path === '/oauth/token');
    if (['wrong-state', 'missing-verifier', 'api-key'].includes(scenario)) assert.equal(exchanges.length, 0);
    else {
      assert.equal(exchanges.length, 1);
      const form = new URLSearchParams(exchanges[0]?.body);
      assert.equal(form.get('grant_type'), 'authorization_code');
      assert.equal(form.get('code'), 'mock-code');
      assert.equal(form.get('client_id'), 'app_EMoamEEZ73f0CkXaXp7hrann');
      if (device) {
        assert.equal(form.get('code_verifier'), verifier);
        assert.equal(form.get('redirect_uri'), 'https://auth.openai.com/deviceauth/callback');
        assert.equal(polls, 2);
        assert.deepEqual(JSON.parse(requests.find(req => req.path?.endsWith('/deviceauth/token'))?.body ?? ''), { device_auth_id: 'mock-device', user_code: 'MOCK-CODE' });
      } else {
        assert.ok(authorize);
        const verifier = form.get('code_verifier');
        assert.ok(verifier);
        assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
        assert.equal(form.get('redirect_uri'), authorize.searchParams.get('redirect_uri'));
        assert.equal(createHash('sha256').update(verifier).digest('base64url'), authorize.searchParams.get('code_challenge'));
      }
    }
    if (!failed) {
      assert.equal(saved.accounts[0]?.type, scenario === 'api-key' ? 'apikey' : 'chatgpt');
      assert.equal(saved.accounts[0]?.[scenario === 'api-key' ? 'apiKey' : 'accessToken'], scenario === 'api-key' ? 'sk-offline-mock' : 'mock-access');
    }
  }, 60_000);
}
