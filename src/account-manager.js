import { accountStatus } from './account-status.js';
import { AdaptiveRouting } from './adaptive-routing.js';
import { createError, errorMessage } from './errors.js';
import { isTokenExpiringSoon,refreshAccessToken } from './oauth.js';
import { WeightedRoundRobin } from './routing.js';

function emptyQuota() {
  return {
    // Codex rate limit windows (ChatGPT accounts)
    primary: null,         // utilization 0-1 (5h window)
    secondary: null,       // utilization 0-1 (weekly window)
    primaryReset: null,    // ms timestamp
    secondaryReset: null,  // ms timestamp
    primaryWindowMins: null,
    secondaryWindowMins: null,
    // Standard API rate limits (API key accounts)
    tokensLimit: null,
    tokensRemaining: null,
    requestsLimit: null,
    requestsRemaining: null,
    resetsAt: null,
  };
}

/**
 * Parse a reset header value into a ms timestamp.
 * Codex sends `x-codex-*-reset-at` as unix seconds; be tolerant of ms too.
 */
function parseResetAt(value) {
  const n = Number(value);
  if (Number.isNaN(n)) {
    const t = Date.parse(value);
    return Number.isNaN(t) ? null : t;
  }
  return n < 1e12 ? n * 1000 : n;
}

/**
 * Parse OpenAI x-ratelimit-reset-* durations like "1s", "6m0s", "250ms".
 */
function parseResetDuration(value) {
  if (!value) return null;
  let ms = 0;
  const re = /(\d+(?:\.\d+)?)(ms|s|m|h|d)/g;
  let match = re.exec(value);
  let any = false;
  while (match !== null) {
    any = true;
    const n = parseFloat(match[1]);
    switch (match[2]) {
      case 'ms': ms += n; break;
      case 's': ms += n * 1000; break;
      case 'm': ms += n * 60_000; break;
      case 'h': ms += n * 3_600_000; break;
      case 'd': ms += n * 86_400_000; break;
    }
    match = re.exec(value);
  }
  return any ? Date.now() + ms : null;
}

export class AccountManager {
  constructor(accounts, switchThreshold = 0.98, routing = undefined) {
    this.accounts = accounts.map((acct, index) => this._buildAccount(acct, index));
    this.currentIndex = 0;
    this.switchThreshold = switchThreshold;
    this.routing = routing;
    this.scheduler = new WeightedRoundRobin();
    this.adaptive = new AdaptiveRouting();
  }

  _resolveAccount(account) {
    return typeof account === 'number' ? this.accounts[account] :
      this.accounts.includes(account) ? account : undefined;
  }

