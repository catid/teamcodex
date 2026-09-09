import { errorMessage } from '@teamcodex/core/errors';
import { preserveAccountRouting } from '@teamcodex/core/routing';
import { AccountManager } from '@teamcodex/proxy/account-manager';
import { findConfigAccount, resolveAccounts, syncAccountsFromDisk } from '@teamcodex/proxy/accounts';
import { updateCodexAuthIfMatching } from '@teamcodex/proxy/auth/persistence';
import { atomicConfigUpdate, getConfigPath, loadConfig, loadOrCreateConfig } from '@teamcodex/proxy/config';
import type { ProxyHooks } from '@teamcodex/proxy/http/types';
import { createProxyServer } from '@teamcodex/proxy/server';
import { UsageStats } from '@teamcodex/proxy/stats';
import { UsageResetMonitor } from '@teamcodex/proxy/usage-reset';

import { argValue } from '../arguments.ts';
import { TUI } from '../tui/controller.ts';

export async function serveCommand(args: string[]): Promise<void> {
  const config = await loadOrCreateConfig();

  // --log-to <dir>
  const logTo = argValue(args, '--log-to');
  if (logTo) config.logDir = logTo;

  if (config.accounts.length === 0) {
    console.error(errorMessage('NO_ACCOUNTS'));
    console.error('Add an account first:');
    console.error('  teamcodex import            Import from Codex CLI');
    console.error('  teamcodex login             OAuth login via browser');
    console.error('  teamcodex login --api       Add an OpenAI API key');
    process.exit(1);
  }

  const accounts = await resolveAccounts(config);
  if (accounts.length === 0) {
    console.error(errorMessage('NO_VALID_ACCOUNTS'));
    process.exit(1);
  }

  config.accounts = accounts;
  const threshold = config.switchThreshold ?? 0.98;
  const accountManager = new AccountManager(accounts, threshold, config.routing);
  const statistics = await new UsageStats(`${getConfigPath()}.usage.json`).load();
  accountManager.stats = statistics;

  // Persist refreshed tokens back to config (re-read from disk to avoid clobbering
  // accounts added externally, e.g. by `teamcodex import` while server is running)
  accountManager.onTokenRefresh(async (idx, newTokens, previousRefreshToken) => {
    const account = accountManager.accounts[idx];
    if (!account) return;
    const memIdx = findConfigAccount(config, account);
    const memory = config.accounts[memIdx];
    if (memory) Object.assign(memory, newTokens);
    let persisted = false;
    await atomicConfigUpdate(diskConfig => {
      const cfgIdx = findConfigAccount(diskConfig, account);
      const diskAccount = diskConfig.accounts[cfgIdx];
      if (diskAccount && (!diskAccount.refreshToken || diskAccount.refreshToken === previousRefreshToken)) {
        Object.assign(diskAccount, newTokens);
        persisted = true;
      }
    });
    if (persisted) await updateCodexAuthIfMatching(account, newTokens);
  });
  const port = Number(process.env.TEAMCODEX_LISTEN_PORT || config.proxy.port);
  const useTUI = process.stdout.isTTY && process.stdin.isTTY;

  // Re-read config from disk and sync accounts into the running server.
  // Reached from the TUI (R key) and the /teamcodex/reload endpoint that
  // `teamcodex login/import/remove` hit after writing the config.
  let reloadPending: Promise<unknown> = Promise.resolve();
  const reloadAccounts = (options: { removeMissing?: boolean } = {}) => {
    const next = reloadPending.then(async () => {
      const diskConfig = await loadConfig();
      if (!diskConfig) return { added: 0, updated: 0, removed: 0 };
      return syncAccountsFromDisk(diskConfig, config, accountManager, options);
    });
    reloadPending = next.catch(() => {});
    return next;
  };

  let tui: TUI | null = null;
  const hooks: ProxyHooks = { reloadAccounts };

  if (useTUI) {
    tui = new TUI({
      accountManager, config,
      saveConfig: change => atomicConfigUpdate(diskConfig => {
        const remove = 'remove' in change ? change.remove : undefined;
        const upsert = 'upsert' in change ? change.upsert : undefined;
        if (remove) {
          const idx = findConfigAccount(diskConfig, remove);
          if (idx >= 0) {
            const name = diskConfig.accounts[idx]?.name;
            diskConfig.accounts.splice(idx, 1);
            for (const pool of Object.values(diskConfig.routing?.pools ?? {})) pool.accounts = pool.accounts.filter(member => member !== name);
          }
        }
        if (upsert) {
          const idx = findConfigAccount(diskConfig, upsert);
          if (idx >= 0) {
            const previous = diskConfig.accounts[idx];
            if (previous) preserveAccountRouting(diskConfig, previous, upsert);
            diskConfig.accounts[idx] = { ...diskConfig.accounts[idx], ...upsert };
          }
          else diskConfig.accounts.push(upsert);
        }
      }),
      syncAccounts: reloadAccounts,
      onQuit: () => shutdown(),
    });
    hooks.onRequestStart = (id, info) => tui?.onRequestStart(id, info);
    hooks.onRequestRouted = (id, info) => tui?.onRequestRouted(id, info);
    hooks.onRequestEnd = (id, info) => tui?.onRequestEnd(id, info);
  }

  const usageMonitor = new UsageResetMonitor(accountManager, config);
  hooks.onAccountsUnavailable = () => usageMonitor.recover();
  const server = createProxyServer(accountManager, config, hooks);
  server.once('close', () => usageMonitor.stop());

  server.on('error', err => {
    if (tui?.running) tui.stop();
    console.error(errorMessage('PROXY_START_FAILED', { message: err.message }));
    process.exitCode = 1;
  });
  server.listen(port, process.env.TEAMCODEX_LISTEN_HOST || config.proxy.host || '127.0.0.1', () => {
    usageMonitor.start();
    if (tui) {
      tui.start();
      console.log(`Listening on port ${port} with ${accounts.length} account(s)`);
    } else {
      const sep = '='.repeat(60);
      console.log('');
      console.log(sep);
      console.log('  TeamCodex Proxy');
      console.log(sep);
      console.log(`  Port:       ${port}`);
      console.log(`  Accounts:   ${accounts.length}`);
      console.log(`  Threshold:  ${(threshold * 100).toFixed(0)}%`);
      console.log(`  Upstream:   ${config.upstream || 'https://chatgpt.com'}`);
      console.log('');
      accounts.forEach((a, i) => {
        console.log(`  [${i + 1}] ${a.name} (${a.type}${a.planType ? `, ${  a.planType}` : ''})`);
      });
      console.log('');
      console.log('  Run Codex through proxy:  teamcodex run');
      console.log('  Show codex overrides:     teamcodex env');
      console.log(sep);
      console.log('');
    }
  });

  let shuttingDown = false;
  function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    usageMonitor.stop();
    if (tui?.running) tui.stop();
    const finish = async () => { await statistics.flush(); process.exit(0); };
    server.close(finish);
    const timer = setTimeout(() => { server.closeAllConnections(); setImmediate(finish); }, 5000);
    timer.unref();
    // Leave time for normal request close events and persistence, but never hang shutdown on disk I/O.
    setTimeout(() => process.exit(0), 8000).unref();
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
