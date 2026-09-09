import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import test from 'node:test';

import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

/** @param {import('node:test').TestContext} t @param {http.Server} server */
async function listen(t, server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}

for (const strategy of ['failover', 'weighted-round-robin', 'adaptive']) {
  for (const failure of [503, 429, 401, 'disconnect']) {
    test(`${strategy}: ${failure} retries another pool member with the same payload`, async t => {
      const calls = [];
      const upstream = await listen(t, http.createServer(async (req, res) => {
        let body = '';
        for await (const chunk of req) body += chunk;
        calls.push({ credential: req.headers.authorization, pool: req.headers['x-teamcodex-pool'], body });
        if (failure === 'disconnect' && req.headers.authorization === 'Bearer a') { req.socket.destroy(); return; }
        res.writeHead(req.headers.authorization === 'Bearer a' ? failure : 200, { 'content-type': 'application/json', 'retry-after': '1' });
        res.end('{}');
      }));
      const manager = new AccountManager(['a', 'b', 'outside'].map(name => ({ name, type: 'apikey', apiKey: name, weight: name === 'a' ? 1000 : 1 })), 0.98, {
        defaultPool: 'main', pools: { main: { accounts: ['a', 'b'], strategy } },
      });
      const proxy = await listen(t, createProxyServer(manager, { upstream, apiUpstream: upstream, retry: { maxRetries: 2 }, proxy: {} }));
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

for (const strategy of ['failover', 'weighted-round-robin', 'adaptive']) {
  test(`${strategy}: retry remains isolated when the pool is removed during an attempt`, async t => {
    let manager;
    const calls = [];
    const upstream = await listen(t, http.createServer((req, res) => {
      calls.push(req.headers.authorization);
      manager.routing.pools.main.accounts = [];
      res.writeHead(503);
      res.end('{}');
    }));
    manager = new AccountManager(['a', 'outside'].map(name => ({ name, type: 'apikey', apiKey: name })), 0.98, {
      defaultPool: 'main', pools: { main: { accounts: ['a'], strategy } },
    });
    const proxy = await listen(t, createProxyServer(manager, { upstream, apiUpstream: upstream, proxy: {} }));
    const response = await fetch(`${proxy}/responses`);
    assert.equal(response.status, 429);
    assert.equal((await response.json()).error.code, 'ACCOUNTS_EXHAUSTED');
    assert.deepEqual(calls, ['Bearer a']);
  });
}

test('one-account pool retries within its budget and never borrows an outside account', async t => {
  const calls = [];
  const upstream = await listen(t, http.createServer((req, res) => {
    calls.push(req.headers.authorization);
    res.writeHead(503);
    res.end('{}');
  }));
  const manager = new AccountManager(['a', 'outside'].map(name => ({ name, type: 'apikey', apiKey: name })), 0.98, {
    defaultPool: 'main', pools: { main: { accounts: ['a'], strategy: 'adaptive' } },
  });
  const proxy = await listen(t, createProxyServer(manager, { upstream, apiUpstream: upstream, proxy: {}, retry: { maxRetries: 2 } }));
  const response = await fetch(`${proxy}/responses`);
  await response.text();
  assert.equal(response.status, 503);
  assert.deepEqual(calls, ['Bearer a', 'Bearer a', 'Bearer a']);
  assert.equal(manager.getStatus().accounts[0].adaptive.inFlight, 0);
});

for (const strategy of ['failover', 'weighted-round-robin', 'adaptive']) {
  test(`${strategy}: threshold preference yields to availability and recovers expired quotas`, () => {
    const manager = new AccountManager(['a', 'b'].map(name => ({ name, type: 'apikey', apiKey: name })), 0.98, {
      defaultPool: 'main', pools: { main: { accounts: ['a', 'b'], strategy, switchThreshold: 0.8 } },
    });
    manager.accounts[0].quota.primary = 0.9;
    assert.equal(manager.getActiveAccount().name, 'b');
    manager.accounts[1].enabled = false;
    assert.equal(manager.getActiveAccount().name, 'a');
    manager.accounts[0].quota.primaryReset = Date.now() - 1;
    assert.equal(manager.getActiveAccount().name, 'a');
    assert.equal(manager.accounts[0].quota.primary, null);
  });
}
