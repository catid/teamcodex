import assert from 'node:assert/strict';
import test from 'node:test';

import { AccountManager } from '../src/account-manager.js';
const accounts = [{ name: 'a', type: 'apikey', apiKey: 'a', weight: 3 }, { name: 'b', type: 'apikey', apiKey: 'b', weight: 1 }];
const routing = { defaultPool: 'main', pools: { main: { accounts: ['a', 'b'], strategy: 'weighted-round-robin' } } };
test('smooth weighted routing distributes requests and excludes unavailable accounts', () => {
  const manager = new AccountManager(accounts, 0.98, routing);
  const names = Array.from({ length: 40 }, () => manager.getActiveAccount('main').name);
  assert.equal(names.filter(n => n === 'a').length, 30);
  manager.markRateLimited(manager.accounts[0], 60);
  assert.equal(manager.getActiveAccount('main').name, 'b');
});
test('pools isolate requests and account thresholds override pool defaults', () => {
  const manager = new AccountManager([{ ...accounts[0], switchThreshold: 0.5 }, accounts[1]], 0.98, routing);
  manager.accounts[0].quota.primary = 0.6;
  assert.equal(manager.getActiveAccount('main').name, 'b');
  assert.throws(() => manager.getActiveAccount('missing'), { code: 'ROUTING_POOL_UNKNOWN' });
});
test('disabled accounts cannot route and empty pools fail closed', () => {
  const manager = new AccountManager(accounts.map(a => ({ ...a, enabled: false })), 0.98, routing);
  assert.equal(manager.getActiveAccount('main'), null);
});

test('routing config rejects ambiguous membership and invalid settings', async () => {
  const { validateRouting } = await import('../src/routing.js');
  for (const override of [
    { accounts: [{ ...accounts[0], weight: 0 }] },
    { accounts: [{ ...accounts[0], switchThreshold: 2 }] },
    { maxConcurrentRequests: 0 },
    { routing: { defaultPool: 'missing', pools: {} } },
    { routing: { defaultPool: 'main', pools: { main: { accounts: ['missing'] } } } },
  ]) assert.throws(() => validateRouting({ accounts, routing, ...override }), { code: 'ROUTING_CONFIG_INVALID' });
});

test('credential replacement preserves overrides and updates renamed memberships', async () => {
  const { preserveAccountRouting } = await import('../src/routing.js');
  const config = structuredClone(routing);
  const replacement = { name: 'renamed' };
  preserveAccountRouting({ routing: config }, { ...accounts[0], enabled: false, switchThreshold: 0.8 }, replacement);
  assert.deepEqual(replacement, { name: 'renamed', weight: 3, enabled: false, switchThreshold: 0.8 });
  assert.deepEqual(config.pools.main.accounts, ['renamed', 'b']);
});
