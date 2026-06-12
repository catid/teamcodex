import { refreshAccessToken, isTokenExpiringSoon } from './oauth.js';

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
  const n = parseFloat(value);
  if (isNaN(n)) {
    const t = Date.parse(value);
    return isNaN(t) ? null : t;
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
  let match, any = false;
  while ((match = re.exec(value)) !== null) {
    any = true;
    const n = parseFloat(match[1]);
    switch (match[2]) {
      case 'ms': ms += n; break;
      case 's': ms += n * 1000; break;
      case 'm': ms += n * 60_000; break;
      case 'h': ms += n * 3_600_000; break;
      case 'd': ms += n * 86_400_000; break;
    }
  }
  return any ? Date.now() + ms : null;
}

export class AccountManager {
  constructor(accounts, switchThreshold = 0.98) {
    this.accounts = accounts.map((acct, index) => this._buildAccount(acct, index));
    this.currentIndex = 0;
    this.switchThreshold = switchThreshold;
  }

  _buildAccount(acct, index) {
    return {
      index,
      name: acct.name,
      type: acct.type,
      accountId: acct.accountId || null,
      planType: acct.planType || null,
      credential: acct.accessToken || acct.apiKey,
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
    };
  }

  /**
   * Get the best available account, rotating if the current one is near quota.
   * Returns null if all accounts are exhausted.
   */
  getActiveAccount() {
    const current = this.accounts[this.currentIndex];
    if (this._isAvailable(current)) {
      return current;
    }
    return this._selectNext();
  }

  _isAvailable(account) {
    if (!account) return false;

    // Check rate limit expiry
    if (account.status === 'throttled' && account.rateLimitedUntil) {
      if (Date.now() < account.rateLimitedUntil) return false;
      account.status = 'active';
      account.rateLimitedUntil = null;
      console.log(`[TeamCodex] Account "${account.name}" rate limit expired, marking active`);
    }

    if (account.status === 'exhausted' || account.status === 'error') return false;
    if (this._isNearQuota(account)) return false;

    return true;
  }

