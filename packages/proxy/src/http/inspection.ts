import type { Account } from '@teamcodex/core/accounts';
import { isRecord } from '@teamcodex/core/config';
import { isEmbedded429Payload } from '@teamcodex/core/response';
import { tokenCount } from '@teamcodex/core/usage';

import type { AccountManager } from '../account-manager.ts';
import { computeAccountRetryAfter } from './rate-limit.ts';

export interface ResponseState { embedded429Seen: boolean; usage?: { input: number; output: number; cached: number } }
export interface Inspection { embedded429: boolean }
const record = (value: unknown): Record<string, unknown> => isRecord(value) ? value : {};
const DEFAULT_EMBEDDED_429_RETRY_SECONDS = 3600;

export function inspectSSEEvent(event: string, accountIndex: Account, accountManager: AccountManager, state: ResponseState): Inspection {
  const dataLines = event.split('\n')
    .filter(l => l.startsWith('data:'))
    .map(l => l.slice(5).replace(/^ /, '').replace(/\r$/, ''));
  if (dataLines.length === 0) return { embedded429: false };

  try {
    const dataText = dataLines.join('\n');
    if (dataText === '[DONE]') return { embedded429: false };
    return inspectResponsePayload(JSON.parse(dataText), accountIndex, accountManager, state);
  } catch {
    // not valid JSON, skip
    return { embedded429: false };
  }
}

export function inspectResponseBody(buffer: Buffer, accountIndex: Account, accountManager: AccountManager): Inspection {
  try {
    return inspectResponsePayload(JSON.parse(buffer.toString()), accountIndex, accountManager, { embedded429Seen: false });
  } catch {
    // not JSON
    return { embedded429: false };
  }
}

function inspectResponsePayload(input: unknown, accountIndex: Account, accountManager: AccountManager, state: ResponseState): Inspection {
  const data = record(input);
  const usage = record(data.response).usage || data.usage;
  if (isRecord(usage)) {
    // Streams may repeat cumulative usage. Count increases rather than totals.
    const previous = state.usage || { input: 0, output: 0, cached: 0 };
    const count = tokenCount;
    const input = Math.max(previous.input, count(usage.input_tokens));
    const output = Math.max(previous.output, count(usage.output_tokens));
    const cached = Math.max(previous.cached, Math.min(input, count(record(usage.input_tokens_details).cached_tokens)));
    accountManager.updateUsage(accountIndex, input - previous.input, output - previous.output, cached - previous.cached);
    state.usage = { input, output, cached };
  }

  if (!state.embedded429Seen && isEmbedded429Payload(data)) {
    state.embedded429Seen = true;
    markEmbedded429(accountIndex, accountManager);
    return { embedded429: true };
  }

  return { embedded429: false };
}

function markEmbedded429(accountIndex: Account, accountManager: AccountManager): void {
  const account = accountManager._resolveAccount(accountIndex);
  if (!account) return;

  const retryAfter = computeAccountRetryAfter(account, DEFAULT_EMBEDDED_429_RETRY_SECONDS);
  console.log(`[TeamCodex] Embedded 429 failure on "${account.name}" — switching accounts for ${retryAfter}s`);
  accountManager.markRateLimited(accountIndex, retryAfter);
}

