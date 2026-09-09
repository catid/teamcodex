import { randomUUID } from 'node:crypto';
import { atomicConfigUpdate } from './config.js';
import { findConfigAccount } from './accounts.js';
import { importCredentials } from './oauth.js';
import { TRANSIENT_STATUSES, isTransientError, retryDelay } from './retry.js';

// ChatGPT contract inspected in c0ldfront/bifrost (fa8ee27),
// deploy/oauth/pi-account.mjs. Implemented here independently for TeamCodex.
const USAGE_PATH = '/backend-api/wham/usage';
const RESET_PATH = '/backend-api/wham/rate-limit-reset-credits/consume';
const PENDING_RETRY_MS = 60_000;
const COOLDOWN_MS = 60 * 60 * 1000;
const MAX_SNAPSHOT_AGE_MS = 10 * 60 * 1000;
const MAX_BODY_BYTES = 1024 * 1024;

export function autoResetPolicy(config) {
  return {
    enabled: config.autoReset?.enabled ?? true,
    threshold: config.autoReset?.threshold ?? 0.98,
    pollIntervalSeconds: config.autoReset?.pollIntervalSeconds ?? 300,
  };
}

function percentage(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) return null;
  return value / 100;
}

function resetTime(window, now) {
  const absolute = window?.reset_at;
  if (typeof absolute === 'number' && Number.isFinite(absolute) && absolute > 0) {
    return absolute < 1e12 ? absolute * 1000 : absolute;
  }
  const seconds = window?.reset_after_seconds;
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0
    ? now + seconds * 1000 : null;
}

export function normalizeUsage(payload, now = Date.now()) {
  const primary = payload?.rate_limit?.primary_window;
  const secondary = payload?.rate_limit?.secondary_window;
  const windows = [primary, secondary, ...(Array.isArray(payload?.additional_rate_limits)
    ? payload.additional_rate_limits.flatMap(limit => [limit?.rate_limit?.primary_window, limit?.rate_limit?.secondary_window]) : [])];
  const values = windows.map(window => percentage(window?.used_percent)).filter(value => value !== null);
  if (!values.length || payload.available === false) throw new Error('invalid_usage_response');
  const credits = payload?.rate_limit_reset_credits?.available_count;
  return {
    fetchedAt: now,
    utilization: Math.max(...values),
    resetCreditsAvailable: Number.isSafeInteger(credits) && credits >= 0 ? credits : null,
    quota: {
      primary: percentage(primary?.used_percent),
      secondary: percentage(secondary?.used_percent),
      primaryReset: resetTime(primary, now),
      secondaryReset: resetTime(secondary, now),
      primaryWindowMins: primary?.limit_window_seconds > 0 ? primary.limit_window_seconds / 60 : null,
      secondaryWindowMins: secondary?.limit_window_seconds > 0 ? secondary.limit_window_seconds / 60 : null,
    },
  };
}

async function boundedJSON(response) {
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`http_${response.status}`);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body || []) {
    size += chunk.byteLength;
    if (size > MAX_BODY_BYTES) throw new Error('response_too_large');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('invalid_response'); }
}

function errorCode(err) {
  return /^(http_\d{3}|invalid_usage_response|response_too_large|invalid_response)$/.test(err?.message)
    ? err.message : 'provider_unavailable';
}

export class UsageResetMonitor {
  constructor(manager, config, { fetchFn = fetch, updateConfig = atomicConfigUpdate, now = Date.now, wait = retryDelay } = {}) {
    this.manager = manager;
    this.config = config;
    this.fetch = fetchFn;
    this.updateConfig = updateConfig;
    this.now = now;
    this.wait = wait;
    this.lastRecoveryAt = -Infinity;
    this.pendingTimer = null;
    this.controller = new AbortController();
    this.running = null;
    this.timer = null;
    this.manager.autoReset = autoResetPolicy(config);
  }

  start() {
    if (this.timer) return;
    const check = () => this.check().catch(err => console.error(`[TeamCodex] Usage monitor failed: ${err.message}`));
    this.timer = setInterval(check, autoResetPolicy(this.config).pollIntervalSeconds * 1000);
    this.timer.unref();
    void check();
  }

  stop() {
    clearInterval(this.timer);
    clearTimeout(this.pendingTimer);
    this.timer = null;
    this.controller.abort();
  }

