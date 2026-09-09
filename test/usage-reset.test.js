import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AccountManager } from '../src/account-manager.js';
import { UsageResetMonitor, normalizeUsage } from '../src/usage-reset.js';
import { atomicConfigUpdate, createDefaultConfig, saveConfig, loadConfig, resetConfig } from '../src/config.js';

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

for (const window of ['primary_window', 'secondary_window']) {
  test(`mixed pool resets only the account whose own ${window} and credits qualify`, async t => {
    const f = await fixture(t, { accounts: [account(), account('account-2'), account('account-3'), account('account-4')] });
    const snapshots = {
      'account-1': usage(0, 2),
      'account-2': usage(20, 5),
      'account-3': usage(100, 0),
      'account-4': usage(100, null),
    };
    snapshots['account-1'].rate_limit[window].used_percent = 98;
    // Poll a qualifying inactive account while the selected account changes
    // and another account's usage response finishes first.
    f.manager.currentIndex = 1;
    let lowAccountRead;
    const lowAccountReady = new Promise(resolve => { lowAccountRead = resolve; });
    f.get(async (_url, init) => {
      const id = init.headers['chatgpt-account-id'];
      if (id === 'account-1') await lowAccountReady;
      if (id === 'account-2') {
        f.manager.currentIndex = 2;
        lowAccountRead();
      }
      return json(snapshots[id]);
    });
    f.post((_url, init) => {
      const id = init.headers['chatgpt-account-id'];
      snapshots[id] = usage(0, 1);
      return json({ code: 'reset' });
    });
    await f.monitor.check();
    assert.deepEqual(f.posts().map(r => ({ id: r.headers['chatgpt-account-id'], auth: r.headers.authorization })),
      [{ id: 'account-1', auth: 'Bearer secret-account-1' }]);
    assert.deepEqual(Object.keys((await loadConfig()).usageResetState), ['chatgpt:account-1']);
    assert.equal((await f.state()).lastResult, 'completed');
    assert.equal(f.manager.accounts[1].quota.primary, 0.2);
    assert.equal(f.manager.accounts[1].usageReset.availableCredits, 5);
  });
}

test('a pool average above the threshold cannot reset an account below its own threshold', async t => {
  const f = await fixture(t, { accounts: [account(), account('account-2')] });
  // The mean is 98.995%, but the only account with credits is at 97.99%.
  f.get((_url, init) => json(init.headers['chatgpt-account-id'] === 'account-1' ? usage(97.99, 5) : usage(100, 0)));
  await f.monitor.check();
  assert.equal(f.posts().length, 0);
  assert.equal((await loadConfig()).usageResetState, undefined);
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
    assert.equal(await f.monitor.reserve(f.manager.accounts[0], normalizeUsage(usage(), timestamp)), null);
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
