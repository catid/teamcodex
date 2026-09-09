import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, test } from 'bun:test';

import { atomicConfigUpdate, createDefaultConfig, loadConfig, resetConfig, saveConfig } from '../src/config.ts';

let directory: string | undefined;
const original = process.env.TEAMCODEX_CONFIG;
afterEach(async () => {
  if (original === undefined) delete process.env.TEAMCODEX_CONFIG;
  else process.env.TEAMCODEX_CONFIG = original;
  if (directory) await rm(directory, { recursive: true, force: true });
});

test('Bun transactions preserve concurrent updates and pending redemptions through reset', async () => {
  directory = await mkdtemp(join(tmpdir(), 'teamcodex-bun-config-'));
  const path = join(directory, 'config.json');
  process.env.TEAMCODEX_CONFIG = path;
  const initial = createDefaultConfig();
  initial.usageResetState = { 'chatgpt:a': { pendingRequestId: '12345678-1234-1234-1234-123456789012', lastAttemptAt: new Date().toISOString() } };
  await saveConfig(initial);
  await Promise.all(Array.from({ length: 8 }, (_, index) => atomicConfigUpdate(config => {
    config.accounts.push({ name: `account-${index}`, type: 'apikey', apiKey: 'fake' });
  })));
  expect((await loadConfig())?.accounts).toHaveLength(8);
  const { config, backupPath } = await resetConfig();
  expect(config.usageResetState).toEqual(initial.usageResetState);
  expect(config.accounts).toHaveLength(8);
  expect(config.proxy.apiKey).not.toBe(initial.proxy.apiKey);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect(backupPath).not.toBeNull();
  if (backupPath) expect(await readFile(backupPath, 'utf8')).toContain('12345678-1234-1234-1234-123456789012');
});
