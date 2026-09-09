import type { Account, AdditionalQuota } from '@teamcodex/core/accounts';
import { emptyQuota } from '@teamcodex/core/accounts';
import { isRecord } from '@teamcodex/core/config';
import type { Counters, UsageSnapshot } from '@teamcodex/core/usage';
import { COUNTER_FIELDS, emptyCounters } from '@teamcodex/core/usage';
import type { AccountManager } from '@teamcodex/proxy/account-manager';

type AccountStatus = ReturnType<AccountManager['getStatus']>['accounts'][number];
const record = (value: unknown): Record<string, unknown> => isRecord(value) ? value : {};
const text = (value: unknown): string | null => typeof value === 'string' ? value : null;
const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;

function counters(value: unknown): Counters {
  const data = record(value), result = emptyCounters();
  for (const key of COUNTER_FIELDS) result[key] = number(data[key]) ?? 0;
  return result;
}

function statistics(value: unknown): UsageSnapshot | null {
  if (!isRecord(value)) return null;
  const series = (data: unknown): (Counters & { start: string })[] => Array.isArray(data)
    ? data.map((item: unknown) => ({ ...counters(item), start: text(record(item).start) ?? '' })) : [];
  return { trackingSince: text(value.trackingSince) ?? '', totals: counters(value.totals),
    hourly: series(value.hourly), daily: series(value.daily),
    persistence: value.persistence === 'error' ? 'error' : value.persistence === 'enabled' ? 'enabled' : 'memory',
    persistenceError: text(value.persistenceError) };
}

function account(value: unknown): AccountStatus {
  const data = record(value), quota = record(data.quota), reset = record(data.usageReset);
  const auth = record(data.auth), usage = record(data.usage), adaptive = record(data.adaptive);
  const q = emptyQuota();
  for (const key of Object.keys(q)) {
    if (key in q) Reflect.set(q, key, number(quota[key]));
  }
  const additionalQuota: AdditionalQuota[] = Array.isArray(data.additionalQuota) ? data.additionalQuota.map((item: unknown) => {
    const q = record(item);
    return { name: text(q.name) ?? '', utilization: number(q.utilization), resetAt: number(q.resetAt), windowMinutes: number(q.windowMinutes) };
  }) : [];
  const state = (value: unknown): Account['status'] => value === 'throttled' || value === 'exhausted' || value === 'error' ? value : 'active';
  return { name: text(data.name) ?? '', weight: number(data.weight) ?? 1, enabled: data.enabled !== false,
    switchThreshold: number(data.switchThreshold) ?? undefined, type: data.type === 'chatgpt' ? 'chatgpt' : 'apikey',
    planType: text(data.planType), status: data.status === 'disabled' || data.status === 'refreshing' ? data.status : state(data.status),
    underlyingStatus: state(data.underlyingStatus), quota: q, additionalQuota, quotaUpdatedAt: text(data.quotaUpdatedAt),
    rateLimitedUntil: text(data.rateLimitedUntil), totals: isRecord(data.totals) ? counters(data.totals) : null,
    auth: { expiresAt: text(auth.expiresAt), refreshAvailable: auth.refreshAvailable === true, refreshing: auth.refreshing === true, retryAt: text(auth.retryAt) },
    adaptive: { inFlight: number(adaptive.inFlight) ?? 0, latencyMs: number(adaptive.latencyMs) ?? 0, failureRate: number(adaptive.failureRate) ?? 0, samples: number(adaptive.samples) ?? 0, updatedAt: number(adaptive.updatedAt) ?? 0 },
    usage: { totalRequests: number(usage.totalRequests) ?? 0, totalInputTokens: number(usage.totalInputTokens) ?? 0, totalOutputTokens: number(usage.totalOutputTokens) ?? 0, lastUsed: text(usage.lastUsed) },
    usageReset: { availableCredits: number(reset.availableCredits), checkedAt: text(reset.checkedAt), lastResult: text(reset.lastResult), pending: reset.pending === true,
      lastCompletedAt: text(reset.lastCompletedAt), lastAttemptAt: text(reset.lastAttemptAt), retryAt: text(reset.retryAt), nextEligibleAt: text(reset.nextEligibleAt), checkError: text(reset.checkError) } };
}

/** Rendering accepts older status snapshots and normalizes every displayed field. */
export function normalizeStatus(value: unknown) {
  const data = record(value), policy = record(data.autoReset), service = record(data.service), polling = record(data.usagePolling);
  return { accounts: Array.isArray(data.accounts) ? data.accounts.map(account) : [],
    currentAccount: text(data.currentAccount), rotationOrder: Array.isArray(data.rotationOrder) ? data.rotationOrder.filter((name: unknown): name is string => typeof name === 'string') : [],
    switchThreshold: number(data.switchThreshold) ?? 0.98, statistics: statistics(data.statistics),
    autoReset: isRecord(data.autoReset) ? { enabled: policy.enabled === true, threshold: number(policy.threshold) ?? 0.98, pollIntervalSeconds: number(policy.pollIntervalSeconds) ?? 300 } : null,
    service: isRecord(data.service) ? { uptimeSeconds: number(service.uptimeSeconds) ?? 0, inFlight: number(service.inFlight) ?? 0 } : null,
    usagePolling: { running: polling.running === true, lastCompletedAt: text(polling.lastCompletedAt) } };
}
