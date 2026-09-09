import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { AccountManager } from '../src/account-manager.js';
import { atomicConfigUpdate, createDefaultConfig, loadConfig, saveConfig } from '../src/config.js';
import { UsageResetMonitor } from '../src/usage-reset.js';

const payload = (id, used = 100, credits = 2) => ({ account_id: id,
  rate_limit: { primary_window: { used_percent: used } },
  rate_limit_reset_credits: { available_count: credits },
});

/** Real HTTP transport and config transactions; mock time and provider responses.
 * @param {import('node:test').TestContext} t
 */
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'teamcodex-reset-spike-'));
  const previous = process.env.TEAMCODEX_CONFIG;
  process.env.TEAMCODEX_CONFIG = join(dir, 'config.json');
  let now = Date.now();
  const calls = [];
  const handlers = {
    usage: id => payload(id),
    consume: () => ({ code: 'reset' }),
  };
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const call = { path: req.url, method: req.method, id: req.headers['chatgpt-account-id'], authorization: req.headers.authorization, body: raw ? JSON.parse(raw) : null };
    calls.push(call);
    const result = req.method === 'POST' ? await handlers.consume(call, res) : await handlers.usage(call.id, res);
    if (res.destroyed || res.writableEnded) return;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(result));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const config = { ...createDefaultConfig(), upstream: `http://127.0.0.1:${server.address().port}`,
    accounts: ['a', 'b'].map(name => ({ name, accountId: name, type: 'chatgpt', accessToken: `fake-${name}` })),
  };
  await saveConfig(config);
  const manager = new AccountManager(config.accounts);
  const monitors = [];
  const create = (owner = manager, overrides = {}) => {
    const monitor = new UsageResetMonitor(owner, config, { now: () => now, wait: async () => {}, ...overrides });
    monitors.push(monitor);
    return monitor;
  };
  t.after(async () => {
    monitors.forEach(monitor => monitor.stop());
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    if (previous === undefined) delete process.env.TEAMCODEX_CONFIG;
    else process.env.TEAMCODEX_CONFIG = previous;
    await rm(dir, { recursive: true, force: true });
  });
  return { manager, config, calls, handlers, create, monitor: create(),
    advance: milliseconds => { now += milliseconds; },
    posts: () => calls.filter(call => call.method === 'POST'),
    state: async () => (await loadConfig()).usageResetState,
  };
}

test('HTTP usage tagged with another account cannot reserve or spend credits', async t => {
  const f = await fixture(t);
  f.handlers.usage = () => payload('wrong-account');
  await f.monitor.check();
  assert.equal(f.posts().length, 0);
  assert.equal(await f.state(), undefined);
  assert.ok(f.manager.accounts.every(account => account.quota.primary === null));
});

test('disabling an account during a failed consume prevents subsequent wire retries', async t => {
  const f = await fixture(t);
  f.handlers.consume = (_call, response) => {
    f.manager.accounts[0].enabled = false;
    response.statusCode = 503;
    return {};
  };
  await f.monitor.checkAccount(f.manager.accounts[0]);
  assert.equal(f.posts().length, 1);
  assert.ok((await f.state())['chatgpt:a'].pendingRequestId);
});

for (const outcome of ['reset', 'no_credit']) {
  test(`${outcome}: response from replaced credentials cannot modify live account metrics`, async t => {
    const f = await fixture(t);
    const account = f.manager.accounts[0];
    f.handlers.consume = async () => {
      account.credential = 'replacement-token';
      account.quota.primary = 0.42;
      account.usageReset.availableCredits = 7;
      await atomicConfigUpdate(config => { config.accounts[0].accessToken = account.credential; });
      return { code: outcome };
    };
    await f.monitor.checkAccount(account);
    assert.equal(account.quota.primary, 0.42);
    assert.equal(account.usageReset.availableCredits, 7);
    assert.ok((await f.state())['chatgpt:a'].pendingRequestId);
    assert.equal(f.calls.filter(call => call.method === 'GET').length, 1);
  });
}

for (const failure of ['disconnect', '503', 'invalid-json']) {
  test(`${failure}: uncertain HTTP redemption survives restart with exactly one logical spend`, async t => {
    const f = await fixture(t);
    let attempts = 0;
    const spent = new Set();
    f.handlers.consume = (call, response) => {
      attempts++;
      spent.add(call.body.redeem_request_id);
      if (failure === 'disconnect') response.destroy();
      else if (failure === '503') response.statusCode = 503;
      else { response.end('{broken'); }
      return {};
    };
    await f.monitor.checkAccount(f.manager.accounts[0]);
    const id = (await f.state())['chatgpt:a'].pendingRequestId;
    assert.ok(id);
    assert.equal(attempts, failure === 'invalid-json' ? 1 : 3);
    f.advance(60_001);
    f.handlers.usage = id => payload(id, 0, 0);
    f.handlers.consume = call => { spent.add(call.body.redeem_request_id); return { code: 'already_redeemed' }; };
    const disk = await loadConfig();
    const manager = new AccountManager(disk.accounts);
    await f.create(manager).checkAccount(manager.accounts[0]);
    assert.deepEqual([...spent], [id]);
    assert.equal(f.posts().at(-1).body.redeem_request_id, id);
    assert.equal((await f.state())['chatgpt:a'].pendingRequestId, undefined);
    assert.equal((await f.state())['chatgpt:a'].lastResult, 'completed');
  });
}

