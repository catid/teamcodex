import assert from 'node:assert/strict';
import test from 'node:test';

import { usageLines } from '../src/usage-view.js';

test('usage totals describe shared membership without duplicating an account within a pool', () => {
  const lines = usageLines({ accounts: [{ name: 'a', status: 'active', usage: { totalRequests: 2, totalInputTokens: 12, totalOutputTokens: 8 } }], routing: { pools: { main: { accounts: ['a', 'a'] }, shared: { accounts: ['a'] } } } });
  assert.ok(lines.includes(' main: 2 requests | in 12 | out 8'));
  assert.ok(lines.includes(' shared: 2 requests | in 12 | out 8'));
  assert.ok(lines.includes(' a (API key) [active]'));
});
