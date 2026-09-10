import { createHash } from 'node:crypto';

import { isRecord } from '@teamcodex/core/config';
import { createError } from '@teamcodex/core/errors';
import type { AccountIdentity, Counters, UsageHistory, UsageSnapshot } from '@teamcodex/core/usage';
import { copyCounters, COUNTER_FIELDS as FIELDS, emptyCounters as counters, tokenCount, validHistory } from '@teamcodex/core/usage';
import { atomicWrite, readTextFile } from '@teamcodex/shared/filesystem';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const iso = (now: number): string => new Date(now).toISOString();
const accountKey = (account: AccountIdentity): string => createHash('sha256').update(`${account.type}:${account.accountId || account.name}`).digest('hex');

/** One service owns this file; status readers use the in-memory snapshot. */
export class UsageStats {
  path: string | null;
  private readonly now: () => number;
  data: UsageHistory;
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<void> | null = null;
  private persistenceError: string | null = null;
  private disabled = false;
  constructor(path: string | null = null, { now = Date.now }: { now?: () => number } = {}) {
    this.path = path;
    this.now = now;
    this.data = { version: 1, trackingSince: iso(now()), totals: counters(), accounts: {}, hours: {}, days: {} };
    this.disabled = false;
  }

  async load() {
    if (!this.path) return this;
    try {
      const content = await readTextFile(this.path, 8 * 1024 * 1024, () => createError('HISTORY_INVALID'));
      const data: unknown = JSON.parse(content);
      if (!validHistory(data)) throw createError('HISTORY_INVALID');
      // Retain only the schema fields, even if the file contains extra metadata.
      const copyGroup = (group: Record<string, Counters>): Record<string, Counters> =>
        Object.fromEntries(Object.entries(group).map(([id, value]) => [id, copyCounters(value)]));
      this.data = { version: 1, trackingSince: data.trackingSince, totals: copyCounters(data.totals),
        accounts: copyGroup(data.accounts), hours: copyGroup(data.hours), days: copyGroup(data.days) };
      this.prune();
    } catch (error) {
      if (!isRecord(error) || error.code !== 'ENOENT') {
        // Preserve damaged/unsupported history for repair, rather than replacing it.
        this.disabled = true;
        this.persistenceError = 'Cannot load saved history; tracking in memory only';
      }
    }
    return this;
  }

  prune() {
    const now = this.now();
    for (const [name, period, keep] of [['hours', HOUR, 48], ['days', DAY, 30]] as const) {
      const current = Math.floor(now / period);
      for (const key of Object.keys(this.data[name])) {
        if (Number(key) < current - keep + 1) delete this.data[name][key];
      }
    }
  }

  record(delta: Partial<Counters>, account?: AccountIdentity | null) {
    const now = this.now();
    this.prune();
    this.data.hours[Math.floor(now / HOUR)] ??= counters();
    const hour = this.data.hours[Math.floor(now / HOUR)];
    this.data.days[Math.floor(now / DAY)] ??= counters();
    const day = this.data.days[Math.floor(now / DAY)];
    const targets = [this.data.totals, hour, day];
    if (account) {
      this.data.accounts[accountKey(account)] ??= counters();
      const current = this.data.accounts[accountKey(account)];
      if (current) targets.push(current);
    }
    for (const target of targets) for (const key of FIELDS) {
      const value = delta[key];
      if (target && typeof value === 'number' && Number.isFinite(value) && value >= 0) target[key] += value;
    }
    this.dirty = true;
    if (this.path && !this.disabled && !this.timer) {
      this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, 1000);
      this.timer.unref();
    }
  }

  recordTokens(account: AccountIdentity, input: unknown, output: unknown, cached: unknown = 0) {
    this.record({ inputTokens: tokenCount(input), outputTokens: tokenCount(output),
      cachedInputTokens: tokenCount(cached) }, account);
  }

  recordAttempt(account: AccountIdentity, retry: boolean) {
    this.record({ attempts: 1, retries: retry ? 1 : 0 }, account);
  }

  recordRequest({ status, disconnected, durationMs }: { status: number; disconnected: boolean; durationMs: number }, account?: AccountIdentity | null) {
    this.record({ requests: 1, httpErrors: !disconnected && status >= 400 ? 1 : 0,
      disconnected: disconnected ? 1 : 0, durationMs: Math.max(0, durationMs) }, account);
  }

  account(account: AccountIdentity): Counters {
    return { ...(this.data.accounts[accountKey(account)] || counters()) };
  }

  snapshot(): UsageSnapshot {
    this.prune();
    const series = (key: 'hours' | 'days', period: number, count: number) => Array.from({ length: count }, (_, i) => {
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

  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.flushing) return this.flushing;
    if (!this.path || this.disabled || !this.dirty) return Promise.resolve();
    this.flushing = this.write().finally(() => { this.flushing = null; });
    return this.flushing;
  }

  private async write(): Promise<void> {
    const path = this.path;
    if (!path) return;
    while (this.dirty) {
      this.dirty = false;
      try {
        await atomicWrite(path, JSON.stringify(this.data));
        this.persistenceError = null;
      } catch {
        this.dirty = true;
        this.persistenceError = 'Cannot save usage history; current totals are in memory';
        break;
      }
    }
  }
}
