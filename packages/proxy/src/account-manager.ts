import { randomInt } from 'node:crypto';

import type { Account } from '@teamcodex/core/accounts';
import { accountStatus, emptyQuota } from '@teamcodex/core/accounts';
import { AdaptiveRouting } from '@teamcodex/core/adaptive-routing';
import type { AccountConfig, ResetPolicy } from '@teamcodex/core/config';
import { createError, errorMessage } from '@teamcodex/core/errors';
import { updateQuotaHeaders } from '@teamcodex/core/quota-headers';
import type { RoutingConfig } from '@teamcodex/core/routing';
import { tokenCount } from '@teamcodex/core/usage';
import { WeightedRoundRobin } from '@teamcodex/core/weighted-routing';

import type { Credentials } from './auth/tokens.ts';
import { isTokenExpiringSoon, refreshAccessToken } from './auth/tokens.ts';
import type { UsageStats } from './stats.ts';

export class AccountManager {
  accounts: Account[];
  rotationOrder: number[];
  currentIndex: number;
  switchThreshold: number;
  routing: RoutingConfig | undefined;
  readonly adaptive: AdaptiveRouting;
  private readonly scheduler: WeightedRoundRobin;
  private readonly randomIndex: (max: number) => number;
  autoReset?: Partial<ResetPolicy>;
  usagePolling?: { running: boolean; lastStartedAt?: string; lastCompletedAt?: string };
  stats?: UsageStats;
  private _onTokenRefresh?: (index: number, tokens: Credentials, previousToken: string, previousCredential: string | undefined) => void | Promise<void>;
  constructor(accounts: AccountConfig[], switchThreshold = 0.98, routing: RoutingConfig | undefined = undefined, { randomIndex = randomInt }: { randomIndex?: (max: number) => number } = {}) {
    this.accounts = accounts.map((acct, index) => this._buildAccount(acct, index));
    this.randomIndex = randomIndex;
    // Keep config/display indexes stable; shuffle only the routing schedule.
    this.rotationOrder = this.accounts.map(a => a.index);
    for (let i = this.rotationOrder.length - 1; i > 0; i--) {
      const j = this.randomIndex(i + 1);
      const left = this.rotationOrder[i];
      const right = this.rotationOrder[j];
      if (left !== undefined && right !== undefined) {
        this.rotationOrder[i] = right;
        this.rotationOrder[j] = left;
      }
    }
    this.currentIndex = this.rotationOrder[0] ?? 0;
    this.switchThreshold = switchThreshold;
    this.routing = routing;
    this.scheduler = new WeightedRoundRobin();
    this.adaptive = new AdaptiveRouting();
  }

  _resolveAccount(account: number | Account): Account | undefined {
    return typeof account === 'number' ? this.accounts[account] :
      this.accounts.includes(account) ? account : undefined;
  }

  _buildAccount(acct: AccountConfig, index: number): Account {
    return {
      index,
      name: acct.name,
      weight: acct.weight ?? 1,
      enabled: acct.enabled ?? true,
      switchThreshold: acct.switchThreshold,
      type: acct.type,
      accountId: acct.accountId || null,
      planType: acct.planType || null,
      credential: acct.type === 'apikey' ? acct.apiKey : acct.accessToken,
      refreshToken: acct.refreshToken || null,
      idToken: acct.idToken || null,
      expiresAt: acct.expiresAt || null,
      status: 'active',
      quota: emptyQuota(),
      usage: {
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalRequests: 0,
        lastUsed: null,
      },
      rateLimitedUntil: null,
      usageReset: { availableCredits: null, checkedAt: null, lastResult: null, pending: false },
    };
  }

  /**
   * Get the best available account, rotating if the current one is near quota.
   * Returns null if all accounts are exhausted.
   */
  getActiveAccount(poolName?: string, excluded: ReadonlySet<Account> = new Set()): Account | null {
    if (this.routing || poolName) {
      const name = poolName ?? this.routing?.defaultPool;
      const pool = name ? this.routing?.pools[name] : undefined;
      if (!pool || !name) throw createError('ROUTING_POOL_UNKNOWN', { name: name ?? '' });
      const members = pool.accounts.map(name => this.accounts.find(a => a.name === name)).filter((account): account is Account => account !== undefined);
      const eligible = members.filter(a => this._isUsable(a));
      const untried = eligible.filter(a => !excluded.has(a));
      const usable = untried.length ? untried : eligible;
      const preferred = usable.filter(a => !this._isNearQuota(a, pool.switchThreshold));
      const candidates = preferred.length ? preferred : usable;
      const chosen = pool.strategy === 'failover' ? candidates[0] ?? null : this.scheduler.select(name, candidates, pool.strategy === 'adaptive' ? a => this.adaptive.weight(a, a.weight) : undefined);
      if (chosen) this.currentIndex = chosen.index;
      return chosen;
    }
    const current = this.accounts[this.currentIndex];
    if (this._isAvailable(current)) {
      return current;
    }
    return this._selectNext();
  }

