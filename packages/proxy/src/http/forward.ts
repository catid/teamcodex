import type { IncomingMessage, ServerResponse } from 'node:http';

import type { Account } from '@teamcodex/core/accounts';
import { createError, errorMessage, errorResponse } from '@teamcodex/core/errors';
import { httpClient } from '@teamcodex/shared/api-client';

import type { AccountManager } from '../account-manager.ts';
import { isTransientError, retryDelay, TRANSIENT_STATUSES } from '../retry.ts';
import { inspectResponseBody } from './inspection.ts';
import { formatHeaders, writeRequestLog } from './log.ts';
import { computeAccountRetryAfter, computeRetryAfter, parseRetryAfter, writeAllAccountsRateLimited } from './rate-limit.ts';
import { streamResponse } from './stream.ts';
import type { ProxyHooks, RequestContext, Upstreams } from './types.ts';

const HOP_BY_HOP_HEADERS = new Set(['host', 'connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'proxy-authorization', 'proxy-authenticate']);
const DEFAULT_429_BACKOFF_SECONDS = 60;

function buildUpstreamUrl(account: Account, reqUrl: string, upstreams: Upstreams): string {
  const base = (account.type === 'apikey' ? upstreams.apiUpstream : upstreams.upstream).replace(/\/$/, '');
  const path = account.type === 'apikey'
    ? reqUrl.replace(/^\/backend-api\/codex(?=\/|\?|$)/, '/v1').replace(/^\/responses(?=\/|\?|$)/, '/v1/responses')
    : reqUrl;
  return `${base}${path}`;
}

export async function forwardRequest(req: IncomingMessage, res: ServerResponse, body: Buffer<ArrayBuffer>, accountManager: AccountManager, upstreams: Upstreams, retryCount: number, hooks: ProxyHooks, reqId: number, ctx: RequestContext, logDir: string | null): Promise<void> {
  const maxRetries = ctx.maxAccountRetries;

  if (res.destroyed || res.writableEnded) return;
  if (ctx.poolName !== undefined && !Object.hasOwn(accountManager.routing?.pools ?? {}, ctx.poolName)) return writeRoutingChanged(res, ctx);
  // A bounded recovery check can return an account to service after a reset.
  let account = accountManager.getActiveAccount(ctx.poolName, ctx.excluded);
  if (!account && !ctx.recovered && hooks.onAccountsUnavailable) {
    ctx.recovered = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onClose: (() => void) | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(() => hooks.onAccountsUnavailable?.()).catch(() => {}),
        new Promise<void>(resolve => {
          timer = setTimeout(resolve, 5000);
          onClose = resolve;
          res.once('close', onClose);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      if (onClose) res.removeListener('close', onClose);
    }
    if (res.destroyed) return;
    if (ctx.poolName !== undefined && !Object.hasOwn(accountManager.routing?.pools ?? {}, ctx.poolName)) return writeRoutingChanged(res, ctx);
    account = accountManager.getActiveAccount(ctx.poolName, ctx.excluded);
  }
  if (!account) {
    ctx.status = 429;
    ctx.account = '(none available)';
    const status = accountManager.getStatus();
    const retryAfter = computeRetryAfter(status.accounts);
    res.writeHead(429, {
      'Content-Type': 'application/json',
      'retry-after': String(retryAfter),
    });
    res.end(JSON.stringify(errorResponse('ACCOUNTS_EXHAUSTED', { count: accountManager.accounts.length, seconds: retryAfter })));
    return;
  }

  const lease = accountManager.adaptive.start(account);
  let attemptStarted;
  let headerLatency;
  let failed = false;
  try {
    // Track which account handles this request
    ctx.account = account.name;
    ctx.accountRef = account;
    hooks.onRequestRouted?.(reqId, { account: account.name });

    // Refresh token if needed
    await accountManager.ensureTokenFresh(account);
    if (!accountManager.isAccountEligible(account, ctx.poolName)) {
      lease.release();
      if (retryCount >= maxRetries) return writeRoutingChanged(res, ctx);
      return forwardRequest(req, res, body, accountManager, upstreams, retryCount + 1, hooks, reqId, ctx, logDir);
    }

    if (res.destroyed) return;

    // Build upstream request headers
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      const lk = key.toLowerCase();
      if (HOP_BY_HOP_HEADERS.has(lk)) continue;
      if (lk === 'x-api-key') continue;
      // Strip accept-encoding: Node fetch auto-decompresses, which would
      // mismatch the Content-Encoding header we forward to the client
      if (lk === 'accept-encoding') continue;
      // Let fetch recompute content-length from the body we pass it; forwarding
      // the client's value risks a mismatch error in undici
      if (lk === 'content-length') continue;
      if (value !== undefined) headers[key] = Array.isArray(value) ? value.join(', ') : value;
    }

    // Always replace the client's credentials with the active account's. Never
    // let the client's own chatgpt-account-id leak through with our token — if
    // we don't have an account id, drop it so the backend uses the token's own.
    delete headers['x-teamcodex-pool'];
    const credential = account.credential;
    headers['authorization'] = `Bearer ${credential}`;
    if (account.type === 'chatgpt' && account.accountId) {
      headers['chatgpt-account-id'] = account.accountId;
    } else {
      delete headers['chatgpt-account-id'];
    }

    const upstreamUrl = buildUpstreamUrl(account, req.url ?? '/', upstreams);
    const method = req.method ?? 'GET';

    // Build log sections
    const logSections: string[] = [];
    if (logDir) {
      const safeHeaders = { ...headers };
      if (safeHeaders['authorization']) {
        safeHeaders['authorization'] = `${safeHeaders['authorization'].slice(0, 20)  }...`;
      }
      logSections.push(
        `=== REQUEST (account: ${account.name}, retry: ${retryCount}) ===\n${method} ${upstreamUrl}\n${formatHeaders(safeHeaders)}`,
      );
      if (body.length > 0) {
        try {
          logSections.push(`=== REQUEST BODY ===\n${JSON.stringify(JSON.parse(body.toString()), null, 2)}`);
        } catch {
          logSections.push(`=== REQUEST BODY (${body.length} bytes) ===\n${body.toString().slice(0, 4096)}`);
        }
      }
    }

    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const armTimeout = (seconds: number) => {
      clearTimeout(timeout);
      timeout = setTimeout(() => controller.abort(createError('UPSTREAM_TIMEOUT')), seconds * 1000);
      timeout.unref();
    };
    const touch = () => armTimeout(upstreams.retry.idleTimeoutSeconds);
    const onDisconnect = () => controller.abort();
    res.once('close', onDisconnect);
    try {
      accountManager.stats?.recordAttempt(account, ctx.attempts > 0);
      ctx.attempts++;
      attemptStarted = performance.now();
      armTimeout(upstreams.retry.headerTimeoutSeconds);
      const upstreamRes = await httpClient.request({ url: upstreamUrl, options: {
        signal: controller.signal,
        method,
        headers,
        ...(['GET', 'HEAD'].includes(method) ? {} : { body }),
        redirect: 'manual',
      } });

      headerLatency = performance.now() - attemptStarted;
      failed = upstreamRes.status === 429 || upstreamRes.status >= 500;
      touch();
      if (TRANSIENT_STATUSES.has(upstreamRes.status) && ctx.networkRetries < upstreams.retry.maxRetries) {
        await upstreamRes.body?.cancel();
        clearTimeout(timeout);
        await retryDelay(ctx.networkRetries++, controller.signal);
        ctx.excluded.add(account);
        if (!accountManager.routing) accountManager.rotateAfter(account);
        lease.observe(failed, headerLatency);
        lease.release();
        return forwardRequest(req, res, body, accountManager, upstreams, retryCount, hooks, reqId, ctx, logDir);
      }

      // Extract rate limit headers
      const rateLimitHeaders: Record<string, string> = {};
      for (const [key, value] of upstreamRes.headers.entries()) {
        if (key.startsWith('x-codex-') || key.startsWith('x-ratelimit-')) {
          rateLimitHeaders[key] = value;
        }
      }
      accountManager.updateQuota(account, rateLimitHeaders);

      // 401: the account's credentials were rejected. For ChatGPT accounts try
      // a forced token refresh; if that can't produce a new token (revoked
      // refresh token, no refresh token, API key account) mark the account
      // auth-failed so the retry rotates to the next account instead of
      // hammering the same dead credentials and surfacing the 401 to the client.
      if (upstreamRes.status === 401 && retryCount < maxRetries) {
        await upstreamRes.body?.cancel();
        clearTimeout(timeout);
        if (logDir) logSections.push('=== RESPONSE 401 — forcing token refresh ===');
        if (account.credential === credential) {
          if (account.type === 'chatgpt' && account.refreshToken && !ctx.refreshed.has(account)) {
            ctx.refreshed.add(account);
            console.log(`[TeamCodex] 401 on "${account.name}" — forcing token refresh`);
            await accountManager.ensureTokenFresh(account, true);
            if (account.credential === credential && account.status === 'active') accountManager.markAuthFailed(account);
          } else accountManager.markAuthFailed(account);
        }
        lease.observe(failed, headerLatency);
        lease.release();
        return forwardRequest(req, res, body, accountManager, upstreams, retryCount + 1, hooks, reqId, ctx, logDir);
      }

      // On 429: the account is being throttled. Treat it as a backoff signal —
      // mark the account rate-limited (until its reset, if the response tells us)
      // and immediately switch to the next account, exactly like quota-based
      // rotation. We never wait in-proxy: sleeping here holds the client's
      // connection, and if the client (codex) gives up during the wait we'd bail
      // without ever switching, so it keeps hammering the same throttled account
      // and exhausts its own retries ("exceeded retry limit, last status: 429").
      if (upstreamRes.status === 429) {
        const retryAfterHdr = parseRetryAfter(upstreamRes.headers.get('retry-after'));
        await upstreamRes.body?.cancel();

        const waitSecs = retryAfterHdr ?? computeAccountRetryAfter(account, DEFAULT_429_BACKOFF_SECONDS);
        const backoffSecs = Math.max(1, waitSecs ?? DEFAULT_429_BACKOFF_SECONDS);

        accountManager.markRateLimited(account, backoffSecs);
        if (logDir) {
          logSections.push(`=== RESPONSE 429 — backoff ${backoffSecs}s, switching account ===\n${formatHeaders(upstreamRes.headers)}`);
          writeRequestLog(logDir, reqId, logSections);
        }
        console.log(`[TeamCodex] 429 on "${account.name}" — backing off ${backoffSecs}s and switching account`);
        if (retryCount < maxRetries) {
          lease.observe(failed, headerLatency);
          lease.release();
          return forwardRequest(req, res, body, accountManager, upstreams, retryCount + 1, hooks, reqId, ctx, logDir);
        }
        // Every account is throttled — surface a 429 with a retry-after so the
        // client backs off instead of retrying immediately.
        ctx.status = 429;
        return writeAllAccountsRateLimited(res, accountManager);
      }

      // Log response headers
      if (logDir) {
        logSections.push(`=== RESPONSE ${upstreamRes.status} ===\n${formatHeaders(upstreamRes.headers)}`);
      }

      // Build response headers (skip hop-by-hop and encoding headers)
      const responseHeaders: Record<string, string> = {};
      for (const [key, value] of upstreamRes.headers.entries()) {
        if (key === 'transfer-encoding' || key === 'connection') continue;
        // Strip content-encoding/content-length since fetch may auto-decompress
        if (key === 'content-encoding' || key === 'content-length') continue;
        responseHeaders[key] = value;
      }

      if (!upstreamRes.body) {
        if (logDir) {
          logSections.push(`=== RESPONSE BODY ===\n(empty)`);
          writeRequestLog(logDir, reqId, logSections);
        }
        ctx.status = upstreamRes.status;
        res.writeHead(upstreamRes.status, responseHeaders);
        res.end();
        return;
      }

      // The ChatGPT Codex backend omits content-type on SSE responses — fall
      // back to the client's accept header to detect streams
      const contentType = upstreamRes.headers.get('content-type') || '';
      const isStreaming = contentType.includes('text/event-stream') ||
        (!contentType && (req.headers['accept'] || '').includes('text/event-stream'));

      if (isStreaming) {
        const streamLog: string[] | null = logDir ? [] : null;
        const streamResult = await streamResponse(upstreamRes.body, res, upstreamRes.status, responseHeaders, account, accountManager, streamLog, touch, controller.signal);
        if (logDir) {
          logSections.push(`=== RESPONSE BODY (streamed) ===\n${streamLog?.join('') ?? ''}`);
          writeRequestLog(logDir, reqId, logSections);
        }
        if (streamResult.embedded429) {
          failed = true;
          if (!streamResult.bytesSent && retryCount < maxRetries) {
            lease.observe(failed, headerLatency);
            lease.release();
            return forwardRequest(req, res, body, accountManager, upstreams, retryCount + 1, hooks, reqId, ctx, logDir);
          }
          ctx.status = 429;
          if (!streamResult.bytesSent && !res.headersSent) {
            return writeAllAccountsRateLimited(res, accountManager);
          }
          return;
        }
        ctx.status = upstreamRes.status;
      } else {
        const chunks: Uint8Array[] = [];
        let size = 0;
        for await (const chunk of upstreamRes.body) {
          touch();
          size += chunk.length;
          if (size > 32 * 1024 * 1024) throw createError('UPSTREAM_RESPONSE_TOO_LARGE');
          chunks.push(chunk);
        }
        const buf = Buffer.concat(chunks);
        const bodyResult = inspectResponseBody(buf, account, accountManager);
        if (logDir) {
          try {
            logSections.push(`=== RESPONSE BODY ===\n${JSON.stringify(JSON.parse(buf.toString()), null, 2)}`);
          } catch {
            logSections.push(`=== RESPONSE BODY (${buf.length} bytes) ===\n${buf.toString().slice(0, 8192)}`);
          }
          writeRequestLog(logDir, reqId, logSections);
        }
        if (bodyResult.embedded429) {
          failed = true;
          if (retryCount < maxRetries) {
            lease.observe(failed, headerLatency);
            lease.release();
            return forwardRequest(req, res, body, accountManager, upstreams, retryCount + 1, hooks, reqId, ctx, logDir);
          }
          ctx.status = 429;
          return writeAllAccountsRateLimited(res, accountManager);
        }
        ctx.status = upstreamRes.status;
        res.writeHead(upstreamRes.status, responseHeaders);
        res.end(buf);
      }
    } catch (err) {
      if (res.destroyed) return;
      failed = true;
      console.error(errorMessage('ACCOUNT_UPSTREAM_FAILED', { name: account.name }), (err instanceof Error ? err.message : String(err)));

      if (logDir) {
        logSections.push(`=== ERROR ===\n${err instanceof Error ? err.stack || err.message : String(err)}`);
        writeRequestLog(logDir, reqId, logSections);
      }

      // Never replay a partially delivered response, or disable healthy credentials
      // because a connection failed. The next client request can reuse the account.
      if (!res.headersSent && isTransientError(err) && ctx.networkRetries < upstreams.retry.maxRetries) {
        clearTimeout(timeout);
        // The attempt's signal may already have timed out; the delay has its own
        // disconnect cancellation, and the next attempt gets a fresh deadline.
        const waiting = new AbortController();
        const cancel = () => waiting.abort();
        res.once('close', cancel);
        try { await retryDelay(ctx.networkRetries++, waiting.signal); }
        catch { return; }
        finally { res.removeListener('close', cancel); }
        ctx.excluded.add(account);
        if (!accountManager.routing) accountManager.rotateAfter(account);
        lease.observe(failed, headerLatency);
        lease.release();
        return forwardRequest(req, res, body, accountManager, upstreams, retryCount, hooks, reqId, ctx, logDir);
      }
      ctx.status = 502;

      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(errorResponse('UPSTREAM_FAILED', { message: (err instanceof Error ? err.message : String(err)) })));
      } else {
        res.destroy();
      }
    } finally {
      clearTimeout(timeout);
      res.removeListener('close', onDisconnect);
    }
  } finally {
    if (failed || (headerLatency !== undefined && !res.destroyed)) lease.observe(failed, headerLatency);
    lease.release();
  }
}

function writeRoutingChanged(res: ServerResponse, ctx: RequestContext): void {
  ctx.status = 503;
  res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '1' });
  res.end(JSON.stringify(errorResponse('ROUTING_CHANGED')));
}
