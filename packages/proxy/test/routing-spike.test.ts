import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';

import type { Config } from '@teamcodex/core/config';
import { afterEach, test } from 'bun:test';

import { AccountManager } from '../src/account-manager.ts';
import { createProxyServer } from '../src/http/server.ts';

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) =>
    server.close(error => error ? reject(error) : resolve()))));
});
const config = (overrides: Partial<Config>): Config => ({ accounts: [], proxy: { port: 1456, apiKey: 'fake' }, ...overrides });

async function listen(server: http.Server): Promise<string> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  servers.push(server);
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

for (const strategy of ['failover', 'weighted-round-robin', 'adaptive'] as const) {
  for (const failure of [503, 429, 401, 'disconnect']) {
    test(`${strategy}: ${failure} retries another pool member with the same payload`, async () => {
      const calls: { credential: string | undefined; pool: string | string[] | undefined; body: string }[] = [];
      const upstream = await listen( http.createServer(async (req, res) => {
        let body = '';
        for await (const chunk of req) body += chunk;
        calls.push({ credential: req.headers.authorization, pool: req.headers['x-teamcodex-pool'], body });
        if (failure === 'disconnect' && req.headers.authorization === 'Bearer a') { req.socket.destroy(); return; }
        res.writeHead(req.headers.authorization === 'Bearer a' && typeof failure === 'number' ? failure : 200, { 'content-type': 'application/json', 'retry-after': '1' });
        res.end('{}');
      }));
      const manager = new AccountManager(['a', 'b', 'outside'].map(name => ({ name, type: 'apikey', apiKey: name, weight: name === 'a' ? 1000 : 1 })), 0.98, {
        defaultPool: 'main', pools: { main: { accounts: ['a', 'b'], strategy } },
      });
      const proxy = await listen( createProxyServer(manager, config({ upstream, apiUpstream: upstream, retry: { maxRetries: 2 } })));
      const payload = JSON.stringify({ input: 'literal mock request', stream: false });
      const response = await fetch(`${proxy}/v1/responses`, { method: 'POST', headers: { 'x-teamcodex-pool': 'main' }, body: payload });
      await response.text();
      assert.equal(response.status, 200);
      assert.deepEqual(calls.map(call => call.credential), ['Bearer a', 'Bearer b']);
      assert.ok(calls.every(call => call.body === payload && call.pool === undefined));
      assert.ok(manager.getStatus().accounts.every(account => account.adaptive.inFlight === 0));
    });
  }
}

for (const strategy of ['failover', 'weighted-round-robin', 'adaptive'] as const) {
  test(`${strategy}: retry remains isolated when the pool is removed during an attempt`, async () => {
    const calls: (string | undefined)[] = [];
    const upstream = await listen( http.createServer((req, res) => {
      calls.push(req.headers.authorization);
      const pool = manager.routing?.pools.main;
      assert.ok(pool);
      pool.accounts = [];
      res.writeHead(503);
      res.end('{}');
    }));
    const manager = new AccountManager(['a', 'outside'].map(name => ({ name, type: 'apikey', apiKey: name })), 0.98, {
      defaultPool: 'main', pools: { main: { accounts: ['a'], strategy } },
    });
    const proxy = await listen( createProxyServer(manager, config({ upstream, apiUpstream: upstream })));
    const response = await fetch(`${proxy}/responses`);
    assert.equal(response.status, 429);
    assert.match(await response.text(), /ACCOUNTS_EXHAUSTED/);
    assert.deepEqual(calls, ['Bearer a']);
  });
}

test('one-account pool retries within its budget and never borrows an outside account', async () => {
  const calls: (string | undefined)[] = [];
  const upstream = await listen( http.createServer((req, res) => {
    calls.push(req.headers.authorization);
    res.writeHead(503);
    res.end('{}');
  }));
  const manager = new AccountManager(['a', 'outside'].map(name => ({ name, type: 'apikey', apiKey: name })), 0.98, {
    defaultPool: 'main', pools: { main: { accounts: ['a'], strategy: 'adaptive' } },
  });
  const proxy = await listen( createProxyServer(manager, config({ upstream, apiUpstream: upstream, retry: { maxRetries: 2 } })));
  const response = await fetch(`${proxy}/responses`);
  await response.text();
  assert.equal(response.status, 503);
  assert.deepEqual(calls, ['Bearer a', 'Bearer a', 'Bearer a']);
  assert.equal(manager.getStatus().accounts[0]?.adaptive.inFlight, 0);
});

for (const strategy of ['failover', 'weighted-round-robin', 'adaptive'] as const) {
  test(`${strategy}: threshold preference yields to availability and recovers expired quotas`, () => {
    const manager = new AccountManager(['a', 'b'].map(name => ({ name, type: 'apikey', apiKey: name })), 0.98, {
      defaultPool: 'main', pools: { main: { accounts: ['a', 'b'], strategy, switchThreshold: 0.8 } },
    });
    const first = manager.accounts[0];
    const second = manager.accounts[1];
    assert.ok(first && second);
    first.quota.primary = 0.9;
    assert.equal(manager.getActiveAccount()?.name, 'b');
    second.enabled = false;
    assert.equal(manager.getActiveAccount()?.name, 'a');
    first.quota.primaryReset = Date.now() - 1;
    assert.equal(manager.getActiveAccount()?.name, 'a');
    assert.equal(first.quota.primary, null);
  });
}