  rotateAfter(account: number | Account): Account | null {
    // A pending retry can outlive a reload/removal; don't use its stale index.
    const live = this._resolveAccount(account);
    if (live) this.currentIndex = live.index;
    return this._selectNext();
  }

  isAccountEligible(account: Account, poolName?: string): boolean {
    if (!this.accounts.includes(account) || !this._isUsable(account)) return false;
    if (!this.routing && poolName === undefined) return true;
    const name = poolName ?? this.routing?.defaultPool;
    return name ? this.routing?.pools[name]?.accounts.includes(account.name) ?? false : false;
  }

  _isAvailable(account: Account | undefined): account is Account {
    return this._isUsable(account) && !this._isNearQuota(account);
  }

  /**
   * Whether an account can be sent requests at all: not throttled by a real
   * upstream 429, not exhausted, not errored. Being near the switch threshold
   * does NOT make an account unusable — the threshold only expresses a
   * preference for rotating to a fresher account when one exists.
   */
  _isUsable(account: Account | undefined): account is Account {
    if (!account || !account.enabled) return false;

    // Check rate limit expiry
    if (account.status === 'throttled' && account.rateLimitedUntil) {
      if (Date.now() < account.rateLimitedUntil) return false;
      account.status = 'active';
      account.rateLimitedUntil = null;
      console.log(`[TeamCodex] Account "${account.name}" rate limit expired, marking active`);
    }

    if (account.status === 'exhausted' || account.status === 'error') return false;

    return true;
  }

  /**
   * Worst-case quota utilization (0-1) across all tracked windows.
   */
  _utilization(account: Account): number {
    const q = account.quota;
    let used = 0;
    if (q.primary != null) used = Math.max(used, q.primary);
    if (q.secondary != null) used = Math.max(used, q.secondary);
    if (q.tokensLimit != null && q.tokensRemaining != null) {
      used = Math.max(used, 1 - (q.tokensRemaining / q.tokensLimit));
    }
    if (q.requestsLimit != null && q.requestsRemaining != null) {
      used = Math.max(used, 1 - (q.requestsRemaining / q.requestsLimit));
    }
    return used;
  }

  _isNearQuota(account: Account, poolThreshold?: number): boolean {
    const threshold = account.switchThreshold ?? poolThreshold ?? this.switchThreshold;
    const q = account.quota;
    const now = Date.now();

    // Clear expired Codex window quotas
    if (q.primary != null && q.primaryReset && now >= q.primaryReset) {
      console.log(`[TeamCodex] Account "${account.name}" 5h quota reset`);
      q.primary = null;
      q.primaryReset = null;
    }
    if (q.secondary != null && q.secondaryReset && now >= q.secondaryReset) {
      console.log(`[TeamCodex] Account "${account.name}" weekly quota reset`);
      q.secondary = null;
      q.secondaryReset = null;
    }

    // Clear expired standard quotas
    if (q.resetsAt && now >= q.resetsAt) {
      q.tokensRemaining = null;
      q.tokensLimit = null;
      q.requestsRemaining = null;
      q.requestsLimit = null;
      q.resetsAt = null;
    }

    // Codex windows (ChatGPT accounts) — utilization is already 0-1
    if (q.primary != null && q.primary >= threshold) return true;
    if (q.secondary != null && q.secondary >= threshold) return true;

    // Standard quotas (API key accounts)
    if (q.tokensLimit != null && q.tokensRemaining != null) {
      const used = 1 - (q.tokensRemaining / q.tokensLimit);
      if (used >= threshold) return true;
    }

    if (q.requestsLimit != null && q.requestsRemaining != null) {
      const used = 1 - (q.requestsRemaining / q.requestsLimit);
      if (used >= threshold) return true;
    }

    return false;
  }

  _selectNext(): Account | null {
    const startIndex = this.rotationOrder.indexOf(this.currentIndex);

    for (let i = 1; i <= this.accounts.length; i++) {
      const idx = this.rotationOrder[(startIndex + i) % this.accounts.length];
      const account = idx === undefined ? undefined : this.accounts[idx];

      if (idx !== undefined && this._isAvailable(account)) {
        this.currentIndex = idx;
        console.log(`[TeamCodex] Switched to account "${account.name}"`);
        return account;
      }
    }

    // Every account is at/over the switch threshold or throttled. The
    // threshold is only a rotation preference — the backend is the authority
    // on quota, so keep serving from the least-utilized usable account until
    // upstream actually 429s it (which throttles it via markRateLimited).
    let best: Account | null = null;
    for (let i = 1; i <= this.accounts.length; i++) {
      const index = this.rotationOrder[(startIndex + i) % this.accounts.length];
      const account = index === undefined ? undefined : this.accounts[index];
      if (!this._isUsable(account)) continue;
      if (!best || this._utilization(account) < this._utilization(best)) {
        best = account;
      }
    }

    if (best) {
      if (best.index !== this.currentIndex) {
        this.currentIndex = best.index;
        console.log(`[TeamCodex] All accounts near quota — using least-utilized "${best.name}" until upstream throttles it`);
      }
      return best;
    }

    return null;
  }

