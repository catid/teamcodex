import type { ServerResponse } from 'node:http';

import type { Account } from '@teamcodex/core/accounts';
import { createError } from '@teamcodex/core/errors';

import type { AccountManager } from '../account-manager.ts';
import { inspectSSEEvent } from './inspection.ts';

export async function streamResponse(webStream: ReadableStream<Uint8Array>, res: ServerResponse, status: number, headers: Record<string, string>, accountIndex: Account, accountManager: AccountManager, streamLog: string[] | null, touch: () => void, signal: AbortSignal): Promise<{ embedded429: boolean; bytesSent: boolean }> {
  const reader = webStream.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let sseBuffer = '';
  const streamState = { embedded429Seen: false };
  let bytesSent = false;
  let shouldEnd = true;
  const onClose = () => { reader.cancel().catch(() => {}); };
  res.once('close', onClose);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      touch();

      // Client disconnected — stop reading from upstream
      if (res.destroyed) break;

      const text = decoder.decode(value, { stream: true });

      // Capture for logging
      if (streamLog) streamLog.push(text);

      // Parse SSE events for usage and embedded rate-limit failures
      sseBuffer += text;
      const events = sseBuffer.split(/\r?\n\r?\n/);
      sseBuffer = events.pop() ?? ''; // keep incomplete event
      if (sseBuffer.length > 1024 * 1024 || events.some(event => event.length > 1024 * 1024)) {
        throw createError('SSE_EVENT_TOO_LARGE');
      }

      for (const event of events) {
        const eventText = `${event}\n\n`;
        const eventResult = inspectSSEEvent(event, accountIndex, accountManager, streamState);
        if (eventResult.embedded429) {
          shouldEnd = false;
          if (bytesSent) {
            res.destroy();
          }
          return { embedded429: true, bytesSent };
        }

        bytesSent = await writeStreamChunk(res, status, headers, eventText, bytesSent);
        if (res.destroyed) {
          shouldEnd = false;
          return { embedded429: false, bytesSent };
        }
      }
    }

    if (!bytesSent && !sseBuffer && !res.destroyed) throw createError('UPSTREAM_STREAM_EMPTY');
    const trailing = decoder.decode();
    if (trailing) {
      sseBuffer += trailing;
    }

    if (sseBuffer.length > 0) {
      const eventResult = inspectSSEEvent(sseBuffer, accountIndex, accountManager, streamState);
      if (eventResult.embedded429) {
        shouldEnd = false;
        if (bytesSent) {
          res.destroy();
        }
        return { embedded429: true, bytesSent };
      }

      bytesSent = await writeStreamChunk(res, status, headers, sseBuffer, bytesSent);
    }

    return { embedded429: false, bytesSent };
  } catch (err) {
    shouldEnd = false;
    if (res.headersSent) res.destroy();
    throw err;
  } finally {
    res.removeListener('close', onClose);
    // Cancel upstream reader to stop consuming data nobody needs
    reader.cancel().catch(() => {});
    if (shouldEnd && !res.writableEnded && !res.destroyed) {
      if (!bytesSent && !res.headersSent) {
        res.writeHead(status, headers);
      }
      res.end();
    }
  }

  async function writeStreamChunk(res: ServerResponse, status: number, headers: Record<string, string>, chunk: string, hasWritten: boolean): Promise<boolean> {
    if (!hasWritten && !res.headersSent) {
      res.writeHead(status, headers);
    }

    const ok = typeof chunk === 'string'
      ? res.write(chunk)
      : res.write(encoder.encode(chunk));

    // Handle backpressure — also bail out if client disconnects,
    // because 'drain' will never fire on a destroyed socket
    if (!ok) {
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => { reject(signal.reason); finish(); };
        const finish = () => {
          res.removeListener('drain', finish);
          res.removeListener('close', finish);
          signal.removeEventListener('abort', onAbort);
          resolve();
        };
        res.once('drain', finish);
        res.once('close', finish);
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
        if (res.destroyed) finish();
      });
    }

    return true;
  }
}

