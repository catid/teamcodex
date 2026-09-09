import { setTimeout as delay } from 'node:timers/promises';

export { isTransientError, retryPolicy, TRANSIENT_STATUSES } from '@teamcodex/core/retry';

export function retryDelay(attempt: number, signal?: AbortSignal): Promise<void> {
  return delay(Math.min(250 * 2 ** attempt, 2000), undefined, signal ? { signal } : {});
}
