import assert from 'node:assert/strict';
import test from 'node:test';

import { AccountManager } from '../src/account-manager.js';
import { telemetry } from '../src/telemetry.js';

test('telemetry normalizes account metrics and avoids counting shared pools twice', () => {
  const manager = new AccountManager([{ name: 'one', type: 'apikey', apiKey: 'secret' }], 0.98, {
    defaultPool: 'a', pools: { a: { accounts: ['one'] }, b: { accounts: ['one'] } },
  });
  manager.accounts[0].usage.totalRequests = 7;
  const view = telemetry(manager.getStatus());
  assert.equal(view.totals.requests, 7);
  assert.equal(view.pools[0].totals.requests, 7);
  assert.equal(view.pools[1].totals.requests, 7);
  assert.equal(view.accounts[0].auth, 'API key');
  assert.equal(view.accounts[0].resets, null);
  assert.ok(!JSON.stringify(view).includes('secret'));
});

test('dashboard panels stay inside short supported terminal heights', async () => {
  const { dashboard } = await import('../src/tui-panels.js');
  const manager = new AccountManager([]);
  const tui = { am: manager, mode: 'normal', active: new Map(), log: [], _renderAcct: () => '' };
  assert.equal(dashboard(tui, 40, 4).length, 4);
});

for (const [width, height] of [[40, 4], [60, 16], [80, 20], [120, 28]]) {
  test(`dashboard fits ${width} columns and ${height} rows`, async () => {
    const { dashboard } = await import('../src/tui-panels.js');
    const { vw } = await import('../src/tui-style.js');
    const manager = new AccountManager([{ name: 'example', type: 'apikey', apiKey: 'fake' }]);
    const tui = { am: manager, mode: 'normal', active: new Map(), log: [], _renderAcct: () => 'example' };
    const lines = dashboard(tui, width, height);
    assert.equal(lines.length, height);
    assert.ok(lines.every(line => vw(line) === width));
    if (width === 60) assert.ok(lines.some(line => line.includes('Telemetry')));
  });
}
