import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';

import { usageLines } from '@teamcodex/cli/tui/usage';
import type { AccountConfig } from '@teamcodex/core/config';
import { createError, errorResponse } from '@teamcodex/core/errors';
import type { Pool } from '@teamcodex/core/routing';
import { preserveAccountRouting, validateRouting } from '@teamcodex/core/routing';
import { AccountManager } from '@teamcodex/proxy/account-manager';
import { parseManualAuthInput } from '@teamcodex/proxy/auth/callback';
import { accountInfoFromTokens } from '@teamcodex/proxy/auth/tokens';
import { createDefaultConfig } from '@teamcodex/proxy/config';
import { createProxyServer } from '@teamcodex/proxy/server';
import { afterEach, test } from 'bun:test';

const accounts: AccountConfig[] = [{ name: 'a', type: 'apikey', apiKey: 'secret-a' }, { name: 'b', type: 'apikey', apiKey: 'secret-b' }];
const policy = <T>(pool: T) => ({ accounts, routing: { defaultPool: 'main', pools: { main: pool } } });
for (const [label, pool] of [
  ['duplicate members', { accounts: ['a', 'a'] }],
  ['unknown members', { accounts: ['ghost'] }],
  ['unsupported strategy', { accounts: ['a'], strategy: 'randomish' }],
  ['fractional concurrency', { accounts: ['a'], maxConcurrentRequests: 1.5 }],
  ['pool reset policy', { accounts: ['a'], autoReset: { enabled: true } }],
  ['unknown pool setting', { accounts: ['a'], switchTheshold: 0.5 }],
]) test(`routing rejects ${label}`, () => {
  assert.throws(() => validateRouting(policy(pool)), { code: 'ROUTING_CONFIG_INVALID' });
});

test('routing rejects non-string default pool instead of coercing it', () => {
  assert.throws(() => validateRouting({ accounts, routing: { defaultPool: 1, pools: { 1: { accounts: ['a'] } } } }), { code: 'ROUTING_CONFIG_INVALID' });
});
test('empty pool cannot spill traffic into unlisted accounts', () => {
  const manager = new AccountManager(accounts, 0.98, policy({ accounts: [] }).routing);
  assert.equal(manager.getActiveAccount(), null);
});
test('ordered failover skips disabled first member', () => {
  const manager = new AccountManager(accounts.map((account, index) => index === 0 ? { ...account, enabled: false } : account), 0.98, policy<Pool>({ accounts: ['a', 'b'], strategy: 'failover' }).routing);
  assert.equal(manager.getActiveAccount()?.name, 'b');
});
test('replacement credentials retain explicitly disabled routing state', () => {
  const next = { name: 'a' };
  preserveAccountRouting({}, { name: 'a', enabled: false, weight: 7, switchThreshold: 0 }, next);
  assert.deepEqual(next, { name: 'a', enabled: false, weight: 7, switchThreshold: 0 });
});
test('status never includes configured credentials', () => {
  const manager = new AccountManager([...accounts, { name: 'oauth', type: 'chatgpt', accessToken: 'private-access', refreshToken: 'private-refresh' }]);
  assert.doesNotMatch(JSON.stringify(manager.getStatus()), /secret-a|secret-b|private-access|private-refresh/);
});
test('serialized proxy errors omit native cause details', () => {
  const error = createError('PROXY_INTERNAL_ERROR', {}, { cause: new Error('private-secret') });
  assert.doesNotMatch(JSON.stringify(errorResponse(error.code)), /private-secret|stack|cause/);
});
test('malformed tokens do not invent an OAuth identity', () => {
  assert.equal(accountInfoFromTokens({ accessToken: 'not-a-jwt' }).accountId, null);
});
test('OAuth callback errors cannot bypass state verification', () => {
  assert.throws(() => parseManualAuthInput('http://localhost/?error=denied&state=wrong', 'expected'), { code: 'OAUTH_STATE_MISMATCH' });
});
test('empty usage pools display zero instead of NaN', () => {
  const lines = usageLines(new AccountManager([], 0.98, { defaultPool: 'empty', pools: { empty: { accounts: [] } } }).getStatus());
  assert.ok(lines.includes(' empty: 0 requests | in 0 | out 0'));
  assert.doesNotMatch(lines.join('\n'), /NaN|undefined/);
});
test.skipIf(!existsSync('.git'))('git ignores nested credentials and generated output but keeps examples', () => {
  for (const path of ['scratch/.env.production', 'scratch/auth.json', 'coverage/report.html', 'scripts/__pycache__/errors.pyc', 'src/debug.log']) {
    assert.doesNotThrow(() => execFileSync('git', ['check-ignore', '--no-index', path]));
  }
  for (const path of ['config.example.json', 'bun.lock', 'packages/core/src/errors.ts', 'apps/cli/src/index.ts']) {
    assert.throws(() => execFileSync('git', ['check-ignore', '--no-index', path]));
  }
});

for (const name of ['', 'toString']) test(`proxy rejects invalid explicit pool ${JSON.stringify(name)}`, async () => {
  const manager = new AccountManager(accounts);
  const server = createProxyServer(manager, createDefaultConfig());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  afterEach(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const res = await fetch(`http://127.0.0.1:${address.port}/responses`, { headers: { 'x-teamcodex-pool': name }, signal: AbortSignal.timeout(2000) });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, 'ROUTING_POOL_UNKNOWN');
});

test('disabled display status preserves the underlying auth failure', () => {
  const manager = new AccountManager([{ name: 'a', type: 'apikey', enabled: false }]);
  const account = manager.accounts[0];
  assert.ok(account);
  account.status = 'error';
  const status = manager.getStatus().accounts[0];
  assert.ok(status);
  assert.equal(status.status, 'disabled');
  assert.equal(status.underlyingStatus, 'error');
});
test('token refresh is visible without making a disabled account look available', async () => {
  const { accountStatus } = await import('@teamcodex/core/accounts');
  assert.equal(accountStatus({ status: 'active', _refreshPromise: Promise.resolve() }), 'refreshing');
  assert.equal(accountStatus({ status: 'active', enabled: false, _refreshPromise: Promise.resolve() }), 'disabled');
});
