import assert from 'node:assert/strict';

import type { AccountConfig, Config } from '@teamcodex/core/config';
import { AccountManager } from '@teamcodex/proxy/account-manager';
import { findConfigAccount, resolveAccounts, syncAccountsFromDisk } from '@teamcodex/proxy/accounts';
import type { Credentials } from '@teamcodex/proxy/auth/tokens';
import { createDefaultConfig } from '@teamcodex/proxy/config';
import { afterEach, test } from 'bun:test';

const key = (name: string, apiKey = name): AccountConfig => ({ name, type: 'apikey', apiKey, accountId: null });

test('starting account and rotation schedule are shuffled without changing config indexes', () => {
  const accounts = ['a', 'b', 'c', 'd'].map(name => key(name));
  const manager = new AccountManager(accounts, 0.98, undefined, { randomIndex: () => 0 });
  assert.deepEqual(manager.accounts.map(a => a.name), ['a', 'b', 'c', 'd']);
  assert.deepEqual(manager.getStatus().rotationOrder, ['b', 'c', 'd', 'a']);
  assert.equal(manager.getActiveAccount()?.name, 'b');
  const seen: string[] = [];
  for (let i = 0; i < accounts.length; i++) {
    const account = manager.getActiveAccount();
    assert.ok(account);
    seen.push(account.name);
    manager.markRateLimited(account, 60);
  }
  assert.deepEqual(seen, ['b', 'c', 'd', 'a']);
  assert.equal(manager.getActiveAccount(), null);
});

test('every permutation and initial account is reachable with uniform shuffle draws', () => {
  const orders = new Set<string>();
  const starts = new Map<string, number>();
  for (let first = 0; first < 3; first++) {
    for (let second = 0; second < 2; second++) {
      const draws = [first, second];
      const manager = new AccountManager(['a', 'b', 'c'].map(name => key(name)), 0.98, undefined, { randomIndex: () => { const draw = draws.shift(); assert.ok(draw !== undefined); return draw; } });
      orders.add(manager.getStatus().rotationOrder.join(','));
      const name = manager.getActiveAccount()?.name;
      assert.ok(name);
      starts.set(name, (starts.get(name) || 0) + 1);
    }
  }
  assert.equal(orders.size, 6);
  assert.deepEqual([...starts.values()], [2, 2, 2]);
});

test('random schedule survives removal, insertion, and identity replacement', async () => {
  const manager = new AccountManager(['a', 'b', 'c'].map(name => key(name)), 0.98, undefined, { randomIndex: () => 0 });
  const current = manager.getActiveAccount();
  assert.ok(current);
  assert.equal(current.name, 'b');
  manager.removeAccount(0);
  assert.equal(manager.getActiveAccount(), current);
  manager.addAccount(key('d'));
  assert.deepEqual(manager.getStatus().rotationOrder, ['d', 'b', 'c']);
  manager.removeAccount(current.index);
  assert.equal(manager.getActiveAccount()?.name, 'c');
  const mem = { ...createDefaultConfig(), accounts: [key('c'), key('d')] };
  await syncAccountsFromDisk({ ...createDefaultConfig(), accounts: [{ name: 'c', type: 'chatgpt', accountId: 'new', accessToken: 'new' }, key('d')] }, mem, manager);
  assert.equal(manager.getActiveAccount()?.accountId, 'new');
  const replacement = manager.getActiveAccount();
  assert.ok(replacement);
  assert.equal(manager.rotateAfter(replacement)?.name, 'd');
  manager.removeAccount(1);
  manager.removeAccount(0);
  assert.equal(manager.getActiveAccount(), null);
  manager.addAccount(key('only'));
  assert.equal(manager.getActiveAccount()?.name, 'only');
});

