import { errorMessage } from './errors.js';
import { importCredentials } from './oauth.js';

export function findConfigAccount(config, account) {
  if (account.accountId) {
    const idx = config.accounts.findIndex(a => a.accountId === account.accountId);
    if (idx >= 0) return idx;
  }
  return config.accounts.findIndex(a => a.name === account.name);
}

export async function resolveAccounts(config) {
  const accounts = [];
  for (const entry of config.accounts) {
    let account = { ...entry };
    if (account.type === 'chatgpt' && account.importFrom && !account.accessToken) {
      try {
        account = { ...account, ...await importCredentials(account.importFrom === '~/.codex/auth.json' ? undefined : account.importFrom) };
      } catch (err) {
        console.error(errorMessage('ACCOUNT_IMPORT_FAILED', { name: account.name, message: err.message }));
        continue;
      }
    }
    if ((account.type === 'chatgpt' && account.accessToken) ||
        (account.type === 'apikey' && account.apiKey)) accounts.push(account);
  }
  return accounts;
}

export async function syncAccountsFromDisk(diskConfig, memConfig, manager, { removeMissing = false } = {}) {
  let added = 0, updated = 0, removed = 0;
  // Resolve all imports before publishing routing and account changes together.
  const resolved = await resolveAccounts(diskConfig);
  manager.routing = diskConfig.routing;
  manager.switchThreshold = diskConfig.switchThreshold ?? 0.98;
  for (const account of resolved) {
    const idx = findConfigAccount(manager, account);
    if (idx < 0) {
      manager.addAccount(account);
      memConfig.accounts.push(account);
      added++;
      continue;
    }
    let live = manager.accounts[idx];
    const metadata = {
      weight: account.weight ?? 1, enabled: account.enabled ?? true,
      switchThreshold: account.switchThreshold, name: account.name,
      type: account.type, accountId: account.accountId || null, planType: account.planType || null,
    };
    let accountUpdated = Object.entries(metadata).some(([key, value]) => live[key] !== value);
    if (live.type !== account.type || live.accountId !== (account.accountId || null)) {
      // Reusing a display name for another identity must not inherit its quota,
      // pending refresh, reset state, or in-flight response updates.
      live.index = -1;
      live = manager._buildAccount(account, idx);
      manager.accounts[idx] = live;
      accountUpdated = true;
    }
    const credential = account.type === 'apikey' ? account.apiKey : account.accessToken;
    const stale = account.type === 'chatgpt' && account.expiresAt && live.expiresAt &&
      account.expiresAt < live.expiresAt;
    const changed = live.type !== account.type || live.credential !== credential ||
      live.refreshToken !== (account.refreshToken || null);
    if (changed && !stale) {
      if (live._refreshAfter) {
        live._refreshAfter = null;
        live.rateLimitedUntil = null;
        if (live.status === 'throttled') live.status = 'active';
      }
      live.credential = credential;
      live.refreshToken = account.refreshToken || null;
      live.idToken = account.idToken || null;
      live.expiresAt = account.expiresAt || null;
      if (live.status === 'error') live.status = 'active';
      accountUpdated = true;
    }
    Object.assign(live, metadata);
    if (accountUpdated) updated++;
    memConfig.accounts[idx] = {
      ...account,
      ...(account.type === 'chatgpt' ? {
        accessToken: live.credential, refreshToken: live.refreshToken,
        idToken: live.idToken, expiresAt: live.expiresAt,
      } : { apiKey: live.credential }),
    };
  }
  if (removeMissing) {
    for (let i = manager.accounts.length - 1; i >= 0; i--) {
      if (findConfigAccount(diskConfig, manager.accounts[i]) < 0) {
        manager.removeAccount(i);
        memConfig.accounts.splice(i, 1);
        removed++;
      }
    }
  }
  memConfig.routing = manager.routing;
  memConfig.switchThreshold = manager.switchThreshold;
  return { added, updated, removed };
}
