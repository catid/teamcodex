import type { Account } from '@teamcodex/core/accounts';
import type { RetryPolicy } from '@teamcodex/core/retry';

export interface RequestInfo { method: string | undefined; path: string | undefined }
export interface ProxyHooks {
  reloadAccounts?: (options: { removeMissing: boolean }) => unknown | Promise<unknown>;
  onAccountsUnavailable?: () => void | Promise<void>;
  onRequestStart?: (id: number, info: RequestInfo) => void;
  onRequestRouted?: (id: number, info: { account: string }) => void;
  onRequestEnd?: (id: number, info: RequestInfo & { account: string | null; status: number | null }) => void;
}

export interface Upstreams {
  upstream: string;
  apiUpstream: string;
  retry: RetryPolicy;
}

export interface RequestContext {
  account: string | null;
  accountRef: Account | null;
  status: number | null;
  attempts: number;
  excluded: Set<Account>;
  poolName: string | undefined;
  maxAccountRetries: number;
  networkRetries: number;
  recovered: boolean;
  refreshed: Set<Account>;
}
