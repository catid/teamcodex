import { createHash, randomUUID } from 'node:crypto';
import { open, writeFile, rename, rm } from 'node:fs/promises';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const FIELDS = ['inputTokens', 'outputTokens', 'cachedInputTokens', 'requests', 'attempts', 'retries', 'httpErrors', 'disconnected', 'durationMs'];
const counters = () => Object.fromEntries(FIELDS.map(key => [key, 0]));
export const tokenCount = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const iso = now => new Date(now).toISOString();
const accountKey = account => createHash('sha256').update(`${account.type}:${account.accountId || account.name}`).digest('hex');

function validCounters(value) {
  return value && FIELDS.every(key => Number.isFinite(value[key]) && value[key] >= 0);
}

function valid(data) {
  return data?.version === 1 && Number.isFinite(Date.parse(data.trackingSince)) && validCounters(data.totals) &&
    ['accounts', 'hours', 'days'].every(key => data[key] && typeof data[key] === 'object' && !Array.isArray(data[key]) &&
      Object.entries(data[key]).every(([id, entry]) => (key === 'accounts' ? /^[a-f0-9]{64}$/.test(id) : /^\d+$/.test(id)) && validCounters(entry)));
}

/** One service owns this file; status readers use the in-memory snapshot. */
export class UsageStats {
  constructor(path = null, { now = Date.now } = {}) {
    this.path = path;
    this.now = now;
    this.data = { version: 1, trackingSince: iso(now()), totals: counters(), accounts: {}, hours: {}, days: {} };
    this.dirty = false;
    this.timer = null;
    this.flushing = null;
    this.persistenceError = null;
    this.disabled = false;
  }

  async load() {
    if (!this.path) return this;
    try {
      const file = await open(this.path, 'r');
      let content;
      try {
        const info = await file.stat();
        if (!info.isFile() || info.size > 8 * 1024 * 1024) throw new Error('invalid_history');
        content = await file.readFile('utf8');
      } finally { await file.close(); }
      const data = JSON.parse(content);
      if (!valid(data)) throw new Error('invalid_history');
      // Retain only the schema fields, even if the file contains extra metadata.
      const copy = value => Object.fromEntries(FIELDS.map(key => [key, value[key]]));
      this.data = { version: 1, trackingSince: data.trackingSince, totals: copy(data.totals),
        ...Object.fromEntries(['accounts', 'hours', 'days'].map(key => [key,
          Object.fromEntries(Object.entries(data[key]).map(([id, value]) => [id, copy(value)]))])) };
      this.prune();
    } catch (error) {
      if (error.code !== 'ENOENT') {
        // Preserve damaged/unsupported history for repair, rather than replacing it.
        this.disabled = true;
        this.persistenceError = 'Cannot load saved history; tracking in memory only';
      }
    }
    return this;
  }

  prune() {
    const now = this.now();
    for (const [name, period, keep] of [['hours', HOUR, 48], ['days', DAY, 30]]) {
      const current = Math.floor(now / period);
      for (const key of Object.keys(this.data[name])) {
        if (Number(key) < current - keep + 1) delete this.data[name][key];
      }
    }
  }

  record(delta, account) {
    const now = this.now();
    this.prune();
    const hour = this.data.hours[Math.floor(now / HOUR)] ??= counters();
    const day = this.data.days[Math.floor(now / DAY)] ??= counters();
    const targets = [this.data.totals, hour, day];
    if (account) targets.push(this.data.accounts[accountKey(account)] ??= counters());
    for (const target of targets) for (const [key, value] of Object.entries(delta)) {
      if (FIELDS.includes(key) && Number.isFinite(value) && value >= 0) target[key] += value;
    }
    this.dirty = true;
    if (this.path && !this.disabled && !this.timer) {
      this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, 1000);
      this.timer.unref();
    }
  }

  recordTokens(account, input, output, cached = 0) {
    this.record({ inputTokens: tokenCount(input), outputTokens: tokenCount(output),
      cachedInputTokens: tokenCount(cached) }, account);
  }

  recordAttempt(account, retry) {
    this.record({ attempts: 1, retries: retry ? 1 : 0 }, account);
  }

  recordRequest({ status, disconnected, durationMs }, account) {
    this.record({ requests: 1, httpErrors: !disconnected && status >= 400 ? 1 : 0,
      disconnected: disconnected ? 1 : 0, durationMs: Math.max(0, durationMs) }, account);
  }

  account(account) {
    return { ...(this.data.accounts[accountKey(account)] || counters()) };
  }

  snapshot() {
    this.prune();
    const series = (key, period, count) => Array.from({ length: count }, (_, i) => {
      const bucket = Math.floor(this.now() / period) - count + i + 1;
      return { start: iso(bucket * period), ...(this.data[key][bucket] || counters()) };
    });
    return {
      trackingSince: this.data.trackingSince, totals: { ...this.data.totals },
      hourly: series('hours', HOUR, 24), daily: series('days', DAY, 30),
      persistence: this.path ? (this.persistenceError ? 'error' : 'enabled') : 'memory',
      persistenceError: this.persistenceError,
    };
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    if (this.flushing) return this.flushing;
    if (!this.path || this.disabled || !this.dirty) return Promise.resolve();
    this.flushing = this.write().finally(() => { this.flushing = null; });
    return this.flushing;
  }

  async write() {
    while (this.dirty) {
      this.dirty = false;
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(this.data), { mode: 0o600, flag: 'wx' });
        await rename(temporary, this.path);
        this.persistenceError = null;
      } catch {
        this.dirty = true;
        this.persistenceError = 'Cannot save usage history; current totals are in memory';
        await rm(temporary, { force: true }).catch(() => {});
        break;
      }
    }
  }
}
