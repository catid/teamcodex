import type { ResetState } from './config.ts';
import type { AccountIdentity } from './usage.ts';

export type AccountState = 'active' | 'throttled' | 'exhausted' | 'error';
export type AccountStatus = AccountState | 'disabled' | 'refreshing';

export interface Quota {
  primary: number | null;
  secondary: number | null;
  primaryReset: number | null;
  secondaryReset: number | null;
  primaryWindowMins: number | null;
  secondaryWindowMins: number | null;
  tokensLimit: number | null;
  tokensRemaining: number | null;
  requestsLimit: number | null;
  requestsRemaining: number | null;
  resetsAt: number | null;
}

export interface AdditionalQuota {
  name: string;
  utilization: number | null;
  resetAt: number | null;
  windowMinutes: number | null;
}

export interface AccountUsage {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalRequests: number;
  lastUsed: string | null;
}

export interface UsageResetStatus {
  availableCredits: number | null;
  checkedAt: string | null;
  lastResult: string | null;
  pending: boolean;
  lastAttemptAt?: ResetState['lastAttemptAt'] | null;
  lastCompletedAt?: ResetState['lastCompletedAt'] | null;
  nextEligibleAt?: string | null;
  retryAt?: string | null;
  checkError?: string | null;
}

export interface Account extends AccountIdentity {
  index: number;
  weight: number;
  enabled: boolean;
  switchThreshold: number | undefined;
  accountId: string | null;
  planType: string | null;
  credential: string | undefined;
  refreshToken: string | null;
  idToken: string | null;
  expiresAt: number | null;
  status: AccountState;
  quota: Quota;
  usage: AccountUsage;
  rateLimitedUntil: number | null;
  usageReset: UsageResetStatus;
  quotaUpdatedAt?: string;
  additionalQuota?: AdditionalQuota[];
  _refreshAfter?: number | null;
  _refreshPromise?: Promise<void> | null;
}

export function emptyQuota(): Quota {
  return { primary: null, secondary: null, primaryReset: null, secondaryReset: null,
    primaryWindowMins: null, secondaryWindowMins: null, tokensLimit: null,
    tokensRemaining: null, requestsLimit: null, requestsRemaining: null, resetsAt: null };
}

export function accountStatus(account: { enabled?: boolean; status: AccountState; _refreshPromise?: Promise<unknown> | null }): AccountStatus {
  if (account.enabled === false) return 'disabled';
  if (account._refreshPromise) return 'refreshing';
  return account.status;
}
