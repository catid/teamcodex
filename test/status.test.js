import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import test from 'node:test';
import { promisify } from 'node:util';

import { UsageStats } from '../src/stats.js';
import { displayWidth,renderStatus } from '../src/status.js';

const now = Date.parse('2026-09-09T12:00:00Z');
function fixture() {
  const account = { name: 'one@example.com', type: 'chatgpt', accountId: 'one', status: 'active', planType: 'pro',
    quota: { primary: 0, secondary: null, primaryReset: now + 3600000, primaryWindowMins: 300, secondaryWindowMins: 10080 },
    quotaUpdatedAt: new Date(now - 3600000).toISOString(),
    usageReset: { availableCredits: 0 }, auth: { expiresAt: new Date(now + 7200000).toISOString(), refreshAvailable: true } };
  const stats = new UsageStats(null, { now: () => now });
  stats.recordTokens(account, 10000, 2000, 5000);
  account.totals = stats.account(account);
  return { accounts: [account], currentAccount: account.name, rotationOrder: [account.name], switchThreshold: 0.98,
    autoReset: { enabled: true, threshold: 0.98, pollIntervalSeconds: 300 },
    statistics: stats.snapshot(), service: { uptimeSeconds: 3600, inFlight: 2 } };
}

test('dashboard reports aggregate totals without adding cached input twice', () => {
  const output = renderStatus(fixture(), { now });
  assert.match(output, /12,000 TOKENS/);
  assert.match(output, /Input 10K.*Output 2K.*Cached input 5K/);
  assert.match(output, /TOKENS \/ HOUR.*·{23}█/);
  assert.match(output, /TOKENS \/ DAY.*·{29}█/);
  assert.match(output, /Tracking since 2026-09-09 12:00:00 UTC/);
  assert.match(output, /5h.*0\.0% used/);
  assert.match(output, /Weekly.*unknown used/);
  assert.match(output, /Earned reset credits 0/);
  assert.match(output, /STALE/);
  assert.match(output, /2 requests in flight/);
  // eslint-disable-next-line no-control-regex -- Strip or test terminal control sequences.
  assert.doesNotMatch(output, /\x1b/);
});

test('expired cooldowns, pending resets and missing credentials are distinguishable', () => {
  const data = fixture();
  data.accounts[0].status = 'throttled';
  data.accounts[0].rateLimitedUntil = new Date(now - 1000).toISOString();
  data.accounts[0].usageReset = { pending: true, retryAt: new Date(now + 60000).toISOString() };
  let output = renderStatus(data, { now });
  assert.match(output, /1 ready/);
  assert.match(output, /Reset confirmation pending · retry in 1m/);
  assert.match(output, /Earned reset credits unknown/);
  data.accounts[0].status = 'error';
  output = renderStatus(data, { now });
  assert.match(output, /1 need attention/);
  assert.match(output, /Login needed/);
  assert.match(output, /Reauthenticate this account with teamcodex login/);
});

test('zero traffic shows an empty chart, and persistence errors are prominent', () => {
  const data = fixture();
  data.statistics = new UsageStats(null, { now: () => now }).snapshot();
  data.statistics.persistenceError = 'Cannot save usage history; current totals are in memory';
  const output = renderStatus(data, { now });
  assert.match(output, /0 TOKENS/);
  assert.match(output, /TOKENS \/ HOUR.*·{24}/);
  assert.match(output, /Cannot save usage history/);
  assert.doesNotMatch(output, /NaN|Infinity/);
});

test('wide, compact and narrow displays stay within terminal width and strip injected controls', () => {
  const data = fixture();
  data.accounts[0].name = `${'Long'.repeat(25)  }\x1b[31m\n\t测试\u202e`;
  data.currentAccount = data.accounts[0].name;
  data.rotationOrder = [data.accounts[0].name];
  for (const columns of [30, 40, 80, 85, 110, 140]) for (const compact of [true, false]) {
    const output = renderStatus(data, { columns, compact, now });
    assert.ok(output.split('\n').every(line => displayWidth(line) <= columns), `width ${columns}, compact ${compact}`);
  // eslint-disable-next-line no-control-regex -- Strip or test terminal control sequences.
    assert.doesNotMatch(output, /[\x1b\t\u202e]/);
  }
  const compact = renderStatus(fixture(), { compact: true, now });
  assert.match(compact, /ACCOUNT.*HEALTH.*PRIMARY.*SECONDARY/);
  assert.doesNotMatch(compact, /TOKENS \/ DAY/);
  const rows = compact.split('\n');
  assert.equal(rows.find(row => row.includes('ACCOUNT')).indexOf('HEALTH'), rows.find(row => row.includes('▸ one@example.com')).indexOf('Ready'));
});

test('JSON CLI emits only parseable data and sends authentication; errors fail clearly', async t => {
  let authenticated = false;
  let status = 200;
  const data = fixture();
  const server = http.createServer((req, res) => {
    authenticated = req.headers['x-api-key'] === 'fake-secret';
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(data));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const source = `import {statusCommand} from ${JSON.stringify(new URL('../src/status.js', import.meta.url).href)};
    await statusCommand({proxy:{apiKey:'fake-secret'}}, process.argv.slice(1));`;
  const run = (...args) => promisify(execFile)(process.execPath, ['--input-type=module', '-e', source, '--', ...args], {
    env: { ...process.env, TEAMCODEX_SERVER_URL: `http://127.0.0.1:${server.address().port}` }, timeout: 10000,
  });
  const result = await run('--json');
  assert.deepEqual(JSON.parse(result.stdout), data);
  assert.equal(result.stderr, '');
  assert.equal(authenticated, true);
  await assert.rejects(run('--json', '--compact'), /Usage: teamcodex status/);
  status = 401;
  await assert.rejects(run('--json'), /HTTP 401/);
});
