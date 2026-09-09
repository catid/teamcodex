import { mkdir,writeFile } from 'node:fs/promises';
import http from 'node:http';
import { join } from 'node:path';

import { createError, errorMessage, errorResponse } from './errors.js';
import { isTransientError, retryDelay,retryPolicy, TRANSIENT_STATUSES } from './retry.js';


const HOP_BY_HOP_HEADERS = new Set([
  'host', 'connection', 'keep-alive', 'transfer-encoding',
  'te', 'trailer', 'upgrade', 'proxy-authorization', 'proxy-authenticate',
]);

// A 429 (HTTP or embedded) means the current account is being throttled. We
// never wait in-proxy — holding the client connection risks the client (codex)
// timing out and exhausting its own retries against a single throttled account.
// Instead we mark the account rate-limited and immediately switch, exactly like
// quota-based rotation. When a 429 carries no reset hint, back off this long.
const DEFAULT_429_BACKOFF_SECONDS = 60;
const DEFAULT_EMBEDDED_429_RETRY_SECONDS = 3600;
const EMBEDDED_429_RE = /\b(?:429|too many requests|rate.?limit|exceeded retry limit)\b/i;

export function createProxyServer(accountManager, config, hooks = {}) {
  const upstream = config.upstream || 'https://chatgpt.com';
  const apiUpstream = config.apiUpstream || 'https://api.openai.com';
  const proxyApiKey = config.proxy?.apiKey;
  const logDir = config.logDir || null;
  let requestCounter = 0;
  const startedAt = new Date().toISOString();
  let activeRequests = 0;
  const activePools = new Map();

  if (logDir) {
    mkdir(logDir, { recursive: true }).catch(() => {});
  }

  const server = http.createServer(async (req, res) => {
    try {
      // Native localhost is allowed; Docker requires the key on every connection.
      const clientKey = req.headers['x-api-key'] || req.headers.authorization?.replace(/^Bearer /i, '');
      const remoteAddr = req.socket.remoteAddress;
      const isLocal = remoteAddr === '127.0.0.1' || remoteAddr === '::1' || remoteAddr === '::ffff:127.0.0.1';
      if ((!proxyApiKey || clientKey !== proxyApiKey) && (!isLocal || process.env.TEAMCODEX_REQUIRE_API_KEY === '1')) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(errorResponse('INVALID_PROXY_KEY')));
        return;
      }

      // Status endpoint
      if (req.method === 'GET' && req.url === '/teamcodex/status') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ...accountManager.getStatus(), service: { startedAt, uptimeSeconds: Math.floor((Date.now() - Date.parse(startedAt)) / 1000), inFlight: activeRequests } }, null, 2));
        return;
      }

      // Reload endpoint — pick up config changes (new/replaced/removed
      // accounts) without restarting. Called by `teamcodex login/import/remove`.
      if (req.method === 'POST' && req.url.split('?')[0] === '/teamcodex/reload') {
        if (!hooks.reloadAccounts) {
          res.writeHead(501, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(errorResponse('RELOAD_UNSUPPORTED')));
          return;
        }
        try {
          const removeMissing = /[?&]removeMissing=1(&|$)/.test(req.url);
          const result = await hooks.reloadAccounts({ removeMissing });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(errorResponse('RELOAD_FAILED', { message: err.message })));
        }
        return;
      }

      const poolName = req.headers['x-teamcodex-pool'] ?? accountManager.routing?.defaultPool;
      if (poolName !== undefined && (typeof poolName !== 'string' || !poolName || !accountManager.routing || !Object.hasOwn(accountManager.routing.pools, poolName))) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify(errorResponse('ROUTING_POOL_UNKNOWN', { name: String(poolName) })));
        return;
      }
      const limit = accountManager.routing?.pools[poolName]?.maxConcurrentRequests ?? config.maxConcurrentRequests ?? 100;
      const poolKey = poolName ?? 'default';
      if (activeRequests >= (config.maxConcurrentRequests ?? 100) || (activePools.get(poolKey) ?? 0) >= limit) {
        res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '1' });
        res.end(JSON.stringify(errorResponse('PROXY_OVERLOADED')));
        return;
      }
      activeRequests++;
      activePools.set(poolKey, (activePools.get(poolKey) ?? 0) + 1);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        activeRequests--;
        activePools.set(poolKey, activePools.get(poolKey) - 1);
      };
      res.once('close', release);
      res.once('finish', release);
      // Track request
      const reqId = ++requestCounter;
      const requestStarted = performance.now();
      const ctx = { account: null, accountRef: null, status: null, attempts: 0, excluded: new Set(), poolName, networkRetries: 0, recovered: false, refreshed: new Set() };
      let recorded = false;
      const recordRequest = () => {
        if (recorded) return;
        recorded = true;
        accountManager.stats?.recordRequest({ status: res.statusCode, disconnected: !res.writableFinished,
          durationMs: performance.now() - requestStarted }, ctx.accountRef);
      };
      res.once('finish', recordRequest);
      res.once('close', recordRequest);
      hooks.onRequestStart?.(reqId, { method: req.method, path: req.url });

      // Buffer request body (needed for retry on 429)
      const bodyChunks = [];
      let requestSize = 0;
      for await (const chunk of req) {
        requestSize += chunk.length;
        if (requestSize > 32 * 1024 * 1024) {
          res.writeHead(413, { 'content-type': 'application/json' });
          res.end(JSON.stringify(errorResponse('REQUEST_TOO_LARGE')));
          return;
        }
        bodyChunks.push(chunk);
      }
      const body = Buffer.concat(bodyChunks);

      try {
        await forwardRequest(req, res, body, accountManager, { upstream, apiUpstream, retry: retryPolicy(config) }, 0, hooks, reqId, ctx, logDir);
      } catch (err) {
        ctx.status = ctx.status || 502;
        console.error(errorMessage('UNHANDLED_ERROR'), err);
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(errorResponse('PROXY_INTERNAL_ERROR')));
        } else {
          res.destroy();
        }
      } finally {
        hooks.onRequestEnd?.(reqId, {
          method: req.method, path: req.url,
          account: ctx.account, status: ctx.status,
        });
      }
    } catch (err) {
      console.error(errorMessage('UNHANDLED_ERROR'), err);
    }
  });

  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  return server;
}