  /**
   * Update an account's quota tracking from upstream response headers.
   */
  updateQuota(accountIndex: number | Account, headers: Record<string, string | undefined>): void {
    const account = this._resolveAccount(accountIndex);
    if (!account) return;
    const q = account.quota;

    if (Object.keys(headers).some(key => key.startsWith('x-codex-') || key.startsWith('x-ratelimit-'))) {
      account.quotaUpdatedAt = new Date().toISOString();
    }
    updateQuotaHeaders(q, headers);

    account.usage.totalRequests++;
    account.usage.lastUsed = new Date().toISOString();

    // Log when approaching quota
    if (this._isNearQuota(account)) {
      const pct = q.primary != null
        ? (Math.max(q.primary, q.secondary || 0) * 100).toFixed(1)
        : q.tokensLimit
          ? ((1 - (q.tokensRemaining ?? 0) / q.tokensLimit) * 100).toFixed(1)
          : '?';
      console.log(`[TeamCodex] Account "${account.name}" at ${pct}% usage — will switch on next request`);
    }
  }

  /**
   * Update cumulative token usage from response body data.
   */
  updateUsage(accountIndex: number | Account, inputTokens: unknown, outputTokens: unknown, cachedInputTokens: unknown = 0) {
    const account = this._resolveAccount(accountIndex);
    // An in-flight response can outlive removal. Keep its history without
    // charging a different account that now occupies the old array index.
    const historical = account || (accountIndex && typeof accountIndex === 'object' ? accountIndex : null);
    if (historical) this.stats?.recordTokens(historical, inputTokens, outputTokens, cachedInputTokens);
    if (!account) return;
    account.usage.totalInputTokens += tokenCount(inputTokens);
    account.usage.totalOutputTokens += tokenCount(outputTokens);
  }

  /**
   * Mark an account as rate-limited for a given duration.
   */
  markRateLimited(accountIndex: number | Account, retryAfterSeconds: number) {
    const account = this._resolveAccount(accountIndex);
    if (!account) return;
    account.status = 'throttled';
    account.rateLimitedUntil = Date.now() + (retryAfterSeconds * 1000);
    console.log(`[TeamCodex] Account "${account.name}" rate limited for ${retryAfterSeconds}s`);
  }

  /**
   * Mark an account's credentials as rejected upstream (a 401 that a token
   * refresh could not fix, e.g. revoked refresh token or bad API key). The
   * account is skipped until it gets new tokens (re-login/import + reload).
   */
  markAuthFailed(accountIndex: number | Account) {
    const account = this._resolveAccount(accountIndex);
    if (!account) return;
    account.status = 'error';
    console.log(`[TeamCodex] Account "${account.name}" credentials rejected — switching accounts. Fix with: teamcodex login`);
  }

  /**
   * Ensure a ChatGPT account's token is fresh, refreshing if needed.
   * Pass force=true to refresh regardless of expiry (e.g. after a 401).
   * Concurrent calls for the same account coalesce into a single refresh.
   */
  async ensureTokenFresh(accountIndex: number | Account, force = false): Promise<void> {
    const account = this._resolveAccount(accountIndex);
    if (!account || account.type !== 'chatgpt' || !account.refreshToken) return;

    if (account._refreshAfter && Date.now() < account._refreshAfter) return;
    if (!force && !isTokenExpiringSoon(account.expiresAt)) return;

    // Coalesce concurrent refreshes
    if (account._refreshPromise) return account._refreshPromise;

    const refreshToken = account.refreshToken;
    const previousCredential = account.credential;
    account._refreshPromise = (async () => {
      console.log(`[TeamCodex] Refreshing token for account "${account.name}"...`);
      try {
        const newTokens = await refreshAccessToken(refreshToken);
        // A removal or re-import may have happened while the request was pending.
        if (!this.accounts.includes(account) || account.refreshToken !== refreshToken || account.credential !== previousCredential) return;
        if (account._refreshAfter) {
          account.status = 'active';
          account.rateLimitedUntil = null;
          account._refreshAfter = null;
        }
        account.credential = newTokens.accessToken;
        account.refreshToken = newTokens.refreshToken;
        if (newTokens.idToken) account.idToken = newTokens.idToken;
        account.expiresAt = newTokens.expiresAt;
        console.log(`[TeamCodex] Token refreshed for account "${account.name}"`);
        try {
          await this._onTokenRefresh?.(account.index, newTokens, refreshToken, previousCredential);
        } catch (err) {
          console.error(errorMessage('TOKEN_PERSIST_FAILED', { message: (err instanceof Error ? err.message : String(err)) }));
        }
      } catch (err) {
        if (!this.accounts.includes(account) || account.refreshToken !== refreshToken || account.credential !== previousCredential) return;
        console.error(errorMessage('ACCOUNT_REFRESH_FAILED', { name: account.name, message: (err instanceof Error ? err.message : String(err)) }));
        // A revoked/invalid grant is permanent — stop re-attempting the
        // refresh on every request. The access token may still work until it
        // expires; after that the 401 path rotates to another account.
        const permanent = /invalid_grant|revoked|refresh failed \(40[013]\)/i.test((err instanceof Error ? err.message : String(err)));
        if (permanent) {
          account.refreshToken = null;
        }
        // A forced refresh means upstream already rejected the access token
        // (401), so a future expiresAt doesn't make it usable — mark it
        // errored now so rotation happens. Otherwise only mark error once
        // the token actually expires; a failed proactive refresh shouldn't
        // kill a still-valid token.
        if (force || !account.expiresAt || Date.now() >= account.expiresAt) {
          if (permanent) account.status = 'error';
          else {
            account._refreshAfter = Date.now() + 60_000;
            this.markRateLimited(account, 60);
          }
        } else if (!permanent) {
          account._refreshAfter = Date.now() + 60_000;
        }
      } finally {
        account._refreshPromise = null;
      }
    })();

    return account._refreshPromise;
  }

