import assert from 'node:assert/strict';
import { mkdtemp, readFile,rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AccountConfig, Config } from '@teamcodex/core/config';
import { normalizeUsage } from '@teamcodex/core/quota';
import type { RoutingStrategy } from '@teamcodex/core/routing';
import { AccountManager } from '@teamcodex/proxy/account-manager';
import { atomicConfigUpdate, createDefaultConfig, loadConfig, resetConfig,saveConfig } from '@teamcodex/proxy/config';
import { UsageResetMonitor } from '@teamcodex/proxy/usage-reset';
import { afterEach, test } from 'bun:test';

const json = (payload: unknown) => globalThis.Response.json(payload);
const usage = (percent = 100, credits: unknown = 2) => ({
  rate_limit: { primary_window: { used_percent: percent, limit_window_seconds: 18000 }, secondary_window: { used_percent: 0, limit_window_seconds: 604800 } },
  ...(credits === null ? {} : { rate_limit_reset_credits: { available_count: credits } }),
});
const account = (id = 'account-1'): AccountConfig => ({ name: id, accountId: id, type: 'chatgpt', accessToken: `secret-${id}` });

async function fixture(overrides: Partial<Config> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'teamcodex-resets-'));
  const path = join(dir, 'config.json');
  const oldPath = process.env.TEAMCODEX_CONFIG;
  process.env.TEAMCODEX_CONFIG = path;
  afterEach(async () => {
    if (oldPath === undefined) delete process.env.TEAMCODEX_CONFIG;
    else process.env.TEAMCODEX_CONFIG = oldPath;
    await rm(dir, { recursive: true, force: true });
  });
  const config = { ...createDefaultConfig(), accounts: [account()], ...overrides };
  await saveConfig(config);
  const manager = new AccountManager(config.accounts);
  let now = Date.now();
  const requests: { url: Parameters<typeof fetch>[0]; method?: string; headers?: HeadersInit; body?: BodyInit | null }[] = [];
  let getResponse: (url: Parameters<typeof fetch>[0], init: RequestInit) => Response | Promise<Response> = () => json(usage());
  let postResponse: typeof getResponse = () => json({ code: 'reset' });
  const fetchFn: typeof fetch = Object.assign(async (url: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
    requests.push({ url, ...init });
    return init.method === 'POST' ? postResponse(url, init) : getResponse(url, init);
  }, { preconnect: fetch.preconnect });
  const monitor = new UsageResetMonitor(manager, config, { fetchFn, wait: async () => {}, now: () => now });
  afterEach(() => monitor.stop());
  const first = manager.accounts[0];
  assert.ok(first);
  return {
    first, config, manager, monitor, requests, path, fetchFn,
    now: () => now,
    advance: (ms: number) => { now += ms; },
    get: (fn: typeof getResponse) => { getResponse = fn; },
    post: (fn: typeof postResponse) => { postResponse = fn; },
    posts: () => requests.filter(r => r.method === 'POST'),
    state: async () => (await loadConfig())?.usageResetState?.['chatgpt:account-1'],
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

test('automatic reset at the threshold uses the upstream contract and verifies new usage', async () => {
  const f = await fixture();
  let reads = 0;
  f.get(() => json(usage(++reads === 1 ? 98 : 0, reads === 1 ? 2 : 1)));
  f.manager.markRateLimited(0, 3600);
  await f.monitor.check();
  const [request] = f.posts();
  assert.ok(request);
  assert.equal(f.posts().length, 1);
  assert.equal(request.url, 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume');
  assert.equal(new Headers(request.headers).get('authorization'), 'Bearer secret-account-1');
  assert.equal(new Headers(request.headers).get('chatgpt-account-id'), 'account-1');
  assert.match(JSON.parse(String(request.body)).redeem_request_id, /^[a-f0-9-]{36}$/);
  assert.equal(f.first.status, 'active');
  assert.equal(f.first.quota.primary, 0);
  assert.equal(f.first.usage.totalRequests, 0);
  assert.equal(f.first.usageReset.availableCredits, 1);
  assert.equal((await f.state())?.lastResult, 'completed');
  assert.equal((await f.state())?.pendingRequestId, undefined);
  assert.ok(!JSON.stringify(f.manager.getStatus()).includes('secret-account-1'));
  assert.equal(f.manager.getStatus().usagePolling?.running, false);
  assert.equal(f.manager.getStatus().usagePolling?.lastCompletedAt, new Date(f.now()).toISOString());
  assert.equal(f.manager.getStatus().accounts[0]?.quotaUpdatedAt, new Date(f.now()).toISOString());
  assert.equal(f.manager.getStatus().accounts[0]?.usageReset.nextEligibleAt, new Date(f.now() + 3600000).toISOString());
});

test('additional quota windows keep their names, percentages and reset times', () => {
  const now = Date.now();
  const result = normalizeUsage({ ...usage(10), additional_rate_limits: [{ limit_name: 'Special model', rate_limit: {
    primary_window: { used_percent: 99, reset_after_seconds: 60, limit_window_seconds: 3600 },
  } }] }, now);
  assert.equal(result.utilization, 0.99);
  assert.deepEqual(result.additionalQuota, [{ name: 'Special model (primary)', utilization: 0.99, resetAt: now + 60000, windowMinutes: 60 }]);
});

for (const [name, percent, credits] of [['below threshold', 97.99, 2], ['no credits', 100, 0], ['unknown credits', 100, null]] as const) {
  test(`automatic redemption skips ${name}`, async () => {
    const f = await fixture();
    f.get(() => json(usage(percent, credits)));
    await f.monitor.check();
    assert.equal(f.posts().length, 0);
  });
}

test('disabled policy still refreshes usage without redeeming credits', async () => {
  const f = await fixture({ autoReset: { enabled: false } });
  await f.monitor.check();
  assert.equal(f.posts().length, 0);
  assert.equal(f.first.quota.primary, 1);
});

test('API accounts and ChatGPT accounts without a stable identity never redeem credits', async () => {
  const f = await fixture({ accounts: [{ name: 'api', type: 'apikey', apiKey: 'secret' }, { name: 'unknown-id', type: 'chatgpt', accessToken: 'opaque' }] });
  await f.monitor.check();
  assert.equal(f.posts().length, 0);
  assert.equal(f.requests.length, 1);
});

test('all ChatGPT accounts, including inactive ones, are checked for available resets', async () => {
  const f = await fixture({ accounts: [account(), account('account-2')] });
  await f.monitor.check();
  assert.deepEqual(f.posts().map(r => new Headers(r.headers).get('chatgpt-account-id')).sort(), ['account-1', 'account-2']);
});

for (const window of ['primary_window', 'secondary_window'] as const) {
  test(`mixed pool resets only the account whose own ${window} and credits qualify`, async () => {
    const f = await fixture({ accounts: [account(), account('account-2'), account('account-3'), account('account-4')] });
    const snapshots: Record<string, ReturnType<typeof usage>> = {
      'account-1': usage(0, 2),
      'account-2': usage(20, 5),
      'account-3': usage(100, 0),
      'account-4': usage(100, null),
    };
    const firstSnapshot = snapshots['account-1'];
    assert.ok(firstSnapshot);
    firstSnapshot.rate_limit[window].used_percent = 98;
    // Poll a qualifying inactive account while the selected account changes
    // and another account's usage response finishes first.
    f.manager.currentIndex = 1;
    const { promise: lowAccountReady, resolve: lowAccountRead } = Promise.withResolvers<void>();
    f.get(async (_url, init) => {
      const id = new Headers(init.headers).get('chatgpt-account-id');
      assert.ok(id);
      if (id === 'account-1') await lowAccountReady;
      if (id === 'account-2') {
        f.manager.currentIndex = 2;
        lowAccountRead();
      }
      return json(snapshots[id]);
    });
    f.post((_url, init) => {
      const id = new Headers(init.headers).get('chatgpt-account-id');
      assert.ok(id);
      snapshots[id] = usage(0, 1);
      return json({ code: 'reset' });
    });
    await f.monitor.check();
    assert.deepEqual(f.posts().map(r => ({ id: new Headers(r.headers).get('chatgpt-account-id'), auth: new Headers(r.headers).get('authorization') })),
      [{ id: 'account-1', auth: 'Bearer secret-account-1' }]);
    assert.deepEqual(Object.keys((await loadConfig())?.usageResetState ?? {}), ['chatgpt:account-1']);
    assert.equal((await f.state())?.lastResult, 'completed');
    assert.equal(secondAccount(f.manager).quota.primary, 0.2);
    assert.equal(secondAccount(f.manager).usageReset.availableCredits, 5);
  });
}

test('a pool average above the threshold cannot reset an account below its own threshold', async () => {
  const f = await fixture({ accounts: [account(), account('account-2')] });
  // The mean is 98.995%, but the only account with credits is at 97.99%.
  f.get((_url, init) => json(new Headers(init.headers).get('chatgpt-account-id') === 'account-1' ? usage(97.99, 5) : usage(100, 0)));
  await f.monitor.check();
  assert.equal(f.posts().length, 0);
  assert.equal((await loadConfig())?.usageResetState, undefined);
});

for (const outcome of ['no_credit', 'nothing_to_reset']) {
  test(`${outcome} is an unsuccessful outcome and still starts a cooldown`, async () => {
    const f = await fixture();
    f.post(() => json({ code: outcome }));
    await f.monitor.check();
    await f.monitor.check();
    assert.equal(f.posts().length, 1);
    assert.equal((await f.state())?.lastResult, outcome);
    assert.equal((await f.state())?.pendingRequestId, undefined);
    assert.equal((await f.state())?.lastCompletedAt, undefined);
  });
}

test('uncertain outcome retains its ID across restarts even after credits and usage drop to zero', async () => {
  const f = await fixture();
  f.post(() => { throw new Error('lost response with secret-account-1'); });
  await f.monitor.check();
  const pendingId = (await f.state())?.pendingRequestId;
  assert.equal((await f.state())?.lastResult, 'provider_unavailable');
  assert.ok(!(await readFile(f.path, 'utf8')).includes('lost response'));
  f.advance(3_600_001);
  f.get(() => json(usage(0, 0)));
  f.post(() => json({ code: 'already_redeemed' }));
  const restarted = new UsageResetMonitor(f.manager, (await loadConfig()) ?? f.config, { fetchFn: f.fetchFn, now: f.now });
  await restarted.check();
  assert.equal(JSON.parse(String(f.posts().at(-1)?.body)).redeem_request_id, pendingId);
  assert.equal((await f.state())?.lastResult, 'completed');
  assert.equal((await f.state())?.pendingRequestId, undefined);
});

for (const failure of ['http', 'unknown', 'usage-refresh']) {
  test(`${failure} failure retains the logical redemption until it can be verified`, async () => {
    const f = await fixture();
    let posted = false;
    f.post(() => {
      posted = true;
      return failure === 'http' ? new globalThis.Response('', { status: 503 }) : json({ code: failure === 'unknown' ? 'unexpected' : 'reset' });
    });
    f.get(() => failure === 'usage-refresh' && posted ? new globalThis.Response('', { status: 503 }) : json(usage()));
    await f.monitor.check();
    const before = await f.state();
    assert.ok(before);
    assert.ok(before.pendingRequestId);
    assert.notEqual(before.lastResult, 'completed');
    f.advance(3_600_001);
    f.post(() => json({ code: 'already_redeemed' }));
    f.get(() => json(usage(0)));
    await f.monitor.check();
    assert.equal(JSON.parse(String(f.posts().at(-1)?.body)).redeem_request_id, before.pendingRequestId);
    assert.equal((await f.state())?.lastResult, 'completed');
  });
}

test('a provider reset that leaves usage exhausted does not reactivate a throttled account', async () => {
  const f = await fixture();
  f.manager.markRateLimited(0, 3600);
  await f.monitor.check();
  assert.equal(f.first.status, 'throttled');
  await f.monitor.check();
  assert.equal(f.posts().length, 1);
});

test('two monitors cannot spend two credits concurrently for the same account', async () => {
  const f = await fixture();
  const second = new UsageResetMonitor(new AccountManager(f.config.accounts), f.config, { fetchFn: f.fetchFn, now: f.now });
  await Promise.all([f.monitor.check(), f.monitor.check(), second.check()]);
  assert.equal(f.posts().length, 1);
});

test('state persistence failure prevents the upstream POST', async () => {
  const f = await fixture();
  const monitor = new UsageResetMonitor(f.manager, f.config, { fetchFn: f.fetchFn, updateConfig: async () => { throw new Error('disk full'); } });
  await assert.rejects(monitor.check(), /disk full/);
  assert.equal(f.posts().length, 0);
});

test('stale or future-dated observations cannot initiate new redemptions', async () => {
  const f = await fixture();
  for (const timestamp of [f.now() - 600_001, f.now() + 1000]) {
    const snapshot = await f.monitor.readUsage(f.first);
    snapshot.fetchedAt = timestamp;
    assert.equal(await f.monitor.reserve(f.first, snapshot), null);
  }
});

test('installation reset retains pending IDs and cooldown timestamps', async () => {
  const f = await fixture();
  f.post(() => { throw new Error('lost response'); });
  await f.monitor.check();
  const before = await f.state();
    assert.ok(before);
  await resetConfig();
  assert.deepEqual(await f.state(), before);
  const monitor = new UsageResetMonitor(f.manager, (await loadConfig()) ?? f.config, { fetchFn: f.fetchFn, now: f.now });
  await monitor.check();
  assert.equal(f.posts().length, 1);
});

test('account changes during a usage request discard the old account snapshot', async () => {
  const f = await fixture();
  const { promise: began, resolve: started } = Promise.withResolvers<void>();
  const { promise: response, resolve: finish } = Promise.withResolvers<Response>();
  f.get(() => { started(); return response; });
  const pending = f.monitor.check();
  await began;
  f.first.accountId = 'replacement';
  f.first.credential = 'replacement-token';
  finish(json(usage()));
  await pending;
  assert.equal(f.posts().length, 0);
  assert.equal(f.first.quota.primary, null);
});

test('reset settings and corrupt pending IDs are rejected before any usage mutation', async () => {
  await fixture();
  await assert.rejects(atomicConfigUpdate(c => { c.autoReset = { threshold: 0 }; }), /autoReset/);
  await assert.rejects(atomicConfigUpdate(c => { c.autoReset = { pollIntervalSeconds: 1 }; }), /autoReset/);
  await assert.rejects(atomicConfigUpdate(c => { c.usageResetState = { bad: { pendingRequestId: 'broken' } }; }), /usageResetState/);
});

test('transient redemption retries use the same ID and complete after a lost response', async () => {
  const f = await fixture();
  let attempts = 0;
  f.post(() => {
    if (++attempts === 1) throw new TypeError('fetch failed');
    return json({ code: 'already_redeemed' });
  });
  await f.monitor.check();
  assert.equal(f.posts().length, 2);
  assert.equal(f.posts()[0]?.body, f.posts()[1]?.body);
  assert.equal((await f.state())?.lastResult, 'completed');
});

test('pending reset retries after one minute and cannot start a new redemption during cooldown', async () => {
  const f = await fixture();
  f.post(() => json({ code: 'unknown' }));
  await f.monitor.check();
  const pending = await f.state();
  assert.ok(pending);
  f.advance(59_000);
  await f.monitor.check();
  assert.equal(f.posts().length, 1);
  f.advance(1001);
  f.post(() => json({ code: 'already_redeemed' }));
  await f.monitor.check();
  assert.equal(f.posts().length, 2);
  assert.equal(JSON.parse(String(f.posts()[1]?.body)).redeem_request_id, pending.pendingRequestId);
  await f.monitor.check();
  assert.equal(f.posts().length, 2);
});

test('fresh reduced usage recovers a throttled account even when reset outcome was uncertain', async () => {
  const f = await fixture();
  f.first.quota.primary = 1;
  f.manager.markRateLimited(0, 3600);
  f.get(() => json(usage(0, 0)));
  await f.monitor.check();
  assert.equal(f.first.status, 'active');
  assert.equal(f.posts().length, 0);
});

for (const strategy of ['weighted-round-robin', 'failover'] satisfies RoutingStrategy[]) {
  test(`${strategy}: pool usage, weights and routing thresholds never trigger another account's reset`, async () => {
    const routing: NonNullable<Config['routing']> = { defaultPool: 'shared', pools: {
      shared: { accounts: ['account-1', 'account-2'], strategy, switchThreshold: 0.01 },
      overlapping: { accounts: ['account-1'], strategy, switchThreshold: 1 },
    } };
    const f = await fixture({ routing, accounts: [
      { ...account(), weight: 1, switchThreshold: 1 },
      { ...account('account-2'), weight: 1000, switchThreshold: 0.01 },
    ] });
    f.manager.routing = routing;
    secondAccount(f.manager).usage.totalInputTokens = 1_000_000_000;
    secondAccount(f.manager).quota.primary = 1;
    const redeemed = new Set();
    f.get((_url, init) => {
      const id = new Headers(init.headers).get('chatgpt-account-id');
      assert.ok(id);
      return json(usage(id === 'account-1' && !redeemed.has(id) ? 99 : 20, 2));
    });
    f.post((_url, init) => { redeemed.add(new Headers(init.headers).get('chatgpt-account-id')); return json({ code: 'reset' }); });
    await f.monitor.recover();
    assert.equal(f.posts().length, 1);
    assert.equal(new Headers(f.posts()[0]?.headers).get('chatgpt-account-id'), 'account-1');
    assert.equal(new Headers(f.posts()[0]?.headers).get('authorization'), 'Bearer secret-account-1');
    const disk = await loadConfig();
    assert.deepEqual(Object.keys(disk?.usageResetState ?? {}), ['chatgpt:account-1']);
    assert.equal(secondAccount(f.manager).usageReset.availableCredits, 2);
    await f.monitor.check();
    assert.equal(f.posts().length, 1, 'overlapping pools must not multiply redemptions');
  });
}

test('a usage snapshot cannot authorize a reset for another account', async () => {
  const f = await fixture({ accounts: [account(), account('account-2')] });
  const snapshot = await f.monitor.readUsage(f.first);
  assert.equal(await f.monitor.reserve(secondAccount(f.manager), snapshot), null);
  assert.equal((await loadConfig())?.usageResetState, undefined);
});

test('disabled accounts never reserve reset credits', async () => {
  const f = await fixture({ accounts: [{ ...account(), enabled: false }] });
  await f.monitor.check();
  assert.equal(f.posts().length, 0);
});

test('aggregate or credential-stale observations cannot reserve credits', async () => {
  const f = await fixture();
  assert.equal(await f.monitor.reserve(f.first, normalizeUsage(usage())), null);
  const snapshot = await f.monitor.readUsage(f.first);
  f.first.credential = 'replacement-token';
  assert.equal(await f.monitor.reserve(f.first, snapshot), null);
  assert.equal((await loadConfig())?.usageResetState, undefined);
});

test('a credential replaced on disk cannot authorize a reset from stale in-memory usage', async () => {
  const f = await fixture();
  const live = f.first;
  const snapshot = await f.monitor.readUsage(live);
  await atomicConfigUpdate(config => { const first = config.accounts[0]; assert.ok(first); first.accessToken = 'new-disk-token'; });
  assert.equal(await f.monitor.reserve(live, snapshot), null);
  assert.equal(await f.state(), undefined);
});

test('a removed account cannot reserve a reset while waiting for the config transaction', async () => {
  const f = await fixture();
  const live = f.first;
  const snapshot = await f.monitor.readUsage(live);
  f.manager.accounts.splice(0, 1);
  assert.equal(await f.monitor.reserve(live, snapshot), null);
  assert.equal(await f.state(), undefined);
});

for (const changed of [false, true]) {
  test(`imported credential reset reservation checks current auth file (changed=${changed})`, async () => {
    const f = await fixture();
    const live = f.first;
    const snapshot = await f.monitor.readUsage(live);
    const authPath = join(f.path, '..', 'auth.json');
    await writeFile(authPath, JSON.stringify({ tokens: {
      access_token: changed ? 'replaced-import' : live.credential,
      account_id: live.accountId,
    } }), { mode: 0o600 });
    await atomicConfigUpdate(config => {
      const first = config.accounts[0];
      assert.ok(first);
      delete first.accessToken;
      first.importFrom = authPath;
    });
    const reservation = await f.monitor.reserve(live, snapshot);
    assert.equal(Boolean(reservation), !changed);
    assert.equal(Boolean(await f.state()), !changed);
  });
}

test('provider denied usage cannot reactivate a throttled account after a reset', async () => {
  const f = await fixture();
  const live = f.first;
  live.status = 'throttled';
  live.rateLimitedUntil = f.now() + 60_000;
  let reads = 0;
  f.get(() => {
    const value = usage(reads++ === 0 ? 100 : 0);
    const payload = { ...value, rate_limit: { ...value.rate_limit, allowed: false, limit_reached: true } };
    return json(payload);
  });
  await f.monitor.check();
  assert.equal(f.posts().length, 1);
  assert.equal(live.status, 'throttled');
  assert.equal(live.rateLimitedUntil, f.now() + 60_000);
});

function secondAccount(manager: AccountManager) {
  const account = manager.accounts[1];
  assert.ok(account);
  return account;
}

test('disabling an account during reservation persistence prevents the reset POST', async () => {
  const f = await fixture();
  const monitor = new UsageResetMonitor(f.manager, f.config, { fetchFn: f.fetchFn, now: f.now, updateConfig: async updater => {
    const result = await atomicConfigUpdate(updater);
    f.first.enabled = false;
    return result;
  } });
  await monitor.check();
  assert.equal(f.posts().length, 0);
  assert.ok((await f.state())?.pendingRequestId, 'retain the reserved ID for recovery');
});

test('disabling an account during reset backoff prevents another wire attempt', async () => {
  const f = await fixture();
  f.post(() => new Response('', { status: 503 }));
  const monitor = new UsageResetMonitor(f.manager, f.config, { fetchFn: f.fetchFn, now: f.now, wait: async () => { f.first.enabled = false; } });
  await monitor.check();
  assert.equal(f.posts().length, 1);
  assert.ok((await f.state())?.pendingRequestId);
});
