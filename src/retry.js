import { setTimeout as delay } from 'node:timers/promises';

export const TRANSIENT_STATUSES = new Set([408, 500, 502, 503, 504]);

/** Longest self-scheduled wait between model-at-capacity retries. */
const OVERLOAD_MAX_BACKOFF_SECONDS = 30;
/** Longest Retry-After hint honoured for a model-at-capacity retry. */
const OVERLOAD_MAX_RETRY_AFTER_SECONDS = 60;

/**
 * @typedef {object} RetryPolicy
 * @property {number} maxRetries transient network/status retries per request
 * @property {number} headerTimeoutSeconds
 * @property {number} idleTimeoutSeconds
 * @property {number} overloadBackoffSeconds first wait after a model-at-capacity response
 * @property {number} overloadRetrySeconds total time to keep retrying model-at-capacity responses; 0 means no limit
 */

/**
 * @param {{retry?: Partial<RetryPolicy>}} config
 * @returns {RetryPolicy}
 */
export function retryPolicy(config) {
  return {
    maxRetries: 2, headerTimeoutSeconds: 60, idleTimeoutSeconds: 120,
    overloadBackoffSeconds: 1, overloadRetrySeconds: 0,
    ...config.retry,
  };
}

export function isTransientError(err) {
  return err?.code === 'UPSTREAM_STREAM_INTERRUPTED' ||
    ['AbortError', 'TimeoutError', 'TypeError'].includes(err?.name) ||
    /fetch failed|terminated|upstream_timeout/i.test(err?.message || '') ||
    /^(ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|UND_ERR_)/.test(err?.cause?.code || err?.code || '');
}

export function retryDelay(attempt, signal) {
  return delay(Math.min(250 * 2 ** attempt, 2000), undefined, { signal });
}

/**
 * Wait before retrying a model-at-capacity response. The backoff doubles from
 * the configured base up to a cap; an upstream Retry-After hint replaces the
 * schedule when it asks for at least the base wait.
 * @param {number} attempt 1-based count of model-at-capacity responses seen by this request
 * @param {number} baseSeconds
 * @param {number | null} [retryAfterSeconds]
 * @returns {number}
 */
export function overloadRetryDelaySeconds(attempt, baseSeconds, retryAfterSeconds = null) {
  if (retryAfterSeconds !== null && Number.isFinite(retryAfterSeconds)) {
    return Math.min(Math.max(retryAfterSeconds, baseSeconds), OVERLOAD_MAX_RETRY_AFTER_SECONDS);
  }
  return Math.min(baseSeconds * 2 ** Math.max(0, attempt - 1), Math.max(baseSeconds, OVERLOAD_MAX_BACKOFF_SECONDS));
}
