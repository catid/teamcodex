import assert from 'node:assert/strict';

import { telemetry } from '@teamcodex/core/telemetry';
import { AccountManager } from '@teamcodex/proxy/account-manager';
import { test } from 'bun:test';

test('telemetry normalizes account metrics and avoids counting shared pools twice', () => {
  const manager = new AccountManager([{ name: 'one', type: 'apikey', apiKey: 'secret' }], 0.98, {
    defaultPool: 'a', pools: { a: { accounts: ['one'] }, b: { accounts: ['one'] } },
  });
  const account = manager.accounts[0];
  assert.ok(account);
  account.usage.totalRequests = 7;
  const view = telemetry(manager.getStatus());
  assert.equal(view.totals.requests, 7);
  assert.equal(view.pools[0]?.totals.requests, 7);
  assert.equal(view.pools[1]?.totals.requests, 7);
  assert.equal(view.accounts[0]?.auth, 'API key');
  assert.equal(view.accounts[0]?.resets, null);
  assert.ok(!JSON.stringify(view).includes('secret'));
});

test('dashboard panels stay inside short supported terminal heights', async () => {
  const { dashboard } = await import('../src/tui/panels.ts');
  const manager = new AccountManager([]);
  const tui = { am: manager, mode: 'normal', active: new Map(), log: [], _renderAcct: () => '' };
  assert.equal(dashboard(tui, 40, 4).length, 4);
});

for (const [width, height] of [[40, 4], [60, 16], [80, 20], [120, 28]] as const) {
  test(`dashboard fits ${width} columns and ${height} rows`, async () => {
    const { dashboard } = await import('../src/tui/panels.ts');
    const { vw } = await import('../src/tui/style.ts');
    const manager = new AccountManager([{ name: 'example', type: 'apikey', apiKey: 'fake' }]);
    const tui = { am: manager, mode: 'normal', active: new Map(), log: [], _renderAcct: () => 'example' };
    const lines = dashboard(tui, width, height);
    assert.equal(lines.length, height);
    assert.ok(lines.every(line => vw(line) === width));
    if (width === 60) assert.ok(lines.some(line => line.includes('Telemetry')));
  });
}

for (const width of [40, 60, 120]) {
  test(`usage panel preserves long metrics and clamps scroll at ${width} columns`, async () => {
    const { usagePanel } = await import('../src/tui/panels.ts');
    const { vw } = await import('../src/tui/style.ts');
    const result = usagePanel([' Pools (member account totals)', 'x'.repeat(150), 'last account'], width, 6, 999);
    assert.equal(result.lines.length, 6);
    assert.ok(result.lines.every(line => vw(line) === width));
    assert.ok(result.lines[0]?.includes('Usage'));
    assert.ok(result.lines.some(line => line.includes('last account')));
    assert.ok(result.offset < 999);
  });
}

test('device login uses the shared frame without hiding its code or URL', async () => {
  const { devicePrompt } = await import('../src/tui/login.ts');
  const { vw } = await import('../src/tui/style.ts');
  const lines = devicePrompt('https://auth.openai.com/codex/device', 'TUI-CODE', 60);
  assert.ok(lines[0]?.includes('╭─ Device login'));
  assert.ok(lines.some(line => line.includes('TUI-CODE')));
  assert.ok(lines.some(line => line.includes('https://auth.openai.com/codex/device')));
  assert.ok(lines.every(line => vw(line) === 60));
});

test('browser panel wraps the complete authorization URL without dropping characters', async () => {
  const { browserPrompt } = await import('../src/tui/login.ts');
  const { vw } = await import('../src/tui/style.ts');
  const url = `https://auth.openai.com/oauth/authorize?state=${'x'.repeat(150)}`;
  const lines = browserPrompt(url, 60);
  assert.ok(lines[0]?.includes('╭─ Browser login'));
  assert.ok(lines.every(line => vw(line) === 60));
  const start = lines.findIndex(line => line.includes('https://'));
  const count = Math.ceil(url.length / 56);
  const text = lines.slice(start, start + count).map(line => line.replaceAll(String.fromCharCode(27), '').replace(/\[[0-9;]*m/g, '').slice(2, -1).trimEnd()).join('');
  assert.equal(text, url);
});