  _isNearQuota(account) {
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
    if (q.primary != null && q.primary >= this.switchThreshold) return true;
    if (q.secondary != null && q.secondary >= this.switchThreshold) return true;

    // Standard quotas (API key accounts)
    if (q.tokensLimit != null && q.tokensRemaining != null) {
      const used = 1 - (q.tokensRemaining / q.tokensLimit);
      if (used >= this.switchThreshold) return true;
    }

    if (q.requestsLimit != null && q.requestsRemaining != null) {
      const used = 1 - (q.requestsRemaining / q.requestsLimit);
      if (used >= this.switchThreshold) return true;
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

    // All accounts unavailable — find the one that resets soonest
    let soonestAccount = null;
    let soonestTime = Infinity;

    for (const account of this.accounts) {
      const resetTime = account.rateLimitedUntil
        || account.quota.primaryReset
        || account.quota.secondaryReset
        || account.quota.resetsAt;

      if (resetTime && resetTime < soonestTime) {
        soonestTime = resetTime;
        soonestAccount = account;
      }
    }

    if (soonestAccount && soonestTime <= Date.now()) {
      soonestAccount.status = 'active';
      soonestAccount.rateLimitedUntil = null;
      this.currentIndex = soonestAccount.index;
      console.log(`[TeamCodex] Account "${soonestAccount.name}" reset, switching to it`);
      return soonestAccount;
    }

    return null;
  }

  /**
   * Update an account's quota tracking from upstream response headers.
   */
  updateQuota(accountIndex, headers) {
    const account = this.accounts[accountIndex];
    if (!account) return;
    const q = account.quota;

    // Codex rate limit windows (ChatGPT accounts) — percent is 0-100
    const pUsed = parseFloat(headers['x-codex-primary-used-percent']);
    const sUsed = parseFloat(headers['x-codex-secondary-used-percent']);
    if (!isNaN(pUsed)) q.primary = pUsed / 100;
    if (!isNaN(sUsed)) q.secondary = sUsed / 100;

    const pWin = parseInt(headers['x-codex-primary-window-minutes'], 10);
    const sWin = parseInt(headers['x-codex-secondary-window-minutes'], 10);
    if (!isNaN(pWin)) q.primaryWindowMins = pWin;
    if (!isNaN(sWin)) q.secondaryWindowMins = sWin;

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

    if (!isNaN(tokensLimit)) q.tokensLimit = tokensLimit;
    if (!isNaN(tokensRemaining)) q.tokensRemaining = tokensRemaining;
    if (!isNaN(requestsLimit)) q.requestsLimit = requestsLimit;
    if (!isNaN(requestsRemaining)) q.requestsRemaining = requestsRemaining;

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
    const account = this.accounts[accountIndex];
    if (!account) return;
    if (inputTokens) account.usage.totalInputTokens += inputTokens;
    if (outputTokens) account.usage.totalOutputTokens += outputTokens;
  }

  /**
   * Mark an account as rate-limited for a given duration.
   */
  markRateLimited(accountIndex, retryAfterSeconds) {
    const account = this.accounts[accountIndex];
    if (!account) return;
    account.status = 'throttled';
    account.rateLimitedUntil = Date.now() + (retryAfterSeconds * 1000);
    console.log(`[TeamCodex] Account "${account.name}" rate limited for ${retryAfterSeconds}s`);
  }

  /**
   * Ensure a ChatGPT account's token is fresh, refreshing if needed.
   * Pass force=true to refresh regardless of expiry (e.g. after a 401).
   * Concurrent calls for the same account coalesce into a single refresh.
   */
  async ensureTokenFresh(accountIndex, force = false) {
    const account = this.accounts[accountIndex];
    if (!account || account.type !== 'chatgpt' || !account.refreshToken) return;

    if (!force && !isTokenExpiringSoon(account.expiresAt)) return;

    // Coalesce concurrent refreshes
    if (account._refreshPromise) return account._refreshPromise;

    account._refreshPromise = (async () => {
      console.log(`[TeamCodex] Refreshing token for account "${account.name}"...`);
      try {
        const newTokens = await refreshAccessToken(account.refreshToken);
        account.credential = newTokens.accessToken;
        account.refreshToken = newTokens.refreshToken;
        if (newTokens.idToken) account.idToken = newTokens.idToken;
        account.expiresAt = newTokens.expiresAt;
        console.log(`[TeamCodex] Token refreshed for account "${account.name}"`);
        this._onTokenRefresh?.(accountIndex, newTokens);
      } catch (err) {
        console.error(`[TeamCodex] Token refresh failed for "${account.name}": ${err.message}`);
        // Only mark as error if the access token is actually expired;
        // a failed proactive refresh shouldn't kill a still-valid token
        if (!account.expiresAt || Date.now() >= account.expiresAt) {
          account.status = 'error';
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
   * Update a specific account's tokens (e.g. after a re-import).
   */
  updateAccountTokens(accountIndex, { accessToken, refreshToken, idToken, expiresAt }) {
    const account = this.accounts[accountIndex];
    if (!account || account.type !== 'chatgpt') return;

    account.credential = accessToken;
    if (refreshToken) account.refreshToken = refreshToken;
    if (idToken) account.idToken = idToken;
    account.expiresAt = expiresAt;
    if (account.status === 'error') account.status = 'active';
    console.log(`[TeamCodex] Updated tokens for account "${account.name}"`);
    this._onTokenRefresh?.(accountIndex, {
      accessToken,
      refreshToken: account.refreshToken,
      idToken: account.idToken,
      expiresAt: account.expiresAt,
    });
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
    this.accounts.splice(index, 1);
    this.accounts.forEach((a, i) => a.index = i);
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
      accounts: this.accounts.map(a => ({
        name: a.name,
        type: a.type,
        planType: a.planType,
        status: a.status,
        quota: { ...a.quota },
        usage: { ...a.usage },
        rateLimitedUntil: a.rateLimitedUntil
          ? new Date(a.rateLimitedUntil).toISOString()
          : null,
      })),
    };
  }
}
