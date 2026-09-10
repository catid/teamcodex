import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { homedir,tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { atomicConfigUpdate, createDefaultConfig, getConfigPath,loadConfig, resetConfig, saveConfig } from '@teamcodex/proxy/config';
import { chmod,mkdtemp, readFile, rm, stat, writeFile } from '@teamcodex/shared/filesystem';
import { afterEach, beforeEach, describe, test } from 'bun:test';

const exec = promisify(execFile);

describe('config transactions, recovery, and permissions', () => {
  beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamcodex-config-'));
  const original = process.env.TEAMCODEX_CONFIG;
  process.env.TEAMCODEX_CONFIG = join(dir, 'config.json');
  afterEach(async () => {
    if (original === undefined) delete process.env.TEAMCODEX_CONFIG;
    else process.env.TEAMCODEX_CONFIG = original;
    await rm(dir, { recursive: true, force: true });
  });
  await saveConfig(createDefaultConfig());
  });

  test('concurrent processes preserve every update', async () => {
    const module = pathToFileURL(resolve('packages/proxy/src/config.ts')).href;
    await Promise.all(Array.from({ length: 8 }, (_, i) => exec(process.execPath, [
      '--input-type=module', '-e', `
        import { atomicConfigUpdate } from ${JSON.stringify(module)};
        await atomicConfigUpdate(async config => {
          await new Promise(resolve => setTimeout(resolve, 10));
          config.accounts.push({name: 'account-${i}', type: 'apikey', apiKey: 'test'});
        });`,
    ])));
    const config = await loadConfig();
    assert.ok(config);
    assert.equal(config.accounts.length, 8);
  });

  test('readers never observe partially written JSON', async () => {
    await Promise.all([
      ...Array.from({ length: 12 }, (_, i) => atomicConfigUpdate(c => { c.counter = i; })),
      (async () => { for (let i = 0; i < 80; i++) assert.ok(await loadConfig()); })(),
    ]);
  });

  test('failed updates leave the old config intact and release the lock', async () => {
    const before = await readFile(getConfigPath(), 'utf8');
    await assert.rejects(atomicConfigUpdate(c => { c.proxy.port = -1; }), /proxy.port/);
    assert.equal(await readFile(getConfigPath(), 'utf8'), before);
    await atomicConfigUpdate(c => { c.switchThreshold = 0; });
  });

  test('saving replaces overly broad existing permissions', async () => {
    await chmod(getConfigPath(), 0o644);
    await atomicConfigUpdate(c => { c.switchThreshold = 0.5; });
    assert.equal((await stat(getConfigPath())).mode & 0o777, 0o600);
  });

  test('reset backs up config, rotates the key, and keeps accounts', async () => {
    const before = await loadConfig();
    assert.ok(before);
    const { config, backupPath } = await resetConfig();
    assert.ok(backupPath);
    assert.deepEqual(config.accounts, before.accounts);
    assert.notEqual(config.proxy.apiKey, before.proxy.apiKey);
    assert.equal(config.switchThreshold, 0.98);
    assert.deepEqual(JSON.parse(await readFile(backupPath, 'utf8')), before);
    assert.equal((await stat(backupPath)).mode & 0o777, 0o600);
  });

  test('malformed config is backed up during reset', async () => {
    await writeFile(getConfigPath(), '{broken');
    const { config, backupPath } = await resetConfig();
    assert.ok(backupPath);
    assert.deepEqual(config.accounts, []);
    assert.equal(await readFile(backupPath, 'utf8'), '{broken');
  });

  test('quoted home paths expand correctly', () => {
    process.env.TEAMCODEX_CONFIG = '~/.config/custom-teamcodex.json';
    assert.equal(getConfigPath(), join(homedir(), '.config/custom-teamcodex.json'));
  });
});
