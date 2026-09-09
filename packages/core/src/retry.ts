export interface RetryPolicy {
  maxRetries: number;
  headerTimeoutSeconds: number;
  idleTimeoutSeconds: number;
}

export const TRANSIENT_STATUSES = new Set([408, 500, 502, 503, 504]);

export function retryPolicy(config: { retry?: Partial<RetryPolicy> }): RetryPolicy {
  return { maxRetries: 2, headerTimeoutSeconds: 60, idleTimeoutSeconds: 120, ...config.retry };
}

/** Read provider/native diagnostics without assuming thrown values are Errors. */
function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null && key in value ? Reflect.get(value, key) : undefined;
}

export function isTransientError(error: unknown): boolean {
  const name = field(error, 'name');
  const message = field(error, 'message');
  const code = field(field(error, 'cause'), 'code') || field(error, 'code');
  return name === 'AbortError' || name === 'TimeoutError' || name === 'TypeError' ||
    (typeof message === 'string' && /fetch failed|terminated|upstream_timeout/i.test(message)) ||
    (typeof code === 'string' && /^(ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|UND_ERR_)/.test(code));
}
