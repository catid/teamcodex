import assert from 'node:assert/strict';
import { mkdtemp, readFile,rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { AccountManager } from '../src/account-manager.js';
import { atomicConfigUpdate, createDefaultConfig, loadConfig, resetConfig,saveConfig } from '../src/config.js';
import { normalizeUsage,UsageResetMonitor } from '../src/usage-reset.js';

const json = payload => globalThis.Response.json(payload);
const usage = (percent = 100, credits = 2) => ({
  rate_limit: { primary_window: { used_percent: percent, limit_window_seconds: 18000 }, secondary_window: { used_percent: 0, limit_window_seconds: 604800 } },
  ...(credits === null ? {} : { rate_limit_reset_credits: { available_count: credits } }),
});
const account = (id = 'account-1') => ({ name: id, accountId: id, type: 'chatgpt', accessToken: `secret-${id}` });

async function fixture(t, overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'teamcodex-resets-'));
  const path = join(dir, 'config.json');
  const oldPath = process.env.TEAMCODEX_CONFIG;
  process.env.TEAMCODEX_CONFIG = path;
  t.after(async () => {
    if (oldPath === undefined) delete process.env.TEAMCODEX_CONFIG;
    else process.env.TEAMCODEX_CONFIG = oldPath;
    await rm(dir, { recursive: true, force: true });
  });
  const config = { ...createDefaultConfig(), accounts: [account()], ...overrides };
  await saveConfig(config);
  const manager = new AccountManager(config.accounts);
  let now = Date.now();
  const requests = [];
  let getResponse = () => json(usage());
  let postResponse = () => json({ code: 'reset' });
  const fetchFn = async (url, init) => {
    requests.push({ url, ...init });
    return init.method === 'POST' ? postResponse(url, init) : getResponse(url, init);
  };
  const monitor = new UsageResetMonitor(manager, config, { fetchFn, wait: async () => {}, now: () => now });
  t.after(() => monitor.stop());
  return {
    config, manager, monitor, requests, path, fetchFn,
    now: () => now,
    advance: ms => { now += ms; },
    get: fn => { getResponse = fn; },
    post: fn => { postResponse = fn; },
    posts: () => requests.filter(r => r.method === 'POST'),
    state: async () => (await loadConfig()).usageResetState?.['chatgpt:account-1'],
  };
}

test('usage normalizes real credit fields and preserves unknown versus zero', () => {
  assert.equal(normalizeUsage(usage(98, 2)).resetCreditsAvailable, 2);
  assert.equal(normalizeUsage(usage(98, 0)).resetCreditsAvailable, 0);
  assert.equal(normalizeUsage(usage(98, null)).resetCreditsAvailable, null);
  assert.equal(normalizeUsage(usage(98, '2')).resetCreditsAvailable, null);
  assert.equal(normalizeUsage(usage(98)).utilization, 0.98);
  assert.throws(() => normalizeUsage({}), /invalid_usage_response/);
  assert.throws(() => normalizeUsage({ rate_limit: { primary_window: { used_percent: 101 } } }), /invalid_usage_response/);
});

