import assert from 'node:assert/strict';

import { AdaptiveRouting } from '@teamcodex/core/adaptive-routing';
import type { AccountConfig } from '@teamcodex/core/config';
import type { RoutingConfig } from '@teamcodex/core/routing';
import { validateRouting } from '@teamcodex/core/routing';
import { AccountManager } from '@teamcodex/proxy/account-manager';
import { test } from 'bun:test';

const accounts = [{ name: 'a', type: 'apikey', apiKey: 'a', weight: 3 }, { name: 'b', type: 'apikey', apiKey: 'b', weight: 1 }] satisfies AccountConfig[];
const routing: RoutingConfig = { defaultPool: 'main', pools: { main: { accounts: ['a', 'b'], strategy: 'adaptive' } } };

test('adaptive configuration preserves pool and quota eligibility', () => {
  validateRouting({ accounts, routing });
  const manager = new AccountManager(accounts, 0.98, routing);
  const first = manager.accounts[0];
  assert.ok(first);
  first.enabled = false;
  assert.equal(manager.getActiveAccount()?.name, 'b');
  const second = manager.accounts[1];
  assert.ok(second);
  second.status = 'error';
  assert.equal(manager.getActiveAccount(), null);
});

test('adaptive routing retains configured shares with equal performance', () => {
  const manager = new AccountManager(accounts, 0.98, routing);
  const names = Array.from({ length: 40 }, () => manager.getActiveAccount()?.name);
  assert.equal(names.filter(name => name === 'a').length, 30);
});

test('latency, failures and active attempts reduce weight and stale evidence recovers', () => {
  let now = 0;
  const adaptive = new AdaptiveRouting(() => now);
  const a = {};
  const b = {};
  const lease = adaptive.start(a);
  assert.ok(adaptive.weight(a, 1) < adaptive.weight(b, 1));
  now = 2000;
  lease.observe(false);
  lease.release();
  lease.release();
  assert.equal(adaptive.status(a).inFlight, 0);
  assert.ok(adaptive.weight(a, 1) < adaptive.weight(b, 1));
  now += 600_000;
  assert.ok(adaptive.weight(a, 1) > 0.99);
  assert.equal(adaptive.status(b).samples, 0);
});

test('adaptive selection shifts traffic but continues probing slower accounts', () => {
  const manager = new AccountManager(accounts.map(a => ({ ...a, weight: 1 })), 0.98, routing);
  const first = manager.accounts[0];
  assert.ok(first);
  const slow = manager.adaptive.start(first);
  slow.observe(false, 5000);
  slow.release();
  const names = Array.from({ length: 100 }, () => manager.getActiveAccount()?.name);
  const slowCount = names.filter(name => name === 'a').length;
  assert.ok(slowCount > 0 && slowCount < 20, String(slowCount));
});


test('fast failures do not appear preferable to an unmeasured healthy account', () => {
  const adaptive = new AdaptiveRouting(() => 0);
  const failed = {};
  const lease = adaptive.start(failed);
  lease.observe(true, 1);
  lease.release();
  assert.ok(adaptive.weight(failed, 1) < adaptive.weight({}, 1));
});
