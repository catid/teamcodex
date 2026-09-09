import { setTimeout as delay } from 'node:timers/promises';

export const TRANSIENT_STATUSES = new Set([408, 500, 502, 503, 504]);

export function retryPolicy(config) {
  return { maxRetries: 2, headerTimeoutSeconds: 60, idleTimeoutSeconds: 120, ...config.retry };
}

export function isTransientError(err) {
  return ['AbortError', 'TimeoutError', 'TypeError'].includes(err?.name) ||
    /fetch failed|terminated|upstream_timeout/i.test(err?.message || '') ||
    /^(ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|UND_ERR_)/.test(err?.cause?.code || err?.code || '');
}

export function retryDelay(attempt, signal) {
  return delay(Math.min(250 * 2 ** attempt, 2000), undefined, { signal });
}
