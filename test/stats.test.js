import assert from 'node:assert/strict';
import { mkdtemp, readdir,readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { UsageStats } from '../src/stats.js';

const account = { type: 'chatgpt', accountId: 'stable-id', name: 'first', accessToken: 'secret' };
const HOUR = 3600000;
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'teamcodex-stats-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, 'usage.json');
}

test('totals and renamed-account history survive restart without storing credentials', async t => {
  const path = await fixture(t);
  let now = Date.parse('2026-09-09T23:59:00Z');
  const stats = await new UsageStats(path, { now: () => now }).load();
  stats.recordAttempt(account, false);
  stats.recordTokens(account, 100, 20, 80);
  stats.recordRequest({ status: 200, durationMs: 125, disconnected: false }, account);
  await stats.flush();
  now += 2 * 60000;
  const restarted = await new UsageStats(path, { now: () => now }).load();
  restarted.recordAttempt(account, true);
  restarted.recordTokens(account, 30, 10, 0);
  await restarted.flush();
  const snapshot = restarted.snapshot();
  assert.equal(snapshot.trackingSince, '2026-09-09T23:59:00.000Z');
  assert.equal(snapshot.totals.inputTokens, 130);
  assert.equal(snapshot.totals.outputTokens, 30);
  assert.equal(snapshot.totals.cachedInputTokens, 80);
  assert.equal(snapshot.totals.requests, 1);
  assert.equal(snapshot.totals.attempts, 2);
  assert.equal(snapshot.totals.retries, 1);
  assert.equal(snapshot.hourly.length, 24);
  assert.equal(snapshot.daily.length, 30);
  assert.deepEqual(snapshot.daily.slice(-2).map(b => b.inputTokens), [100, 30]);
  assert.deepEqual(snapshot.hourly.slice(-2).map(b => b.inputTokens), [100, 30]);
  assert.ok(snapshot.hourly.slice(0, -2).every(b => b.inputTokens === 0));
  assert.deepEqual(restarted.account({ ...account, name: 'renamed' }), snapshot.totals);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.doesNotMatch(await readFile(path, 'utf8'), /stable-id|first|secret|accessToken/);
});

test('retention drops old buckets while preserving cumulative totals', () => {
  let now = Date.parse('2026-01-01T01:00:00Z');
  const stats = new UsageStats(null, { now: () => now });
  for (let i = 0; i < 35 * 24; i++) {
    stats.recordTokens(account, 1, 1);
    now += HOUR;
  }
  const snapshot = stats.snapshot();
  assert.equal(snapshot.totals.inputTokens, 840);
  assert.ok(Object.keys(stats.data.hours).length <= 48);
  assert.ok(Object.keys(stats.data.days).length <= 30);
  assert.equal(snapshot.hourly.at(-1).inputTokens, 0);
  assert.equal(snapshot.hourly.at(-2).inputTokens, 1);
});

test('invalid token counts cannot poison totals and snapshots are detached', () => {
  const stats = new UsageStats();
  for (const value of [-1, NaN, Infinity, '10', 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    stats.recordTokens(account, value, value, value);
  }
  const snapshot = stats.snapshot();
  assert.equal(snapshot.totals.inputTokens, 0);
  snapshot.totals.inputTokens = 999;
  snapshot.hourly.at(-1).inputTokens = 999;
  stats.account(account).inputTokens = 999;
  assert.equal(stats.snapshot().totals.inputTokens, 0);
  assert.equal(stats.account(account).inputTokens, 0);
});

test('damaged or unsupported history is preserved and reported', async t => {
  const path = await fixture(t);
  for (const content of ['{broken', '{"version":99}', '{"version":1,"totals":{}}']) {
    await writeFile(path, content);
    const stats = await new UsageStats(path).load();
    stats.recordTokens(account, 2, 3);
    await stats.flush();
    assert.equal(await readFile(path, 'utf8'), content);
    assert.equal(stats.snapshot().persistence, 'error');
    assert.match(stats.snapshot().persistenceError, /Cannot load/);
    assert.equal(stats.snapshot().totals.outputTokens, 3);
  }
});

test('save failures remain visible and can recover on the next flush', async t => {
  const path = await fixture(t);
  const stats = new UsageStats(join(path, 'missing-dir.json'));
  stats.recordTokens(account, 4, 5);
  await stats.flush();
  assert.equal(stats.snapshot().persistence, 'error');
  assert.equal(stats.snapshot().totals.inputTokens, 4);
  stats.path = path;
  await stats.flush();
  assert.equal(stats.snapshot().persistence, 'enabled');
  assert.equal(JSON.parse(await readFile(path, 'utf8')).totals.outputTokens, 5);
});

test('records arriving during an atomic save are included by the coalesced flush', async t => {
  const path = await fixture(t);
  const stats = new UsageStats(path);
  stats.recordTokens(account, 5, 6);
  const saving = stats.flush();
  for (let i = 0; i < 100; i++) stats.recordTokens(account, 1, 2);
  const second = stats.flush();
  assert.equal(second, saving);
  await saving;
  assert.equal(JSON.parse(await readFile(path, 'utf8')).totals.inputTokens, 105);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).totals.outputTokens, 206);
  assert.deepEqual(await readdir(join(path, '..')), ['usage.json']);
});