  _buildAccount(acct, index) {
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
  getActiveAccount(poolName) {
    if (this.routing || poolName) {
      const name = poolName ?? this.routing?.defaultPool;
      const pool = this.routing?.pools[name];
      if (!pool) throw createError('ROUTING_POOL_UNKNOWN', { name: name ?? '' });
      const members = pool.accounts.map(name => this.accounts.find(a => a.name === name)).filter(Boolean);
      const usable = members.filter(a => this._isUsable(a));
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

  _isAvailable(account) {
    return this._isUsable(account) && !this._isNearQuota(account);
  }

  /**
   * Whether an account can be sent requests at all: not throttled by a real
   * upstream 429, not exhausted, not errored. Being near the switch threshold
   * does NOT make an account unusable — the threshold only expresses a
   * preference for rotating to a fresher account when one exists.
   */
  _isUsable(account) {
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
  _utilization(account) {
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

  _isNearQuota(account, poolThreshold) {
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

  _selectNext() {
    const startIndex = this.currentIndex;

    for (let i = 1; i <= this.accounts.length; i++) {
      const idx = (startIndex + i) % this.accounts.length;
      const account = this.accounts[idx];

      if (this._isAvailable(account)) {
        this.currentIndex = idx;
        console.log(`[TeamCodex] Switched to account "${account.name}"`);
        return account;
      }
    }

    // Every account is at/over the switch threshold or throttled. The
    // threshold is only a rotation preference — the backend is the authority
    // on quota, so keep serving from the least-utilized usable account until
    // upstream actually 429s it (which throttles it via markRateLimited).
    let best = null;
    for (const account of this.accounts) {
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
  updateQuota(accountIndex, headers) {
    const account = this._resolveAccount(accountIndex);
    if (!account) return;
    const q = account.quota;

    // Codex rate limit windows (ChatGPT accounts) — percent is 0-100
    const pUsed = parseFloat(headers['x-codex-primary-used-percent']);
    const sUsed = parseFloat(headers['x-codex-secondary-used-percent']);
    if (!Number.isNaN(pUsed)) q.primary = pUsed / 100;
    if (!Number.isNaN(sUsed)) q.secondary = sUsed / 100;

    const pWin = parseInt(headers['x-codex-primary-window-minutes'], 10);
    const sWin = parseInt(headers['x-codex-secondary-window-minutes'], 10);
    if (!Number.isNaN(pWin)) q.primaryWindowMins = pWin;
    if (!Number.isNaN(sWin)) q.secondaryWindowMins = sWin;

    if (headers['x-codex-primary-reset-at']) {
      q.primaryReset = parseResetAt(headers['x-codex-primary-reset-at']);
    } else if (headers['x-codex-primary-reset-after-seconds']) {
      q.primaryReset = Date.now() + parseFloat(headers['x-codex-primary-reset-after-seconds']) * 1000;
    }
    if (headers['x-codex-secondary-reset-at']) {
      q.secondaryReset = parseResetAt(headers['x-codex-secondary-reset-at']);
    } else if (headers['x-codex-secondary-reset-after-seconds']) {
      q.secondaryReset = Date.now() + parseFloat(headers['x-codex-secondary-reset-after-seconds']) * 1000;
    }

    // Standard rate limits (API key accounts)
    const tokensLimit = parseInt(headers['x-ratelimit-limit-tokens'], 10);
    const tokensRemaining = parseInt(headers['x-ratelimit-remaining-tokens'], 10);
    const requestsLimit = parseInt(headers['x-ratelimit-limit-requests'], 10);
    const requestsRemaining = parseInt(headers['x-ratelimit-remaining-requests'], 10);

    if (!Number.isNaN(tokensLimit)) q.tokensLimit = tokensLimit;
    if (!Number.isNaN(tokensRemaining)) q.tokensRemaining = tokensRemaining;
    if (!Number.isNaN(requestsLimit)) q.requestsLimit = requestsLimit;
    if (!Number.isNaN(requestsRemaining)) q.requestsRemaining = requestsRemaining;

    const reset = parseResetDuration(headers['x-ratelimit-reset-tokens'])
      || parseResetDuration(headers['x-ratelimit-reset-requests']);
    if (reset) q.resetsAt = reset;

    account.usage.totalRequests++;
    account.usage.lastUsed = new Date().toISOString();

    // Log when approaching quota
    if (this._isNearQuota(account)) {
      const pct = q.primary != null
        ? (Math.max(q.primary, q.secondary || 0) * 100).toFixed(1)
        : q.tokensLimit
          ? ((1 - q.tokensRemaining / q.tokensLimit) * 100).toFixed(1)
          : '?';
      console.log(`[TeamCodex] Account "${account.name}" at ${pct}% usage — will switch on next request`);
    }
  }

  /**
   * Update cumulative token usage from response body data.
   */
  updateUsage(accountIndex, inputTokens, outputTokens) {
    const account = this._resolveAccount(accountIndex);
    if (!account) return;
    if (inputTokens) account.usage.totalInputTokens += inputTokens;
    if (outputTokens) account.usage.totalOutputTokens += outputTokens;
  }

  /**
   * Mark an account as rate-limited for a given duration.
   */
  markRateLimited(accountIndex, retryAfterSeconds) {
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
  markAuthFailed(accountIndex) {
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
  async ensureTokenFresh(accountIndex, force = false) {
    const account = this._resolveAccount(accountIndex);
    if (!account || account.type !== 'chatgpt' || !account.refreshToken) return;

    if (account._refreshAfter && Date.now() < account._refreshAfter) return;
    if (!force && !isTokenExpiringSoon(account.expiresAt)) return;

    // Coalesce concurrent refreshes
    if (account._refreshPromise) return account._refreshPromise;

    const refreshToken = account.refreshToken;
    account._refreshPromise = (async () => {
      console.log(`[TeamCodex] Refreshing token for account "${account.name}"...`);
      try {
        const newTokens = await refreshAccessToken(refreshToken);
        // A removal or re-import may have happened while the request was pending.
        if (!this.accounts.includes(account) || account.refreshToken !== refreshToken) return;
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
          await this._onTokenRefresh?.(account.index, newTokens, refreshToken);
        } catch (err) {
          console.error(errorMessage('TOKEN_PERSIST_FAILED', { message: err.message }));
        }
      } catch (err) {
        if (!this.accounts.includes(account) || account.refreshToken !== refreshToken) return;
        console.error(errorMessage('ACCOUNT_REFRESH_FAILED', { name: account.name, message: err.message }));
        // A revoked/invalid grant is permanent — stop re-attempting the
        // refresh on every request. The access token may still work until it
        // expires; after that the 401 path rotates to another account.
        const permanent = /invalid_grant|revoked|refresh failed \(40[013]\)/i.test(err.message);
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
  onTokenRefresh(callback) {
    this._onTokenRefresh = callback;
  }

  /**
   * Add a new account at runtime.
   */
  addAccount(acctData) {
    const index = this.accounts.length;
    this.accounts.push(this._buildAccount(acctData, index));
    return index;
  }

  /**
   * Remove an account by index.
   */
  removeAccount(index) {
    if (index < 0 || index >= this.accounts.length) return;
    this.accounts[index].index = -1;
    this.accounts.splice(index, 1);
    this.accounts.forEach((a, i) => { a.index = i; });
    if (this.currentIndex >= this.accounts.length) {
      this.currentIndex = Math.max(0, this.accounts.length - 1);
    } else if (this.currentIndex > index) {
      this.currentIndex--;
    }
  }

  /**
   * Return a status summary of all accounts (safe to expose, no credentials).
   */
  getStatus() {
    return {
      currentAccount: this.accounts[this.currentIndex]?.name,
      switchThreshold: this.switchThreshold,
      autoReset: this.autoReset,
      routing: this.routing,
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
