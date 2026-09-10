import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, test } from 'bun:test';

import { atomicWrite, mkdtemp, readdir, readFile, readTextFile, replaceFileIfMatching, rm, stat, withFileLock, writeFile } from '../src/filesystem.ts';

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'teamcodex-shared-'));
  afterEach(() => rm(dir, { recursive: true, force: true }));
  return { dir, path: join(dir, 'state.json') };
}

test('atomic writes use restrictive permissions and remove temporary files', async () => {
  const { dir, path } = await fixture();
  await atomicWrite(path, 'old');
  await atomicWrite(path, 'new');
  assert.equal(await readFile(path, 'utf8'), 'new');
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(dir), ['state.json']);
});

test('failed or rejected precommit preserves the destination and cleans temporary files', async () => {
  const { dir, path } = await fixture();
  await writeFile(path, 'original');
  assert.equal(await atomicWrite(path, 'rejected', { beforeCommit: () => false }), false);
  await assert.rejects(atomicWrite(path, 'failed', { beforeCommit: () => { throw new Error('stale'); } }), /stale/);
  assert.equal(await readFile(path, 'utf8'), 'original');
  assert.deepEqual(await readdir(dir), ['state.json']);
});

test('conditional replacement preserves a new login or changed live identity', async () => {
  const { path } = await fixture();
  await writeFile(path, 'new-login');
  assert.equal(await replaceFileIfMatching(path, 'refresh', 'old-login', () => true), false);
  assert.equal(await replaceFileIfMatching(path, 'refresh', 'new-login', () => false), false);
  assert.equal(await readFile(path, 'utf8'), 'new-login');
  assert.equal(await replaceFileIfMatching(path, 'refresh', 'new-login', () => true), true);
});

test('filesystem lock serializes transactions and releases after failure', async () => {
  const { path } = await fixture();
  const lock = `${path}.lock`;
  const locked = () => new Error('locked');
  let count = 0;
  await Promise.all(Array.from({ length: 4 }, () => withFileLock(lock, async () => {
    const previous = count;
    await new Promise(resolve => setTimeout(resolve, 5));
    count = previous + 1;
  }, locked)));
  assert.equal(count, 4);
  await assert.rejects(withFileLock(lock, async () => { throw new Error('failure'); }, locked), /failure/);
  assert.equal(await withFileLock(lock, async () => 'released', locked), 'released');
});

test('bounded reads reject oversized and non-file inputs without altering them', async () => {
  const { path, dir } = await fixture();
  const invalid = () => new Error('invalid history');
  await writeFile(path, '12345');
  assert.equal(await readTextFile(path, 5, invalid), '12345');
  await assert.rejects(readTextFile(path, 4, invalid), /invalid history/);
  await assert.rejects(readTextFile(dir, 5, invalid), /invalid history/);
  assert.equal(await readFile(path, 'utf8'), '12345');
});
