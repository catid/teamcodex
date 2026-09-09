import type { AdditionalQuota, Quota } from './accounts.ts';
import { isRecord } from './config.ts';
import { createError } from './errors.ts';

export interface UsageSnapshot {
  fetchedAt: number;
  usageDenied: boolean;
  utilization: number;
  resetCreditsAvailable: number | null;
  additionalQuota: AdditionalQuota[];
  quota: Pick<Quota, 'primary' | 'secondary' | 'primaryReset' | 'secondaryReset' | 'primaryWindowMins' | 'secondaryWindowMins'>;
}
const record = (value: unknown): Record<string, unknown> => isRecord(value) ? value : {};

function percentage(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) return null;
  return value / 100;
}

function resetTime(window: Record<string, unknown>, now: number): number | null {
  const absolute = window?.reset_at;
  if (typeof absolute === 'number' && Number.isFinite(absolute) && absolute > 0) {
    return absolute < 1e12 ? absolute * 1000 : absolute;
  }
  const seconds = window?.reset_after_seconds;
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0
    ? now + seconds * 1000 : null;
}

export function normalizeUsage(input: unknown, now = Date.now()): UsageSnapshot {
  const payload = record(input);
  const rateLimit = record(payload.rate_limit);
  const primary = record(rateLimit.primary_window);
  const secondary = record(rateLimit.secondary_window);
  const windows = [primary, secondary, ...(Array.isArray(payload?.additional_rate_limits)
    ? payload.additional_rate_limits.flatMap((limit: unknown) => { const rate = record(record(limit).rate_limit); return [record(rate.primary_window), record(rate.secondary_window)]; }) : [])];
  const values = windows.map(window => percentage(window?.used_percent)).filter(value => value !== null);
  if (!values.length || payload.available === false) throw createError('USAGE_INVALID');
  const credits = record(payload.rate_limit_reset_credits).available_count;
  return {
    fetchedAt: now,
    usageDenied: rateLimit.allowed === false || rateLimit.limit_reached === true,
    utilization: Math.max(...values),
    resetCreditsAvailable: typeof credits === 'number' && Number.isSafeInteger(credits) && credits >= 0 ? credits : null,
    additionalQuota: (Array.isArray(payload?.additional_rate_limits) ? payload.additional_rate_limits : []).flatMap((item: unknown, index: number) => {
      const limit = record(item);
      return ['primary_window', 'secondary_window'].map(key => {
        const window = record(record(limit.rate_limit)[key]);
        return { name: `${limit?.limit_name || limit?.metered_feature || `Additional limit ${index + 1}`} (${key === 'primary_window' ? 'primary' : 'secondary'})`,
          utilization: percentage(window?.used_percent), resetAt: resetTime(window, now),
          windowMinutes: typeof window.limit_window_seconds === 'number' && window.limit_window_seconds > 0 ? window.limit_window_seconds / 60 : null };
      }).filter(window => window.utilization !== null); }),
    quota: {
      primary: percentage(primary?.used_percent),
      secondary: percentage(secondary?.used_percent),
      primaryReset: resetTime(primary, now),
      secondaryReset: resetTime(secondary, now),
      primaryWindowMins: typeof primary.limit_window_seconds === 'number' && primary.limit_window_seconds > 0 ? primary.limit_window_seconds / 60 : null,
      secondaryWindowMins: typeof secondary.limit_window_seconds === 'number' && secondary.limit_window_seconds > 0 ? secondary.limit_window_seconds / 60 : null,
    },
  };
}