test('transient retry rotation and near-quota ties follow the shuffled schedule', () => {
  const manager = new AccountManager(['a', 'b', 'c'].map(name => key(name)), 0.98, undefined, { randomIndex: () => 0 });
  assert.equal(manager.rotateAfter(getAccount(manager, 1))?.name, 'c');
  manager.markAuthFailed(0);
  assert.equal(manager.rotateAfter(getAccount(manager, 2))?.name, 'b');
  for (const a of manager.accounts) a.quota.primary = 0.99;
  assert.equal(manager.rotateAfter(getAccount(manager, 1))?.name, 'c');
});

test('hot reload adds accounts without IDs and updates the correct API key', async () => {
  const config: Config = { ...createDefaultConfig(), accounts: [key('first')] };
  const manager = new AccountManager(config.accounts);
  const disk: Config = { ...createDefaultConfig(), accounts: [key('first'), key('second')] };
  assert.equal(findConfigAccount(config, disk.accounts[1] ?? key('missing')), -1);
  assert.deepEqual(await syncAccountsFromDisk(disk, config, manager), { added: 1, updated: 0, removed: 0 });
  disk.accounts[1] = key('second', 'replacement');
  assert.equal((await syncAccountsFromDisk(disk, config, manager)).updated, 1);
  assert.equal(getAccount(manager, 0).credential, 'first');
  assert.equal(getAccount(manager, 1).credential, 'replacement');
  assert.equal(config.accounts[1]?.apiKey, 'replacement');
});

test('unresolvable imports do not misalign removals and account indexes', async () => {
  const disk: Config = { ...createDefaultConfig(), accounts: [{ name: 'missing', type: 'chatgpt', importFrom: '/does-not-exist/auth.json' }, key('first'), key('second')] };
  const config: Config = { ...createDefaultConfig(), accounts: await resolveAccounts(disk) };
  const manager = new AccountManager(config.accounts);
  disk.accounts.splice(1, 1);
  assert.equal((await syncAccountsFromDisk(disk, config, manager, { removeMissing: true })).removed, 1);
  assert.equal(getAccount(manager, 0).name, 'second');
  assert.equal(config.accounts[0]?.name, 'second');
});

test('reloaded account metadata and fresher tokens stay aligned', async () => {
  const acct: AccountConfig = { name: 'old', accountId: 'id', type: 'chatgpt', accessToken: 'fresh', refreshToken: 'fresh-r', expiresAt: 200 };
  const config: Config = { ...createDefaultConfig(), accounts: [acct] };
  const manager = new AccountManager(config.accounts);
  await syncAccountsFromDisk({ ...createDefaultConfig(), accounts: [{ ...acct, name: 'new', accessToken: 'stale', expiresAt: 100 }] }, config, manager);
  assert.equal(getAccount(manager, 0).name, 'new');
  assert.equal(getAccount(manager, 0).credential, 'fresh');
  assert.equal(config.accounts[0]?.accessToken, 'fresh');
});

test('expired quotas never reactivate rejected credentials', () => {
  const manager = new AccountManager([key('first')]);
  getAccount(manager, 0).quota.primaryReset = Date.now() - 1000;
  manager.markAuthFailed(0);
  assert.equal(manager.getActiveAccount(), null);
});

test('in-flight updates cannot mutate a replacement account after removal', () => {
  const manager = new AccountManager([key('first'), key('second')]);
  const removed = getAccount(manager, 0);
  manager.removeAccount(0);
  manager.updateQuota(removed, { 'x-codex-primary-used-percent': '100' });
  manager.updateUsage(removed, 100, 200);
  manager.markRateLimited(removed, 60);
  assert.equal(getAccount(manager, 0).status, 'active');
  assert.equal(getAccount(manager, 0).usage.totalInputTokens, 0);
  assert.equal(getAccount(manager, 0).quota.primary, null);
});

test('ISO dates and millisecond reset headers remain valid', () => {
  const manager = new AccountManager([key('first')]);
  const reset = Date.now() + 3_600_000;
  manager.updateQuota(0, { 'x-codex-primary-reset-at': new Date(reset).toISOString(), 'x-codex-secondary-reset-at': String(reset) });
  assert.equal(getAccount(manager, 0).quota.primaryReset, reset);
  assert.equal(getAccount(manager, 0).quota.secondaryReset, reset);
});

