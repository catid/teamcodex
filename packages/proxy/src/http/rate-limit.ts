import type { ServerResponse } from 'node:http';

import type { Account } from '@teamcodex/core/accounts';
import { errorResponse } from '@teamcodex/core/errors';

import type { AccountManager } from '../account-manager.ts';

export function computeAccountRetryAfter(account: Account, fallbackSeconds: number): number {
  const now = Date.now();
  const resets = [
    account.rateLimitedUntil,
    account.quota?.primaryReset,
    account.quota?.secondaryReset,
    account.quota?.resetsAt,
  ].filter((reset): reset is number => typeof reset === 'number' && Number.isFinite(reset) && reset > now);

  if (resets.length === 0) return fallbackSeconds;
  return Math.max(1, Math.ceil((Math.min(...resets) - now) / 1000));
}

export function writeAllAccountsRateLimited(res: ServerResponse, accountManager: AccountManager): void {
  const status = accountManager.getStatus();
  const retryAfter = computeRetryAfter(status.accounts);
  res.writeHead(429, {
    'Content-Type': 'application/json',
    'retry-after': String(retryAfter),
  });
  res.end(JSON.stringify(errorResponse('ACCOUNTS_RATE_LIMITED', { count: accountManager.accounts.length, seconds: retryAfter })));
}

export function computeRetryAfter(accounts: ReturnType<AccountManager['getStatus']>['accounts']): number {
  let soonest = Infinity;
  for (const acct of accounts) {
    const reset = (acct.rateLimitedUntil ? new Date(acct.rateLimitedUntil).getTime() : null)
      || acct.quota.primaryReset || acct.quota.secondaryReset || acct.quota.resetsAt;
    if (reset) {
      const ms = reset - Date.now();
      if (ms < soonest) soonest = ms;
    }
  }
  return soonest === Infinity ? 60 : Math.max(1, Math.ceil(soonest / 1000));
}

export function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, Math.ceil((date - Date.now()) / 1000)) : null;
}