test('automatic reset at the threshold uses the upstream contract and verifies new usage', async t => {
  const f = await fixture(t);
  let reads = 0;
  f.get(() => json(usage(++reads === 1 ? 98 : 0, reads === 1 ? 2 : 1)));
  f.manager.markRateLimited(0, 3600);
  await f.monitor.check();
  const [request] = f.posts();
  assert.equal(f.posts().length, 1);
  assert.equal(request.url, 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume');
  assert.equal(request.headers.authorization, 'Bearer secret-account-1');
  assert.equal(request.headers['chatgpt-account-id'], 'account-1');
  assert.match(JSON.parse(request.body).redeem_request_id, /^[a-f0-9-]{36}$/);
  assert.equal(f.manager.accounts[0].status, 'active');
  assert.equal(f.manager.accounts[0].quota.primary, 0);
  assert.equal(f.manager.accounts[0].usage.totalRequests, 0);
  assert.equal(f.manager.accounts[0].usageReset.availableCredits, 1);
  assert.equal((await f.state()).lastResult, 'completed');
  assert.equal((await f.state()).pendingRequestId, undefined);
  assert.ok(!JSON.stringify(f.manager.getStatus()).includes('secret-account-1'));
});

for (const [name, percent, credits] of [['below threshold', 97.99, 2], ['no credits', 100, 0], ['unknown credits', 100, null]]) {
  test(`automatic redemption skips ${name}`, async t => {
    const f = await fixture(t);
    f.get(() => json(usage(percent, credits)));
    await f.monitor.check();
    assert.equal(f.posts().length, 0);
  });
}

test('disabled policy still refreshes usage without redeeming credits', async t => {
  const f = await fixture(t, { autoReset: { enabled: false } });
  await f.monitor.check();
  assert.equal(f.posts().length, 0);
  assert.equal(f.manager.accounts[0].quota.primary, 1);
});

test('API accounts and ChatGPT accounts without a stable identity never redeem credits', async t => {
  const f = await fixture(t, { accounts: [{ name: 'api', type: 'apikey', apiKey: 'secret' }, { name: 'unknown-id', type: 'chatgpt', accessToken: 'opaque' }] });
  await f.monitor.check();
  assert.equal(f.posts().length, 0);
  assert.equal(f.requests.length, 1);
});

test('all ChatGPT accounts, including inactive ones, are checked for available resets', async t => {
  const f = await fixture(t, { accounts: [account(), account('account-2')] });
  await f.monitor.check();
  assert.deepEqual(f.posts().map(r => r.headers['chatgpt-account-id']).sort(), ['account-1', 'account-2']);
});

for (const outcome of ['no_credit', 'nothing_to_reset']) {
  test(`${outcome} is an unsuccessful outcome and still starts a cooldown`, async t => {
    const f = await fixture(t);
    f.post(() => json({ code: outcome }));
    await f.monitor.check();
    await f.monitor.check();
    assert.equal(f.posts().length, 1);
    assert.equal((await f.state()).lastResult, outcome);
    assert.equal((await f.state()).pendingRequestId, undefined);
    assert.equal((await f.state()).lastCompletedAt, undefined);
  });
}

test('uncertain outcome retains its ID across restarts even after credits and usage drop to zero', async t => {
  const f = await fixture(t);
  f.post(() => { throw new Error('lost response with secret-account-1'); });
  await f.monitor.check();
  const pendingId = (await f.state()).pendingRequestId;
  assert.equal((await f.state()).lastResult, 'provider_unavailable');
  assert.ok(!(await readFile(f.path, 'utf8')).includes('lost response'));
  f.advance(3_600_001);
  f.get(() => json(usage(0, 0)));
  f.post(() => json({ code: 'already_redeemed' }));
  const restarted = new UsageResetMonitor(f.manager, await loadConfig(), { fetchFn: f.fetchFn, now: f.now });
  await restarted.check();
  assert.equal(JSON.parse(f.posts().at(-1).body).redeem_request_id, pendingId);
  assert.equal((await f.state()).lastResult, 'completed');
  assert.equal((await f.state()).pendingRequestId, undefined);
});

for (const failure of ['http', 'unknown', 'usage-refresh']) {
  test(`${failure} failure retains the logical redemption until it can be verified`, async t => {
    const f = await fixture(t);
    let posted = false;
    f.post(() => {
      posted = true;
      return failure === 'http' ? new globalThis.Response('', { status: 503 }) : json({ code: failure === 'unknown' ? 'unexpected' : 'reset' });
    });
    f.get(() => failure === 'usage-refresh' && posted ? new globalThis.Response('', { status: 503 }) : json(usage()));
    await f.monitor.check();
    const before = await f.state();
    assert.ok(before.pendingRequestId);
    assert.notEqual(before.lastResult, 'completed');
    f.advance(3_600_001);
    f.post(() => json({ code: 'already_redeemed' }));
    f.get(() => json(usage(0)));
    await f.monitor.check();
    assert.equal(JSON.parse(f.posts().at(-1).body).redeem_request_id, before.pendingRequestId);
    assert.equal((await f.state()).lastResult, 'completed');
  });
}

test('a provider reset that leaves usage exhausted does not reactivate a throttled account', async t => {
  const f = await fixture(t);
  f.manager.markRateLimited(0, 3600);
  await f.monitor.check();
  assert.equal(f.manager.accounts[0].status, 'throttled');
  await f.monitor.check();
  assert.equal(f.posts().length, 1);
});

test('two monitors cannot spend two credits concurrently for the same account', async t => {
  const f = await fixture(t);
  const second = new UsageResetMonitor(new AccountManager(f.config.accounts), f.config, { fetchFn: f.fetchFn, now: f.now });
  await Promise.all([f.monitor.check(), f.monitor.check(), second.check()]);
  assert.equal(f.posts().length, 1);
});

test('state persistence failure prevents the upstream POST', async t => {
  const f = await fixture(t);
  const monitor = new UsageResetMonitor(f.manager, f.config, { fetchFn: f.fetchFn, updateConfig: async () => { throw new Error('disk full'); } });
  await assert.rejects(monitor.check(), /disk full/);
  assert.equal(f.posts().length, 0);
});

test('stale or future-dated observations cannot initiate new redemptions', async t => {
  const f = await fixture(t);
  for (const timestamp of [f.now() - 600_001, f.now() + 1000]) {
    const snapshot = await f.monitor.readUsage(f.manager.accounts[0]);
    snapshot.fetchedAt = timestamp;
    assert.equal(await f.monitor.reserve(f.manager.accounts[0], snapshot), null);
  }
});

test('installation reset retains pending IDs and cooldown timestamps', async t => {
  const f = await fixture(t);
  f.post(() => { throw new Error('lost response'); });
  await f.monitor.check();
  const before = await f.state();
  await resetConfig();
  assert.deepEqual(await f.state(), before);
  const monitor = new UsageResetMonitor(f.manager, await loadConfig(), { fetchFn: f.fetchFn, now: f.now });
  await monitor.check();
  assert.equal(f.posts().length, 1);
});

test('account changes during a usage request discard the old account snapshot', async t => {
  const f = await fixture(t);
  let finish, started;
  const began = new Promise(resolve => { started = resolve; });
  f.get(() => { started(); return new Promise(resolve => { finish = resolve; }); });
  const pending = f.monitor.check();
  await began;
  f.manager.accounts[0].accountId = 'replacement';
  f.manager.accounts[0].credential = 'replacement-token';
  finish(json(usage()));
  await pending;
  assert.equal(f.posts().length, 0);
  assert.equal(f.manager.accounts[0].quota.primary, null);
});

test('reset settings and corrupt pending IDs are rejected before any usage mutation', async t => {
  await fixture(t);
  await assert.rejects(atomicConfigUpdate(c => { c.autoReset.threshold = 0; }), /autoReset/);
  await assert.rejects(atomicConfigUpdate(c => { c.autoReset.pollIntervalSeconds = 1; }), /autoReset/);
  await assert.rejects(atomicConfigUpdate(c => { c.usageResetState = { bad: { pendingRequestId: 'broken' } }; }), /usageResetState/);
});

test('transient redemption retries use the same ID and complete after a lost response', async t => {
  const f = await fixture(t);
  let attempts = 0;
  f.post(() => {
    if (++attempts === 1) throw new TypeError('fetch failed');
    return json({ code: 'already_redeemed' });
  });
  await f.monitor.check();
  assert.equal(f.posts().length, 2);
  assert.equal(f.posts()[0].body, f.posts()[1].body);
  assert.equal((await f.state()).lastResult, 'completed');
});

test('pending reset retries after one minute and cannot start a new redemption during cooldown', async t => {
  const f = await fixture(t);
  f.post(() => json({ code: 'unknown' }));
  await f.monitor.check();
  const pending = await f.state();
  f.advance(59_000);
  await f.monitor.check();
  assert.equal(f.posts().length, 1);
  f.advance(1001);
  f.post(() => json({ code: 'already_redeemed' }));
  await f.monitor.check();
  assert.equal(f.posts().length, 2);
  assert.equal(JSON.parse(f.posts()[1].body).redeem_request_id, pending.pendingRequestId);
  await f.monitor.check();
  assert.equal(f.posts().length, 2);
});

test('fresh reduced usage recovers a throttled account even when reset outcome was uncertain', async t => {
  const f = await fixture(t);
  f.manager.accounts[0].quota.primary = 1;
  f.manager.markRateLimited(0, 3600);
  f.get(() => json(usage(0, 0)));
  await f.monitor.check();
  assert.equal(f.manager.accounts[0].status, 'active');
  assert.equal(f.posts().length, 0);
});

for (const strategy of ['weighted-round-robin', 'failover']) {
  test(`${strategy}: pool usage, weights and routing thresholds never trigger another account's reset`, async t => {
    const routing = { defaultPool: 'shared', pools: {
      shared: { accounts: ['account-1', 'account-2'], strategy, switchThreshold: 0.01 },
      overlapping: { accounts: ['account-1'], strategy, switchThreshold: 1 },
    } };
    const f = await fixture(t, { routing, accounts: [
      { ...account(), weight: 1, switchThreshold: 1 },
      { ...account('account-2'), weight: 1000, switchThreshold: 0.01 },
    ] });
    f.manager.routing = routing;
    f.manager.accounts[1].usage.totalInputTokens = 1_000_000_000;
    f.manager.accounts[1].quota.primary = 1;
    const redeemed = new Set();
    f.get((_url, init) => {
      const id = init.headers['chatgpt-account-id'];
      return json(usage(id === 'account-1' && !redeemed.has(id) ? 99 : 20, 2));
    });
    f.post((_url, init) => { redeemed.add(init.headers['chatgpt-account-id']); return json({ code: 'reset' }); });
    await f.monitor.recover();
    assert.equal(f.posts().length, 1);
    assert.equal(f.posts()[0].headers['chatgpt-account-id'], 'account-1');
    assert.equal(f.posts()[0].headers.authorization, 'Bearer secret-account-1');
    const disk = await loadConfig();
    assert.deepEqual(Object.keys(disk.usageResetState), ['chatgpt:account-1']);
    assert.equal(f.manager.accounts[1].usageReset.availableCredits, 2);
    await f.monitor.check();
    assert.equal(f.posts().length, 1, 'overlapping pools must not multiply redemptions');
  });
}

test('a usage snapshot cannot authorize a reset for another account', async t => {
  const f = await fixture(t, { accounts: [account(), account('account-2')] });
  const snapshot = await f.monitor.readUsage(f.manager.accounts[0]);
  assert.equal(await f.monitor.reserve(f.manager.accounts[1], snapshot), null);
  assert.equal((await loadConfig()).usageResetState, undefined);
});

test('disabled accounts never reserve reset credits', async t => {
  const f = await fixture(t, { accounts: [{ ...account(), enabled: false }] });
  await f.monitor.check();
  assert.equal(f.posts().length, 0);
});

test('aggregate or credential-stale observations cannot reserve credits', async t => {
  const f = await fixture(t);
  assert.equal(await f.monitor.reserve(f.manager.accounts[0], normalizeUsage(usage())), null);
  const snapshot = await f.monitor.readUsage(f.manager.accounts[0]);
  f.manager.accounts[0].credential = 'replacement-token';
  assert.equal(await f.monitor.reserve(f.manager.accounts[0], snapshot), null);
  assert.equal((await loadConfig()).usageResetState, undefined);
});

test('a credential replaced on disk cannot authorize a reset from stale in-memory usage', async t => {
  const f = await fixture(t);
  const live = f.manager.accounts[0];
  const snapshot = await f.monitor.readUsage(live);
  await atomicConfigUpdate(config => { config.accounts[0].accessToken = 'new-disk-token'; });
  assert.equal(await f.monitor.reserve(live, snapshot), null);
  assert.equal(await f.state(), undefined);
});

test('a removed account cannot reserve a reset while waiting for the config transaction', async t => {
  const f = await fixture(t);
  const live = f.manager.accounts[0];
  const snapshot = await f.monitor.readUsage(live);
  f.manager.accounts.splice(0, 1);
  assert.equal(await f.monitor.reserve(live, snapshot), null);
  assert.equal(await f.state(), undefined);
});

for (const changed of [false, true]) {
  test(`imported credential reset reservation checks current auth file (changed=${changed})`, async t => {
    const f = await fixture(t);
    const live = f.manager.accounts[0];
    const snapshot = await f.monitor.readUsage(live);
    const authPath = join(f.path, '..', 'auth.json');
    await writeFile(authPath, JSON.stringify({ tokens: {
      access_token: changed ? 'replaced-import' : live.credential,
      account_id: live.accountId,
    } }), { mode: 0o600 });
    await atomicConfigUpdate(config => {
      delete config.accounts[0].accessToken;
      config.accounts[0].importFrom = authPath;
    });
    const reservation = await f.monitor.reserve(live, snapshot);
    assert.equal(Boolean(reservation), !changed);
    assert.equal(Boolean(await f.state()), !changed);
  });
}

test('provider denied usage cannot reactivate a throttled account after a reset', async t => {
  const f = await fixture(t);
  const live = f.manager.accounts[0];
  live.status = 'throttled';
  live.rateLimitedUntil = f.now() + 60_000;
  let reads = 0;
  f.get(() => {
    const payload = usage(reads++ === 0 ? 100 : 0);
    payload.rate_limit.allowed = false;
    payload.rate_limit.limit_reached = true;
    return json(payload);
  });
  await f.monitor.check();
  assert.equal(f.posts().length, 1);
  assert.equal(live.status, 'throttled');
  assert.equal(live.rateLimitedUntil, f.now() + 60_000);
});
