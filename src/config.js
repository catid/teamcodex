import { randomBytes } from 'node:crypto';
import { chmod,copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { createError } from './errors.js';
import { validateRouting } from './routing.js';

export function getConfigPath() {
  if (process.env.TEAMCODEX_CONFIG) return resolve(expandHome(process.env.TEAMCODEX_CONFIG));
  const configDir = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return resolve(expandHome(configDir), 'teamcodex.json');
}

function expandHome(path) {
  return path === '~' ? homedir() : path.replace(/^~\//, `${homedir()}/`);
}

export function createDefaultConfig() {
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

export async function loadConfig() {
  const path = getConfigPath();
  try {
    const config = JSON.parse(await readFile(path, 'utf-8'));
    validateConfig(config);
    return config;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export async function loadOrCreateConfig() {
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

export async function saveConfig(config) {
  return withConfigLock(() => writeConfig(config));
}

function validateConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw createError('CONFIG_INVALID');
  }
  const port = config.proxy?.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw createError('CONFIG_PORT_INVALID');
  }
  if (typeof config.proxy.apiKey !== 'string' || !config.proxy.apiKey.trim()) {
    throw createError('CONFIG_KEY_INVALID');
  }
  if (config.proxy.host !== undefined &&
      (typeof config.proxy.host !== 'string' || !config.proxy.host.trim())) {
    throw createError('CONFIG_HOST_INVALID');
  }
  if (!Array.isArray(config.accounts) || config.accounts.some(a =>
    !a || typeof a.name !== 'string' || !a.name.trim() || !['chatgpt', 'apikey'].includes(a.type))) {
    throw createError('CONFIG_ACCOUNTS_INVALID');
  }
  validateRouting(config);
  if (config.switchThreshold !== undefined &&
      (!Number.isFinite(config.switchThreshold) || config.switchThreshold < 0 || config.switchThreshold > 1)) {
    throw createError('CONFIG_THRESHOLD_INVALID');
  }
  if (config.retry !== undefined) {
    const r = config.retry;
    if (!r || typeof r !== 'object' || Array.isArray(r) ||
        (r.maxRetries !== undefined && (!Number.isInteger(r.maxRetries) || r.maxRetries < 0 || r.maxRetries > 5)) ||
        ['headerTimeoutSeconds', 'idleTimeoutSeconds'].some(key => r[key] !== undefined &&
          (!Number.isFinite(r[key]) || r[key] < 1 || r[key] > 600))) {
      throw createError('CONFIG_RETRY_INVALID');
    }
  }
  if (config.autoReset !== undefined) {
    const policy = config.autoReset;
    if (!policy || typeof policy !== 'object' || Array.isArray(policy) ||
        (policy.enabled !== undefined && typeof policy.enabled !== 'boolean') ||
        (policy.threshold !== undefined && (!Number.isFinite(policy.threshold) || policy.threshold < 0.01 || policy.threshold > 1)) ||
        (policy.pollIntervalSeconds !== undefined && (!Number.isInteger(policy.pollIntervalSeconds) || policy.pollIntervalSeconds < 30 || policy.pollIntervalSeconds > 3600))) {
      throw createError('CONFIG_RESET_POLICY_INVALID');
    }
  }
  if (config.usageResetState !== undefined) {
    const states = config.usageResetState;
    if (!states || typeof states !== 'object' || Array.isArray(states) || Object.values(states).some(state =>
      !state || typeof state !== 'object' || Array.isArray(state) ||
      (['lastAttemptAt', 'lastStartedAt'].some(key => state[key] !== undefined && (typeof state[key] !== 'string' || !Number.isFinite(Date.parse(state[key]))))) ||
      (state.pendingRequestId !== undefined && (typeof state.pendingRequestId !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(state.pendingRequestId))))) {
      throw createError('CONFIG_RESET_STATE_INVALID');
    }
  }
  for (const key of ['upstream', 'apiUpstream']) {
    if (config[key] === undefined) continue;
    const url = new URL(config[key]);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw createError('CONFIG_UPSTREAM_INVALID', { key });
    }
  }
}

async function writeConfig(config) {
  validateConfig(config);
  const path = getConfigPath();
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(config, null, 2)  }\n`, { mode: 0o600, flag: 'wx' });
    await rename(tmp, path);
  } finally {
    await rm(tmp, { force: true });
  }
}

// mkdir is exclusive on both macOS and Linux. Hold the lock across the entire
// read/modify/write transaction, including updates from other CLI processes.
async function withConfigLock(action) {
  const lock = `${getConfigPath()}.lock`;
  await mkdir(dirname(lock), { recursive: true });
  const deadline = Date.now() + 10_000;
  while (true) {
    try {
      await mkdir(lock, { mode: 0o700 });
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (Date.now() >= deadline) {
        throw createError('CONFIG_LOCKED', { lock }, { cause: err });
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  try {
    return await action();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

/**
 * Atomically update the config: re-reads from disk, calls updater(config),
 * then saves. Returns the updated config. This prevents overwriting changes
 * made by other processes (e.g. `teamcodex import` while the server runs).
 */
export async function atomicConfigUpdate(updater) {
  return withConfigLock(async () => {
    const config = await loadConfig() || createDefaultConfig();
    await updater(config);
    await writeConfig(config);
    return config;
  });
}

/** Reset installation settings and rotate the proxy key, preserving accounts. */
export async function resetConfig() {
  return withConfigLock(async () => {
    const path = getConfigPath();
    let backupPath = null;
    let previous = null;
    try {
      const raw = await readFile(path, 'utf-8');
      backupPath = `${path}.backup-${Date.now()}-${randomBytes(4).toString('hex')}`;
      await copyFile(path, backupPath);
      await chmod(backupPath, 0o600);
      try { previous = JSON.parse(raw); } catch { /* Preserve malformed config in backup. */ }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    const config = createDefaultConfig();
    if (Array.isArray(previous?.accounts)) config.accounts = previous.accounts;
    // Resetting installation settings must not bypass a redemption cooldown
    // or forget a POST whose provider-side outcome is still unknown.
    if (previous?.usageResetState !== undefined) config.usageResetState = previous.usageResetState;
    await writeConfig(config);
    return { config, backupPath };
  });
}