test('refresh finishes against the same account after indexes shift', async () => {
  const { promise: response, resolve: finish } = Promise.withResolvers<Response>();
  const original = globalThis.fetch;
  globalThis.fetch = Object.assign(() => response, { preconnect: original.preconnect });
  afterEach(() => { globalThis.fetch = original; });
  const manager = new AccountManager([key('first'), { name: 'second', type: 'chatgpt', accessToken: 'old', refreshToken: 'refresh', expiresAt: 1 }]);
  const refreshed: { index: number; tokens: Credentials }[] = [];
  manager.onTokenRefresh(async (index, tokens) => { refreshed.push({ index, tokens }); });
  const pending = manager.ensureTokenFresh(1);
  manager.removeAccount(0);
  finish(Response.json({ access_token: 'new', refresh_token: 'new-refresh' }));
  await pending;
  assert.equal(refreshed[0]?.index, 0);
  assert.equal(getAccount(manager, 0).credential, 'new');
});

test('refresh does not overwrite credentials re-imported while it was pending', async () => {
  const { promise: response, resolve: finish } = Promise.withResolvers<Response>();
  const original = globalThis.fetch;
  globalThis.fetch = Object.assign(() => response, { preconnect: original.preconnect });
  afterEach(() => { globalThis.fetch = original; });
  const acct: AccountConfig = { name: 'first', type: 'chatgpt', accessToken: 'old', refreshToken: 'old-r', expiresAt: 1 };
  const config: Config = { ...createDefaultConfig(), accounts: [acct] };
  const manager = new AccountManager(config.accounts);
  const pending = manager.ensureTokenFresh(0);
  await syncAccountsFromDisk({ ...createDefaultConfig(), accounts: [{ ...acct, accessToken: 'import', refreshToken: 'import-r', expiresAt: Date.now() + 3600000 }] }, config, manager);
  finish(Response.json({ access_token: 'late', refresh_token: 'late-r' }));
  await pending;
  assert.equal(getAccount(manager, 0).credential, 'import');
});

test('an expired token recovers after a transient refresh outage', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = Object.assign(async () => new Response('', { status: 503 }), { preconnect: original.preconnect });
  afterEach(() => { globalThis.fetch = original; });
  const manager = new AccountManager([{ name: 'first', type: 'chatgpt', accessToken: 'old', refreshToken: 'refresh', expiresAt: 1 }]);
  await manager.ensureTokenFresh(0);
  const account = getAccount(manager, 0);
  assert.equal(account.status, 'throttled');
  assert.equal(account.refreshToken, 'refresh');
  account._refreshAfter = Date.now() - 1;
  account.rateLimitedUntil = Date.now() - 1;
  globalThis.fetch = Object.assign(async () => Response.json({ access_token: 'new' }), { preconnect: original.preconnect });
  await manager.ensureTokenFresh(0);
  assert.equal(account.status, 'active');
  assert.equal(account.credential, 'new');
  assert.equal(account.rateLimitedUntil, null);
});

test('replacing an identity under the same name discards old throttles and in-flight updates', async () => {
  const config: Config = { ...createDefaultConfig(), accounts: [{ name: 'shared-name', type: 'chatgpt', accountId: 'old-id', accessToken: 'old' }] };
  const manager = new AccountManager(config.accounts);
  const old = getAccount(manager, 0);
  manager.markRateLimited(old, 3600);
  await syncAccountsFromDisk({ ...createDefaultConfig(), accounts: [{ name: 'shared-name', type: 'chatgpt', accountId: 'new-id', accessToken: 'new' }] }, config, manager);
  manager.updateUsage(old, 100, 200);
  assert.equal(getAccount(manager, 0).status, 'active');
  assert.equal(getAccount(manager, 0).usage.totalInputTokens, 0);
  assert.equal(getAccount(manager, 0).credential, 'new');
});

function getAccount(manager: AccountManager, index: number) {
  const account = manager.accounts[index];
  assert.ok(account);
  return account;
}
