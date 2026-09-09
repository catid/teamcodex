import { isRecord } from './config.ts';

export interface AccountIdentity {
  type: 'chatgpt' | 'apikey';
  accountId?: string | null;
  name: string;
}

export const COUNTER_FIELDS = ['inputTokens', 'outputTokens', 'cachedInputTokens', 'requests', 'attempts', 'retries', 'httpErrors', 'disconnected', 'durationMs'] as const;
export type Counters = Record<typeof COUNTER_FIELDS[number], number>;

export interface UsageHistory {
  version: 1;
  trackingSince: string;
  totals: Counters;
  accounts: Record<string, Counters>;
  hours: Record<string, Counters>;
  days: Record<string, Counters>;
}

export interface UsageSnapshot {
  trackingSince: string;
  totals: Counters;
  hourly: (Counters & { start: string })[];
  daily: (Counters & { start: string })[];
  persistence: 'error' | 'enabled' | 'memory';
  persistenceError: string | null;
}

export function emptyCounters(): Counters {
  return { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, requests: 0, attempts: 0, retries: 0, httpErrors: 0, disconnected: 0, durationMs: 0 };
}

export function tokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export function copyCounters(value: Counters): Counters {
  const result = emptyCounters();
  for (const key of COUNTER_FIELDS) result[key] = value[key];
  return result;
}

function validCounters(value: unknown): value is Counters {
  return isRecord(value) && COUNTER_FIELDS.every(key => typeof value[key] === 'number' && Number.isFinite(value[key]) && value[key] >= 0);
}

export function validHistory(data: unknown): data is UsageHistory {
  return isRecord(data) && data.version === 1 && typeof data.trackingSince === 'string' &&
    Number.isFinite(Date.parse(data.trackingSince)) && validCounters(data.totals) &&
    ['accounts', 'hours', 'days'].every(key => {
      const group = data[key];
      return isRecord(group) && Object.entries(group).every(([id, entry]) =>
        (key === 'accounts' ? /^[a-f0-9]{64}$/.test(id) : /^\d+$/.test(id)) && validCounters(entry));
    });
}