function logTimestamp() {
  const d = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

async function writeRequestLog(logDir, reqId, sections) {
  if (!logDir) return;
  const ts = logTimestamp();
  const filename = `${ts}_${String(reqId).padStart(5, '0')}.log`;
  try {
    await writeFile(join(logDir, filename), sections.join('\n\n'), 'utf-8');
  } catch (err) {
    console.error(errorMessage('REQUEST_LOG_FAILED', { message: err.message }));
  }
}

function formatHeaders(headers) {
  if (headers.entries) {
    return [...headers.entries()].map(([k, v]) => `  ${k}: ${v}`).join('\n');
  }
  return Object.entries(headers).map(([k, v]) => `  ${k}: ${v}`).join('\n');
}

/**
 * Build the upstream URL for a request. ChatGPT accounts get a pure path
 * passthrough to chatgpt.com. API key accounts have the Codex backend
 * /responses path rewritten to the public API /v1/responses.
 */
function buildUpstreamUrl(account, reqUrl, upstreams) {
  const base = (account.type === 'apikey' ? upstreams.apiUpstream : upstreams.upstream).replace(/\/$/, '');
  const path = account.type === 'apikey'
    ? reqUrl.replace(/^\/backend-api\/codex(?=\/|\?|$)/, '/v1').replace(/^\/responses(?=\/|\?|$)/, '/v1/responses')
    : reqUrl;
  return `${base}${path}`;
}

async function forwardRequest(req, res, body, accountManager, upstreams, retryCount, hooks, reqId, ctx, logDir) {
  const maxRetries = accountManager.accounts.length * 2;

  if (res.destroyed || res.writableEnded) return;
  // A bounded recovery check can return an account to service after a reset.
  let account = accountManager.getActiveAccount(ctx.poolName, ctx.excluded);
  if (!account && !ctx.recovered && hooks.onAccountsUnavailable) {
    ctx.recovered = true;
    let timer;
    let onClose;
    try {
      await Promise.race([
        Promise.resolve().then(() => hooks.onAccountsUnavailable()).catch(() => {}),
        new Promise(resolve => {
          timer = setTimeout(resolve, 5000);
          onClose = resolve;
          res.once('close', onClose);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      res.removeListener('close', onClose);
    }
    if (res.destroyed) return;
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
    if ((['error', 'throttled'].includes(account.status) || !accountManager.accounts.includes(account)) && retryCount < maxRetries) {
      lease.release();
      return forwardRequest(req, res, body, accountManager, upstreams, retryCount + 1, hooks, reqId, ctx, logDir);
    }

    if (res.destroyed) return;

    // Build upstream request headers
    const headers = {};
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
      headers[key] = value;
    }

    // Always replace the client's credentials with the active account's. Never
    // let the client's own chatgpt-account-id leak through with our token — if
    // we don't have an account id, drop it so the backend uses the token's own.
    delete headers['x-teamcodex-pool'];
    headers['authorization'] = `Bearer ${account.credential}`;
    if (account.type === 'chatgpt' && account.accountId) {
      headers['chatgpt-account-id'] = account.accountId;
    } else {
      delete headers['chatgpt-account-id'];
    }

    const upstreamUrl = buildUpstreamUrl(account, req.url, upstreams);
    const method = req.method;

    // Build log sections
    const logSections = [];
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
    let timeout;
    const armTimeout = seconds => {
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
      const upstreamRes = await fetch(upstreamUrl, {
        signal: controller.signal,
        method,
        headers,
        body: ['GET', 'HEAD'].includes(method) ? undefined : body,
        redirect: 'manual',
      });

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
      const rateLimitHeaders = {};
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
        if (account.type === 'chatgpt' && account.refreshToken && !ctx.refreshed.has(account)) {
          ctx.refreshed.add(account);
          console.log(`[TeamCodex] 401 on "${account.name}" — forcing token refresh`);
          const prevCredential = account.credential;
          await accountManager.ensureTokenFresh(account, true);
          if (account.credential === prevCredential && account.status === 'active') {
            accountManager.markAuthFailed(account);
          }
        } else {
          accountManager.markAuthFailed(account);
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
      const responseHeaders = {};
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
        const streamLog = logDir ? [] : null;
        const streamResult = await streamResponse(upstreamRes.body, res, upstreamRes.status, responseHeaders, account, accountManager, streamLog, touch, controller.signal);
        if (logDir) {
          logSections.push(`=== RESPONSE BODY (streamed) ===\n${streamLog.join('')}`);
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
        const chunks = [];
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
      console.error(errorMessage('ACCOUNT_UPSTREAM_FAILED', { name: account.name }), err.message);

      if (logDir) {
        logSections.push(`=== ERROR ===\n${err.stack || err.message}`);
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
        res.end(JSON.stringify(errorResponse('UPSTREAM_FAILED', { message: err.message })));
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

/**
 * Stream an SSE response to the client, parsing usage data along the way.
 */
async function streamResponse(webStream, res, status, headers, accountIndex, accountManager, streamLog, touch, signal) {
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
      sseBuffer = events.pop(); // keep incomplete event
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

  async function writeStreamChunk(res, status, headers, chunk, hasWritten) {
    if (!hasWritten && !res.headersSent) {
      res.writeHead(status, headers);
    }

    const ok = typeof chunk === 'string'
      ? res.write(chunk)
      : res.write(encoder.encode(chunk));

    // Handle backpressure — also bail out if client disconnects,
    // because 'drain' will never fire on a destroyed socket
    if (!ok) {
      await new Promise((resolve, reject) => {
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

function inspectSSEEvent(event, accountIndex, accountManager, state) {
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

function inspectResponseBody(buffer, accountIndex, accountManager) {
  try {
    return inspectResponsePayload(JSON.parse(buffer.toString()), accountIndex, accountManager, { embedded429Seen: false });
  } catch {
    // not JSON
    return { embedded429: false };
  }
}

function inspectResponsePayload(data, accountIndex, accountManager, state) {
  const usage = data?.response?.usage || data?.usage;
  if (usage) {
    // Streams may repeat cumulative usage. Count increases rather than totals.
    const previous = state.usage || { input: 0, output: 0, cached: 0 };
    const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
    const input = Math.max(previous.input, count(usage.input_tokens));
    const output = Math.max(previous.output, count(usage.output_tokens));
    const cached = Math.max(previous.cached, Math.min(input, count(usage.input_tokens_details?.cached_tokens)));
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

function isEmbedded429Payload(data) {
  if (!data || typeof data !== 'object') return false;

  const eventType = typeof data.type === 'string' ? data.type : '';
  const status = data.response?.status ?? data.status;
  const hasError = Boolean(data.error || data.response?.error);
  const has429Status = [status, data.status_code, data.statusCode]
    .some(value => value === 429 || value === '429');
  const isFailure = hasError ||
    eventType.endsWith('.failed') ||
    eventType === 'error' ||
    status === 'failed' ||
    has429Status;

  // Some backend layers surface their own retry exhaustion as a plain JSON/SSE
  // error envelope, e.g. { "detail": "exceeded retry limit, last status: 429" },
  // without setting status/error/type fields. Only inspect error-like envelope
  // fields here so normal assistant output that talks about 429s passes through.
  const envelopeText = [
    errorDetailsToText(data.detail),
    errorDetailsToText(data.message),
    errorDetailsToText(data.reason),
    errorDetailsToText(data.status_details),
    errorDetailsToText(data.statusText),
    errorDetailsToText(data.code),
  ].join(' ');

  if (!isFailure) {
    const isProgressEvent = eventType.startsWith('response.') && !eventType.endsWith('.failed');
    return !isProgressEvent && EMBEDDED_429_RE.test(envelopeText);
  }

  const text = [
    eventType,
    errorDetailsToText(data.error),
    errorDetailsToText(data.response?.error),
    envelopeText,
    errorDetailsToText(data.response?.status_details),
    errorDetailsToText(data.response?.detail),
    errorDetailsToText(data.response?.message),
    errorDetailsToText(status),
    errorDetailsToText(data.status_code),
    errorDetailsToText(data.statusCode),
  ].join(' ');

  return EMBEDDED_429_RE.test(text);
}

function errorDetailsToText(value) {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(errorDetailsToText).join(' ');
  if (typeof value !== 'object') return '';

  return [
    'type',
    'code',
    'detail',
    'details',
    'error',
    'errors',
    'message',
    'reason',
    'status',
    'status_code',
    'statusCode',
    'statusText',
  ].map(key => errorDetailsToText(value[key])).join(' ');
}

function markEmbedded429(accountIndex, accountManager) {
  const account = accountManager._resolveAccount(accountIndex);
  if (!account) return;

  const retryAfter = computeAccountRetryAfter(account, DEFAULT_EMBEDDED_429_RETRY_SECONDS);
  console.log(`[TeamCodex] Embedded 429 failure on "${account.name}" — switching accounts for ${retryAfter}s`);
  accountManager.markRateLimited(accountIndex, retryAfter);
}

function computeAccountRetryAfter(account, fallbackSeconds) {
  const now = Date.now();
  const resets = [
    account.rateLimitedUntil,
    account.quota?.primaryReset,
    account.quota?.secondaryReset,
    account.quota?.resetsAt,
  ].filter(reset => Number.isFinite(reset) && reset > now);

  if (resets.length === 0) return fallbackSeconds;
  return Math.max(1, Math.ceil((Math.min(...resets) - now) / 1000));
}

function writeAllAccountsRateLimited(res, accountManager) {
  const status = accountManager.getStatus();
  const retryAfter = computeRetryAfter(status.accounts);
  res.writeHead(429, {
    'Content-Type': 'application/json',
    'retry-after': String(retryAfter),
  });
  res.end(JSON.stringify(errorResponse('ACCOUNTS_RATE_LIMITED', { count: accountManager.accounts.length, seconds: retryAfter })));
}

function computeRetryAfter(accounts) {
  let soonest = Infinity;
  for (const acct of accounts) {
    const reset = (acct.rateLimitedUntil ? new Date(acct.rateLimitedUntil).getTime() : null)
      || acct.quota.primaryReset || acct.quota.secondaryReset || acct.quota.resetsAt;
    if (reset) {
      const ms = reset - Date.now();
      if (ms < soonest) soonest = ms;
    }
  }
  return soonest === Infinity ? 60 : Math.max(1, Math.ceil(soonest / 1000));
}

function parseRetryAfter(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, Math.ceil((date - Date.now()) / 1000)) : null;
}
