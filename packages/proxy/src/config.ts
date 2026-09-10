import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import type { Config } from '@teamcodex/core/config';
import { isRecord, validateConfig } from '@teamcodex/core/config';
import { createError } from '@teamcodex/core/errors';
import { atomicWrite, chmod, copyFile, readFile, withFileLock } from '@teamcodex/shared/filesystem';

export function getConfigPath(): string {
  if (process.env.TEAMCODEX_CONFIG) return resolve(expandHome(process.env.TEAMCODEX_CONFIG));
  const configDir = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return resolve(expandHome(configDir), 'teamcodex.json');
}

function expandHome(path: string): string {
  return path === '~' ? homedir() : path.replace(/^~\//, `${homedir()}/`);
}

export function createDefaultConfig(): Config {
  return {
    proxy: {
      host: '127.0.0.1',
      port: 1456,
      apiKey: `tcx-${  randomBytes(24).toString('base64url')}`,
    },
    upstream: 'https://chatgpt.com',
    apiUpstream: 'https://api.openai.com',
    switchThreshold: 0.98,
    autoReset: { enabled: true, threshold: 0.98, pollIntervalSeconds: 300 },
    retry: { maxRetries: 2, headerTimeoutSeconds: 60, idleTimeoutSeconds: 120 },
    accounts: [],
  };
}

export async function loadConfig(): Promise<Config | null> {
  const path = getConfigPath();
  try {
    const config: unknown = JSON.parse(await readFile(path, 'utf-8'));
    validateConfig(config);
    return config;
  } catch (err) {
    if ((isRecord(err) ? err.code : undefined) === 'ENOENT') return null;
    throw err;
  }
}

export async function loadOrCreateConfig(): Promise<Config> {
  return withConfigLock(async () => {
    let config = await loadConfig();
    if (!config) {
      config = createDefaultConfig();
      await writeConfig(config);
      console.error(`Created config at ${getConfigPath()}`);
    }
    return config;
  });
}

export async function saveConfig(config: Config): Promise<void> {
  return withConfigLock(() => writeConfig(config));
}

async function writeConfig(config: Config): Promise<void> {
  validateConfig(config);
  const path = getConfigPath();
  await atomicWrite(path, `${JSON.stringify(config, null, 2)}\n`, { createDirectory: true });
}

function withConfigLock<T>(action: () => Promise<T>): Promise<T> {
  const lock = `${getConfigPath()}.lock`;
  return withFileLock(lock, action, cause => createError('CONFIG_LOCKED', { lock }, { cause }));
}

/**
 * Atomically update the config: re-reads from disk, calls updater(config),
 * then saves. Returns the updated config. This prevents overwriting changes
 * made by other processes (e.g. `teamcodex import` while the server runs).
 */
export async function atomicConfigUpdate(updater: (config: Config) => void | Promise<void>): Promise<Config> {
  return withConfigLock(async () => {
    const config = await loadConfig() || createDefaultConfig();
    await updater(config);
    await writeConfig(config);
    return config;
  });
}

/** Reset installation settings and rotate the proxy key, preserving accounts. */
export async function resetConfig(): Promise<{ config: Config; backupPath: string | null }> {
  return withConfigLock(async () => {
    const path = getConfigPath();
    let backupPath = null;
    let previous: unknown = null;
    try {
      const raw = await readFile(path, 'utf-8');
      backupPath = `${path}.backup-${Date.now()}-${randomBytes(4).toString('hex')}`;
      await copyFile(path, backupPath);
      await chmod(backupPath, 0o600);
      try { previous = JSON.parse(raw); } catch { /* Preserve malformed config in backup. */ }
    } catch (err) {
      if ((isRecord(err) ? err.code : undefined) !== 'ENOENT') throw err;
    }
    const config = createDefaultConfig();
    if (isRecord(previous) && Array.isArray(previous.accounts)) {
      const recovered: unknown = { ...config, accounts: previous.accounts };
      validateConfig(recovered);
      config.accounts = recovered.accounts;
    }
    // Resetting installation settings must not bypass a redemption cooldown
    // or forget a POST whose provider-side outcome is still unknown.
    if (isRecord(previous) && previous.usageResetState !== undefined) {
      const recovered: unknown = { ...config, usageResetState: previous.usageResetState };
      validateConfig(recovered);
      if (recovered.usageResetState) config.usageResetState = recovered.usageResetState;
    }
    await writeConfig(config);
    return { config, backupPath };
  });
}