test('concurrent monitors spend once per qualifying account despite overlapping weighted pools', async t => {
  const f = await fixture(t);
  f.config.routing = { defaultPool: 'main', pools: { main: { accounts: ['a', 'b'], strategy: 'adaptive' }, shared: { accounts: ['a'], strategy: 'weighted-round-robin' } } };
  f.config.accounts[0].weight = 1000;
  await saveConfig(f.config);
  f.handlers.usage = id => payload(id, id === 'a' ? 100 : 1);
  const other = new AccountManager(f.config.accounts, 0.01, f.config.routing);
  other.accounts[1].usage.totalInputTokens = 1e12;
  await Promise.all([f.monitor.check(), f.create(other).check(), f.monitor.check()]);
  assert.equal(f.posts().length, 1);
  assert.equal(f.posts()[0].id, 'a');
  assert.equal(f.posts()[0].authorization, 'Bearer fake-a');
  assert.deepEqual(Object.keys(await f.state()), ['chatgpt:a']);
});

test('the reservation is durable before the provider receives any consume request', async t => {
  const f = await fixture(t);
  let verified = false;
  f.handlers.consume = async call => {
    const disk = JSON.parse(await readFile(process.env.TEAMCODEX_CONFIG, 'utf8'));
    assert.equal(disk.usageResetState[`chatgpt:${call.id}`].pendingRequestId, call.body.redeem_request_id);
    verified = true;
    return { code: 'nothing_to_reset' };
  };
  await f.monitor.checkAccount(f.manager.accounts[0]);
  assert.ok(verified);
  assert.equal((await f.state())['chatgpt:a'].pendingRequestId, undefined);
});

for (const outcome of ['reset', 'already_redeemed', 'no_credit', 'nothing_to_reset']) {
  test(`${outcome}: settled response prevents another spend during cooldown`, async t => {
    const f = await fixture(t);
    f.handlers.consume = () => ({ code: outcome });
    await f.monitor.checkAccount(f.manager.accounts[0]);
    f.advance(3_599_999);
    await f.monitor.checkAccount(f.manager.accounts[0]);
    assert.equal(f.posts().length, 1);
    assert.equal((await f.state())['chatgpt:a'].pendingRequestId, undefined);
    f.advance(2);
    await f.monitor.checkAccount(f.manager.accounts[0]);
    assert.equal(f.posts().length, 2);
    assert.notEqual(f.posts()[0].body.redeem_request_id, f.posts()[1].body.redeem_request_id);
  });
}

for (const response of ['oversized', 'unavailable', 'malformed', 'missing-account-id']) {
  test(`${response}: usage boundary handles untrusted HTTP payloads`, async t => {
    const f = await fixture(t);
    f.handlers.usage = (id, res) => {
      if (response === 'oversized') return { ...payload(id), padding: 'x'.repeat(1024 * 1024) };
      if (response === 'unavailable') return { ...payload(id), available: false };
      if (response === 'malformed') { res.end('{broken'); return; }
      const value = payload(id);
      delete value.account_id;
      return value;
    };
    await f.monitor.checkAccount(f.manager.accounts[0]);
    // Older provider responses may omit identity; supplied identity must match.
    assert.equal(f.posts().length, response === 'missing-account-id' ? 1 : 0);
  });
}

test('shutdown during retry retains pending ID and prevents another POST', async t => {
  const f = await fixture(t);
  const monitor = f.create(f.manager, { wait: async () => monitor.stop() });
  f.handlers.consume = (_call, res) => { res.statusCode = 503; return {}; };
  await monitor.checkAccount(f.manager.accounts[0]);
  assert.equal(f.posts().length, 1);
  assert.ok((await f.state())['chatgpt:a'].pendingRequestId);
});

test('wrong-account verification keeps the original pending ID until a valid retry', async t => {
  const f = await fixture(t);
  let posted = false;
  f.handlers.consume = () => { posted = true; return { code: 'reset' }; };
  f.handlers.usage = id => payload(posted ? 'another-account' : id, posted ? 0 : 100);
  const account = f.manager.accounts[0];
  account.status = 'throttled';
  account.rateLimitedUntil = Date.now() + 3_600_000;
  await f.monitor.checkAccount(account);
  const before = (await f.state())['chatgpt:a'];
  assert.ok(before.pendingRequestId);
  assert.equal(before.lastResult, 'refresh_failed');
  assert.equal(account.status, 'throttled');
  f.advance(60_001);
  f.handlers.usage = id => payload(id, 0, 0);
  f.handlers.consume = () => ({ code: 'already_redeemed' });
  await f.monitor.checkAccount(account);
  assert.equal(f.posts()[1].body.redeem_request_id, before.pendingRequestId);
  assert.equal((await f.state())['chatgpt:a'].lastResult, 'completed');
  assert.equal(account.status, 'active');
});

test('failed config reservation never reaches the local consume endpoint', async t => {
  const f = await fixture(t);
  const monitor = f.create(f.manager, { updateConfig: async () => { throw new Error('mock disk full'); } });
  await assert.rejects(monitor.checkAccount(f.manager.accounts[0]), /mock disk full/);
  assert.equal(f.posts().length, 0);
  assert.equal(await f.state(), undefined);
});
