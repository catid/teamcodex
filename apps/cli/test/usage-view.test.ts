import assert from 'node:assert/strict';

import { usageLines } from '@teamcodex/cli/tui/usage';
import { AccountManager } from '@teamcodex/proxy/account-manager';
import { test } from 'bun:test';

test('usage totals describe shared membership without duplicating an account within a pool', () => {
  const manager = new AccountManager([{ name: 'a', type: 'apikey', apiKey: 'mock' }], 0.98, { defaultPool: 'main', pools: { main: { accounts: ['a', 'a'] }, shared: { accounts: ['a'] } } });
  const account = manager.accounts[0];
  assert.ok(account);
  account.usage = { totalRequests: 2, totalInputTokens: 12, totalOutputTokens: 8, lastUsed: null };
  const lines = usageLines(manager.getStatus());
  assert.ok(lines.includes(' main: 2 requests | in 12 | out 8'));
  assert.ok(lines.includes(' shared: 2 requests | in 12 | out 8'));
  assert.ok(lines.includes(' a (API key) [active]'));
});
