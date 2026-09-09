import { createError } from './errors.ts';
import type { RetryPolicy } from './retry.ts';
import type { AccountRouting, RoutingOptions } from './routing/config.ts';
import { validateRouting } from './routing/config.ts';

export interface AccountConfig extends AccountRouting {
  type: 'chatgpt' | 'apikey';
  source?: string;
  accountId?: string | null;
  apiKey?: string;
  accessToken?: string;
  refreshToken?: string | null;
  idToken?: string | null;
  expiresAt?: number | null;
  importFrom?: string;
  planType?: string | null;
}

export interface ResetPolicy {
  enabled: boolean;
  threshold: number;
  pollIntervalSeconds: number;
}

export interface ResetState {
  pendingRequestId?: string;
  lastStartedAt?: string;
  lastAttemptAt?: string;
  lastCompletedAt?: string;
  lastResult?: string;
}

export interface Config extends RoutingOptions {
  proxy: { host?: string; port: number; apiKey: string };
  accounts: AccountConfig[];
  upstream?: string;
  apiUpstream?: string;
  switchThreshold?: number;
  retry?: Partial<RetryPolicy>;
  autoReset?: Partial<ResetPolicy>;
  usageResetState?: Record<string, ResetState>;
  logDir?: string;
  // Preserve extension data through transactions without trusting its shape.
  [key: string]: unknown;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numberInRange(value: unknown, min: number, max: number, integer = false): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max && (!integer || Number.isInteger(value));
}

function optionalNumber(value: unknown, min: number, max: number, integer = false): boolean {
  return value === undefined || numberInRange(value, min, max, integer);
}

function validAccount(value: unknown): boolean {
  if (!isRecord(value) || typeof value.name !== 'string' || !value.name.trim() ||
      (value.type !== 'chatgpt' && value.type !== 'apikey')) return false;
  for (const key of ['apiKey', 'accessToken', 'importFrom', 'source']) {
    if (value[key] !== undefined && typeof value[key] !== 'string') return false;
  }
  for (const key of ['accountId', 'refreshToken', 'idToken', 'planType']) {
    if (value[key] != null && typeof value[key] !== 'string') return false;
  }
  return value.expiresAt == null || (typeof value.expiresAt === 'number' && Number.isFinite(value.expiresAt));
}

function validResetState(value: unknown): boolean {
  if (!isRecord(value)) return false;
  for (const key of ['lastAttemptAt', 'lastStartedAt', 'lastCompletedAt']) {
    const date = value[key];
    if (date !== undefined && (typeof date !== 'string' || !Number.isFinite(Date.parse(date)))) return false;
  }
  if (value.lastResult !== undefined && typeof value.lastResult !== 'string') return false;
  return value.pendingRequestId === undefined || (typeof value.pendingRequestId === 'string' &&
    /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value.pendingRequestId));
}

/** Validate parsed data before exposing the configuration contract to consumers. */
export function validateConfig(config: unknown): asserts config is Config {
  if (!isRecord(config)) throw createError('CONFIG_INVALID');
  const proxy = config.proxy;
  if (!isRecord(proxy) || !numberInRange(proxy.port, 1, 65535, true)) throw createError('CONFIG_PORT_INVALID');
  if (typeof proxy.apiKey !== 'string' || !proxy.apiKey.trim()) throw createError('CONFIG_KEY_INVALID');
  if (proxy.host !== undefined && (typeof proxy.host !== 'string' || !proxy.host.trim())) throw createError('CONFIG_HOST_INVALID');
  if (!Array.isArray(config.accounts) || !config.accounts.every(validAccount)) throw createError('CONFIG_ACCOUNTS_INVALID');
  validateRouting(config);
  if (!optionalNumber(config.switchThreshold, 0, 1)) throw createError('CONFIG_THRESHOLD_INVALID');
  if (config.retry !== undefined) {
    const retry = config.retry;
    if (!isRecord(retry) || !optionalNumber(retry.maxRetries, 0, 5, true) ||
        !optionalNumber(retry.headerTimeoutSeconds, 1, 600) || !optionalNumber(retry.idleTimeoutSeconds, 1, 600)) throw createError('CONFIG_RETRY_INVALID');
  }
  if (config.autoReset !== undefined) {
    const policy = config.autoReset;
    if (!isRecord(policy) || (policy.enabled !== undefined && typeof policy.enabled !== 'boolean') ||
        !optionalNumber(policy.threshold, 0.01, 1) || !optionalNumber(policy.pollIntervalSeconds, 30, 3600, true)) throw createError('CONFIG_RESET_POLICY_INVALID');
  }
  if (config.usageResetState !== undefined && (!isRecord(config.usageResetState) || !Object.values(config.usageResetState).every(validResetState))) {
    throw createError('CONFIG_RESET_STATE_INVALID');
  }
  for (const key of ['upstream', 'apiUpstream']) {
    const value = config[key];
    if (value === undefined) continue;
    if (typeof value !== 'string') throw createError('CONFIG_UPSTREAM_INVALID', { key });
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw createError('CONFIG_UPSTREAM_INVALID', { key });
  }
  if (config.logDir !== undefined && typeof config.logDir !== 'string') throw createError('CONFIG_INVALID');
}
