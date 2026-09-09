import assert from 'node:assert/strict';

import type { AccountConfig } from '@teamcodex/core/config';
import type { RoutingConfig } from '@teamcodex/core/routing';
import { AccountManager } from '@teamcodex/proxy/account-manager';
import { test } from 'bun:test';
const accounts = [{ name: 'a', type: 'apikey', apiKey: 'a', weight: 3 }, { name: 'b', type: 'apikey', apiKey: 'b', weight: 1 }] satisfies AccountConfig[];
const routing: RoutingConfig = { defaultPool: 'main', pools: { main: { accounts: ['a', 'b'], strategy: 'weighted-round-robin' } } };
test('smooth weighted routing distributes requests and excludes unavailable accounts', () => {
  const manager = new AccountManager(accounts, 0.98, routing);
  const names = Array.from({ length: 40 }, () => manager.getActiveAccount('main')?.name);
  assert.equal(names.filter(n => n === 'a').length, 30);
  manager.markRateLimited(0, 60);
  assert.equal(manager.getActiveAccount('main')?.name, 'b');
});
test('pools isolate requests and account thresholds override pool defaults', () => {
  const manager = new AccountManager(accounts.map((account, index) => index === 0 ? { ...account, switchThreshold: 0.5 } : account), 0.98, routing);
  const first = manager.accounts[0];
  assert.ok(first);
  first.quota.primary = 0.6;
  assert.equal(manager.getActiveAccount('main')?.name, 'b');
  assert.throws(() => manager.getActiveAccount('missing'), { code: 'ROUTING_POOL_UNKNOWN' });
});
test('disabled accounts cannot route and empty pools fail closed', () => {
  const manager = new AccountManager(accounts.map(a => ({ ...a, enabled: false })), 0.98, routing);
  assert.equal(manager.getActiveAccount('main'), null);
});

test('routing config rejects ambiguous membership and invalid settings', async () => {
  const { validateRouting } = await import('@teamcodex/core/routing');
  for (const override of [
    { accounts: [{ ...accounts[0], weight: 0 }] },
    { accounts: [{ ...accounts[0], switchThreshold: 2 }] },
    { maxConcurrentRequests: 0 },
    { routing: { defaultPool: 'missing', pools: {} } },
    { routing: { defaultPool: 'main', pools: { main: { accounts: ['missing'] } } } },
  ]) assert.throws(() => validateRouting({ accounts, routing, ...override }), { code: 'ROUTING_CONFIG_INVALID' });
});

test('credential replacement preserves overrides and updates renamed memberships', async () => {
  const { preserveAccountRouting } = await import('@teamcodex/core/routing');
  const config = structuredClone(routing);
  const replacement = { name: 'renamed' };
  const first = accounts[0];
  assert.ok(first);
  preserveAccountRouting({ routing: config }, { ...first, enabled: false, switchThreshold: 0.8 }, replacement);
  assert.deepEqual(replacement, { name: 'renamed', weight: 3, enabled: false, switchThreshold: 0.8 });
  assert.deepEqual(config.pools.main?.accounts, ['renamed', 'b']);
});
