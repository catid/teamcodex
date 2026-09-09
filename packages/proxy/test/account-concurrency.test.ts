import type { AccountConfig } from '@teamcodex/core/config';
import { afterEach, expect, test } from 'bun:test';

import { AccountManager } from '../src/account-manager.ts';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test('weighted account pools retain identity and ignore disabled members', () => {
  const accounts: AccountConfig[] = [
    { name: 'a', type: 'apikey', apiKey: 'fake-a', weight: 3 },
    { name: 'b', type: 'apikey', apiKey: 'fake-b', weight: 1 },
  ];
  const manager = new AccountManager(accounts, 0.98, { defaultPool: 'main', pools: { main: { accounts: ['a', 'b'] } } });
  const names = Array.from({ length: 40 }, () => manager.getActiveAccount()?.name);
  expect(names.filter(name => name === 'a')).toHaveLength(30);
  const account = manager.accounts.find(candidate => candidate.name === 'a');
  if (!account) throw new Error('Missing fixture account');
  account.enabled = false;
  expect(manager.getActiveAccount()?.name).toBe('b');
  manager.removeAccount(account.index);
  manager.updateUsage(account, 100, 50);
  expect(manager.accounts[0]?.usage.totalInputTokens).toBe(0);
});

test('concurrent refresh coalesces and removed identity rejects a late token response', async () => {
  let calls = 0;
  const response = Promise.withResolvers<Response>();
  const started = Promise.withResolvers<void>();
  globalThis.fetch = Object.assign(async () => {
    calls++;
    started.resolve();
    return response.promise;
  }, { preconnect: originalFetch.preconnect });
  const manager = new AccountManager([{ name: 'oauth', type: 'chatgpt', accessToken: 'old', refreshToken: 'refresh', expiresAt: 1 }]);
  const original = manager.accounts[0];
  if (!original) throw new Error('Missing fixture account');
  const first = manager.ensureTokenFresh(original);
  await started.promise;
  const second = manager.ensureTokenFresh(original);
  manager.removeAccount(0);
  manager.addAccount({ name: 'oauth', type: 'chatgpt', accessToken: 'replacement' });
  response.resolve(Response.json({ access_token: 'late', refresh_token: 'late-refresh' }));
  await Promise.all([first, second]);
  expect(calls).toBe(1);
  expect(manager.accounts[0]?.credential).toBe('replacement');
  expect(original.credential).toBe('old');
});