  recover() {
    if (this.running) return this.running;
    if (this.now() - this.lastRecoveryAt < 30_000) return Promise.resolve();
    this.lastRecoveryAt = this.now();
    return this.check();
  }

  check() {
    if (this.running) return this.running;
    this.running = this._check().finally(() => { this.running = null; });
    return this.running;
  }

  async _check() {
    // Limit parallel I/O so one slow account cannot block the entire pool.
    const queue = [...this.manager.accounts];
    const failures = [];
    await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => {
      while (queue.length && !this.controller.signal.aborted) {
        const account = queue.shift();
        try { await this.checkAccount(account); }
        catch (err) { failures.push(err); }
      }
    }));
    if (failures.length) throw failures[0];
  }

  async checkAccount(account) {
    if (account.type !== 'chatgpt' || account.status === 'error') return;
    await this.manager.ensureTokenFresh(account);
    if (!this.manager.accounts.includes(account) || account.status === 'error') return;
    let snapshot = null;
    try {
      snapshot = await this.readUsage(account);
      this.applyUsage(account, snapshot);
    } catch (err) {
      account.usageReset = { ...account.usageReset, checkError: errorCode(err) };
    }
    if (this.controller.signal.aborted || !this.manager.accounts.includes(account) || !account.accountId) return;
    const credential = account.credential;
    const accountId = account.accountId;
    const reservation = await this.reserve(account, snapshot);
    if (!reservation || this.controller.signal.aborted ||
        !this.manager.accounts.includes(account) || account.accountId !== accountId || account.credential !== credential) return;
    await this.redeem(account, reservation);
  }

  async request(account, path, body) {
    const credential = account.credential;
    const accountId = account.accountId;
    for (let attempt = 0; ; attempt++) {
      this.controller.signal.throwIfAborted();
      if (!this.manager.accounts.includes(account) || account.accountId !== accountId || account.credential !== credential) {
        throw new Error('account_changed');
      }
      try {
        const response = await this.fetch(`${(this.config.upstream || 'https://chatgpt.com').replace(/\/+$/, '')}${path}`, {
          method: body ? 'POST' : 'GET',
          redirect: 'manual',
          signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(15_000)]),
          headers: {
            authorization: `Bearer ${credential}`,
            accept: 'application/json',
            ...(accountId ? { 'chatgpt-account-id': accountId } : {}),
            ...(body ? { 'content-type': 'application/json' } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        return await boundedJSON(response);
      } catch (err) {
        const status = /^http_(\d{3})$/.exec(err.message)?.[1];
        if (attempt >= 2 || this.controller.signal.aborted ||
            !(isTransientError(err) || TRANSIENT_STATUSES.has(Number(status)))) throw err;
        // Every wire retry carries exactly the same persisted redemption ID.
        await this.wait(attempt, this.controller.signal);
      }
    }
  }

  async readUsage(account) {
    const accountId = account.accountId;
    const credential = account.credential;
    const payload = await this.request(account, USAGE_PATH);
    if (!this.manager.accounts.includes(account) || account.accountId !== accountId || account.credential !== credential) {
      throw new Error('account_changed');
    }
    return normalizeUsage(payload, this.now());
  }

  applyUsage(account, snapshot, resetConfirmed = false) {
    if (!this.manager.accounts.includes(account)) return;
    const previousUsage = Math.max(account.quota.primary ?? 0, account.quota.secondary ?? 0);
    Object.assign(account.quota, snapshot.quota);
    account.usageReset = {
      ...account.usageReset,
      availableCredits: snapshot.resetCreditsAvailable,
      checkedAt: new Date(snapshot.fetchedAt).toISOString(),
      checkError: null,
    };
    // A reset response alone is insufficient: the new usage must show capacity.
    if ((resetConfirmed || snapshot.utilization < previousUsage) && snapshot.utilization < 1 && account.status === 'throttled') {
      account.status = 'active';
      account.rateLimitedUntil = null;
    }
  }

  async reserve(account, snapshot) {
    let reservation = null;
    const identity = { accountId: account.accountId, name: account.name };
    const stateKey = `chatgpt:${identity.accountId}`;
    await this.updateConfig(async config => {
      const idx = findConfigAccount(config, identity);
      const entry = config.accounts[idx];
      if (!entry || entry.type !== 'chatgpt') return;
      let accountId = entry.accountId;
      if (!accountId && entry.importFrom && !entry.accessToken) {
        try { accountId = (await importCredentials(entry.importFrom === '~/.codex/auth.json' ? undefined : entry.importFrom)).accountId; }
        catch { return; }
      }
      if (accountId !== identity.accountId) return;
      const policy = autoResetPolicy(config);
      this.manager.autoReset = policy;
      const state = config.usageResetState?.[stateKey] || {};
      account.usageReset = { ...account.usageReset, ...this.publicState(state) };
      if (!policy.enabled) return;
      const now = this.now();
      const previous = state.lastAttemptAt ? Date.parse(state.lastAttemptAt) : null;
      if (previous !== null && (!Number.isFinite(previous) || now - previous < (state.pendingRequestId ? PENDING_RETRY_MS : COOLDOWN_MS))) return;
      if (!state.pendingRequestId) {
        const started = Date.parse(state.lastStartedAt || state.lastAttemptAt || '');
        if (Number.isFinite(started) && now - started < COOLDOWN_MS) return;
        if (!snapshot || now < snapshot.fetchedAt || now - snapshot.fetchedAt > MAX_SNAPSHOT_AGE_MS ||
            !(snapshot.resetCreditsAvailable > 0) || snapshot.utilization < policy.threshold) return;
      }
      // Persist BEFORE the POST. A concurrent monitor or a restarted container
      // must see this attempt and reuse its ID if its outcome is uncertain.
      reservation = {
        ...state,
        pendingRequestId: state.pendingRequestId || randomUUID(),
        lastStartedAt: state.pendingRequestId ? (state.lastStartedAt || state.lastAttemptAt) : new Date(now).toISOString(),
        lastAttemptAt: new Date(now).toISOString(),
        lastResult: 'pending',
      };
      config.usageResetState ??= {};
      config.usageResetState[stateKey] = reservation;
    });
    if (reservation) account.usageReset = { ...account.usageReset, ...this.publicState(reservation) };
    return reservation;
  }

  publicState(state) {
    return {
      lastAttemptAt: state.lastAttemptAt || null,
      lastResult: state.lastResult || null,
      lastCompletedAt: state.lastCompletedAt || null,
      pending: Boolean(state.pendingRequestId),
    };
  }

  async redeem(account, reservation) {
    const accountId = account.accountId;
    const stateKey = `chatgpt:${accountId}`;
    let result = 'provider_unavailable';
    let settled = false;
    try {
      const response = await this.request(account, RESET_PATH, { redeem_request_id: reservation.pendingRequestId });
      if (['no_credit', 'nothing_to_reset'].includes(response?.code)) {
        result = response.code;
        settled = true;
        if (result === 'no_credit' && account.accountId === accountId) account.usageReset.availableCredits = 0;
      } else if (['reset', 'already_redeemed'].includes(response?.code)) {
        try {
          if (account.accountId !== accountId || !this.manager.accounts.includes(account)) throw new Error('account_changed');
          const snapshot = await this.readUsage(account);
          this.applyUsage(account, snapshot, true);
          result = 'completed';
          settled = true;
        } catch {
          result = 'refresh_failed';
        }
      } else {
        result = 'unknown_outcome';
      }
    } catch (err) {
      result = errorCode(err);
    }
    await this.updateConfig(config => {
      const state = config.usageResetState?.[stateKey];
      if (!state || state.pendingRequestId !== reservation.pendingRequestId || state.lastAttemptAt !== reservation.lastAttemptAt) return;
      state.lastResult = result;
      if (settled) delete state.pendingRequestId;
      if (result === 'completed') state.lastCompletedAt = new Date(this.now()).toISOString();
      if (account.accountId === accountId) account.usageReset = { ...account.usageReset, ...this.publicState(state) };
    });
    if (!settled && this.timer && !this.pendingTimer && !this.controller.signal.aborted) {
      this.pendingTimer = setTimeout(() => {
        this.pendingTimer = null;
        void this.check().catch(err => console.error(`[TeamCodex] Pending reset check failed: ${err.message}`));
      }, PENDING_RETRY_MS);
      this.pendingTimer.unref();
    }
    console.log(`[TeamCodex] Automatic usage reset for "${account.name}": ${result}`);
  }
}