  /**
   * Set a callback to persist refreshed tokens to config.
   */
  onTokenRefresh(callback: (index: number, tokens: Credentials, previousToken: string, previousCredential: string | undefined) => void | Promise<void>) {
    this._onTokenRefresh = callback;
  }

  /**
   * Add a new account at runtime.
   */
  addAccount(acctData: AccountConfig) {
    const index = this.accounts.length;
    this.accounts.push(this._buildAccount(acctData, index));
    this.rotationOrder.splice(this.randomIndex(this.rotationOrder.length + 1), 0, index);
    return index;
  }

  /**
   * Remove an account by index.
   */
  removeAccount(index: number) {
    if (index < 0 || index >= this.accounts.length) return;
    const current = this.accounts[this.currentIndex];
    const position = this.rotationOrder.indexOf(index);
    const nextIndex = this.rotationOrder[(position + 1) % this.rotationOrder.length];
    const next = nextIndex === undefined ? undefined : this.accounts[nextIndex];
    const removed = this.accounts[index];
    if (!removed) return;
    removed.index = -1;
    this.accounts.splice(index, 1);
    this.accounts.forEach((a, i) => { a.index = i; });
    this.rotationOrder = this.rotationOrder.filter(i => i !== index).map(i => i > index ? i - 1 : i);
    this.currentIndex = Math.max(0, current && current.index >= 0 ? current.index : next?.index ?? 0);
  }

  /**
   * Return a status summary of all accounts (safe to expose, no credentials).
   */
  getStatus() {
    return {
      currentAccount: this.accounts[this.currentIndex]?.name,
      rotationOrder: this.rotationOrder.flatMap(i => this.accounts[i] ? [this.accounts[i].name] : []),
      switchThreshold: this.switchThreshold,
      autoReset: this.autoReset,
      routing: this.routing,
      usagePolling: this.usagePolling ? { ...this.usagePolling } : null,
      statistics: this.stats?.snapshot() || null,
      accounts: this.accounts.map(a => ({
        name: a.name,
        weight: a.weight,
        adaptive: this.adaptive.status(a),
        enabled: a.enabled,
        switchThreshold: a.switchThreshold,
        type: a.type,
        planType: a.planType,
        status: accountStatus(a),
        underlyingStatus: a.status,
        auth: {
          expiresAt: a.expiresAt !== null && Number.isFinite(a.expiresAt) && a.expiresAt > 0 && a.expiresAt < 8.64e15 ? new Date(a.expiresAt).toISOString() : null,
          refreshAvailable: Boolean(a.refreshToken), refreshing: Boolean(a._refreshPromise),
          retryAt: typeof a._refreshAfter === 'number' && Number.isFinite(a._refreshAfter) ? new Date(a._refreshAfter).toISOString() : null,
        },
        additionalQuota: (a.additionalQuota || []).map(q => ({ ...q })),
        quotaUpdatedAt: a.quotaUpdatedAt || null,
        totals: this.stats?.account(a) || null,
        quota: { ...a.quota },
        usage: { ...a.usage },
        usageReset: { ...a.usageReset },
        rateLimitedUntil: a.rateLimitedUntil
          ? new Date(a.rateLimitedUntil).toISOString()
          : null,
      })),
    };
  }
}
