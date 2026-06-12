import http from 'node:http';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';


const HOP_BY_HOP_HEADERS = new Set([
  'host', 'connection', 'keep-alive', 'transfer-encoding',
  'te', 'trailer', 'upgrade', 'proxy-authorization', 'proxy-authenticate',
]);

// Wait-and-retry on 429 only up to this long; longer means quota exhaustion,
// so switch accounts instead.
const MAX_RETRY_WAIT_SECONDS = 120;

export function createProxyServer(accountManager, config, hooks = {}) {
  const upstream = config.upstream || 'https://chatgpt.com';
  const apiUpstream = config.apiUpstream || 'https://api.openai.com';
  const proxyApiKey = config.proxy?.apiKey;
  const logDir = config.logDir || null;
  let requestCounter = 0;

  if (logDir) {
    mkdir(logDir, { recursive: true }).catch(() => {});
  }

  const server = http.createServer(async (req, res) => {
    try {
      // Auth check — skip for localhost connections
      const clientKey = req.headers['x-api-key'];
      const remoteAddr = req.socket.remoteAddress;
      const isLocal = remoteAddr === '127.0.0.1' || remoteAddr === '::1' || remoteAddr === '::ffff:127.0.0.1';
      if (proxyApiKey && clientKey !== proxyApiKey && !isLocal) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: { type: 'authentication_error', message: 'Invalid proxy API key' },
        }));
        return;
      }

      // Status endpoint
      if (req.method === 'GET' && req.url === '/teamcodex/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(accountManager.getStatus(), null, 2));
        return;
      }

      // Track request
      const reqId = ++requestCounter;
      hooks.onRequestStart?.(reqId, { method: req.method, path: req.url });

      // Buffer request body (needed for retry on 429)
      const bodyChunks = [];
      for await (const chunk of req) {
        bodyChunks.push(chunk);
      }
      const body = Buffer.concat(bodyChunks);

      const ctx = { account: null, status: null };
      try {
        await forwardRequest(req, res, body, accountManager, { upstream, apiUpstream }, 0, hooks, reqId, ctx, logDir);
      } catch (err) {
        ctx.status = ctx.status || 502;
        console.error('[TeamCodex] Unhandled error:', err);
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: { type: 'proxy_error', message: 'Internal proxy error' },
          }));
        }
      } finally {
        hooks.onRequestEnd?.(reqId, {
          method: req.method, path: req.url,
          account: ctx.account, status: ctx.status,
        });
      }
    } catch (err) {
      console.error('[TeamCodex] Unhandled error:', err);
    }
  });

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
    console.error(`[TeamCodex] Failed to write log: ${err.message}`);
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
  if (account.type === 'apikey' && /\/responses(\?|$)/.test(reqUrl)) {
    const qs = reqUrl.includes('?') ? reqUrl.slice(reqUrl.indexOf('?')) : '';
    return `${upstreams.apiUpstream}/v1/responses${qs}`;
  }
  return `${upstreams.upstream}${reqUrl}`;
}

async function forwardRequest(req, res, body, accountManager, upstreams, retryCount, hooks, reqId, ctx, logDir) {
  const maxRetries = accountManager.accounts.length;

  // Select account
  const account = accountManager.getActiveAccount();
  if (!account) {
    ctx.status = 429;
    ctx.account = '(none available)';
    const status = accountManager.getStatus();
    const retryAfter = computeRetryAfter(status.accounts);
    res.writeHead(429, {
      'Content-Type': 'application/json',
      'retry-after': String(retryAfter),
    });
    res.end(JSON.stringify({
      error: {
        type: 'rate_limit_error',
        message: `All ${accountManager.accounts.length} accounts exhausted. Retry in ${retryAfter}s.`,
      },
    }));
    return;
  }

  // Track which account handles this request
  ctx.account = account.name;
  hooks.onRequestRouted?.(reqId, { account: account.name });

  // Refresh token if needed
  await accountManager.ensureTokenFresh(account.index);
  if (account.status === 'error' && retryCount < maxRetries) {
    return forwardRequest(req, res, body, accountManager, upstreams, retryCount + 1, hooks, reqId, ctx, logDir);
  }

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
      safeHeaders['authorization'] = safeHeaders['authorization'].slice(0, 20) + '...';
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

  try {
    const upstreamRes = await fetch(upstreamUrl, {
      method,
      headers,
      body: ['GET', 'HEAD'].includes(method) ? undefined : body,
      redirect: 'manual',
    });

    // Extract rate limit headers
    const rateLimitHeaders = {};
    for (const [key, value] of upstreamRes.headers.entries()) {
      if (key.startsWith('x-codex-') || key.startsWith('x-ratelimit-')) {
        rateLimitHeaders[key] = value;
      }
    }
    accountManager.updateQuota(account.index, rateLimitHeaders);

    // 401 on a ChatGPT account: force a token refresh and retry. If the
    // refresh fails the account is marked 'error' and getActiveAccount will
    // route the retry to a different account.
    if (upstreamRes.status === 401 && account.type === 'chatgpt' && retryCount < maxRetries) {
      await upstreamRes.body?.cancel();
      if (logDir) logSections.push('=== RESPONSE 401 — forcing token refresh ===');
      console.log(`[TeamCodex] 401 on "${account.name}" — forcing token refresh`);
      await accountManager.ensureTokenFresh(account.index, true);
      return forwardRequest(req, res, body, accountManager, upstreams, retryCount + 1, hooks, reqId, ctx, logDir);
    }

    // On 429: short retry-after means a transient rate limit — wait and retry
    // the same account. Long (or missing) retry-after means the usage window
    // is exhausted — mark the account and switch to the next one.
    if (upstreamRes.status === 429) {
      const retryAfterHdr = parseInt(upstreamRes.headers.get('retry-after'), 10);
      await upstreamRes.body?.cancel();

      const resetAt = rateLimitHeaders['x-codex-primary-reset-at']
        ? parseFloat(rateLimitHeaders['x-codex-primary-reset-at']) * 1000
        : null;
      const waitSecs = !isNaN(retryAfterHdr)
        ? retryAfterHdr
        : resetAt
          ? Math.ceil((resetAt - Date.now()) / 1000)
          : null;

      if (waitSecs != null && waitSecs <= MAX_RETRY_WAIT_SECONDS) {
        if (logDir) {
          logSections.push(`=== RESPONSE 429 — waiting ${waitSecs}s ===\n${formatHeaders(upstreamRes.headers)}`);
        }
        console.log(`[TeamCodex] 429 on "${account.name}" — waiting ${waitSecs}s before retry`);
        await new Promise(resolve => setTimeout(resolve, waitSecs * 1000));
        // Client may have disconnected during the wait
        if (res.destroyed) return;
        return forwardRequest(req, res, body, accountManager, upstreams, retryCount, hooks, reqId, ctx, logDir);
      }

      // Usage limit reached — throttle this account until reset and switch
      accountManager.markRateLimited(account.index, waitSecs ?? 3600);
      if (logDir) {
        logSections.push(`=== RESPONSE 429 — usage limit, switching account ===\n${formatHeaders(upstreamRes.headers)}`);
        writeRequestLog(logDir, reqId, logSections);
      }
      if (retryCount < maxRetries) {
        return forwardRequest(req, res, body, accountManager, upstreams, retryCount + 1, hooks, reqId, ctx, logDir);
      }
      ctx.status = 429;
      res.writeHead(429, { 'Content-Type': 'application/json', 'retry-after': String(waitSecs ?? 3600) });
      res.end(JSON.stringify({
        error: { type: 'rate_limit_error', message: 'All accounts rate limited' },
      }));
      return;
    }

    // Log response headers
    if (logDir) {
      logSections.push(`=== RESPONSE ${upstreamRes.status} ===\n${formatHeaders(upstreamRes.headers)}`);
    }

    ctx.status = upstreamRes.status;

    // Build response headers (skip hop-by-hop and encoding headers)
    const responseHeaders = {};
    for (const [key, value] of upstreamRes.headers.entries()) {
      if (key === 'transfer-encoding' || key === 'connection') continue;
      // Strip content-encoding/content-length since fetch may auto-decompress
      if (key === 'content-encoding' || key === 'content-length') continue;
      responseHeaders[key] = value;
    }

    res.writeHead(upstreamRes.status, responseHeaders);

    if (!upstreamRes.body) {
      if (logDir) {
        logSections.push(`=== RESPONSE BODY ===\n(empty)`);
        writeRequestLog(logDir, reqId, logSections);
      }
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
      await streamResponse(upstreamRes.body, res, account.index, accountManager, streamLog);
      if (logDir) {
        logSections.push(`=== RESPONSE BODY (streamed) ===\n${streamLog.join('')}`);
        writeRequestLog(logDir, reqId, logSections);
      }
    } else {
      const buf = Buffer.from(await upstreamRes.arrayBuffer());
      extractUsageFromBody(buf, account.index, accountManager);
      if (logDir) {
        try {
          logSections.push(`=== RESPONSE BODY ===\n${JSON.stringify(JSON.parse(buf.toString()), null, 2)}`);
        } catch {
          logSections.push(`=== RESPONSE BODY (${buf.length} bytes) ===\n${buf.toString().slice(0, 8192)}`);
        }
        writeRequestLog(logDir, reqId, logSections);
      }
      res.end(buf);
    }
  } catch (err) {
    console.error(`[TeamCodex] Upstream error (account "${account.name}"):`, err.message);

    if (logDir) {
      logSections.push(`=== ERROR ===\n${err.stack || err.message}`);
      writeRequestLog(logDir, reqId, logSections);
    }

    const isTransient = err instanceof Error &&
      (err.message.includes('fetch failed') ||
        err.code === 'ECONNRESET' || err.code === 'ECONNREFUSED' ||
        err.code === 'ETIMEDOUT' || err.code === 'UND_ERR_CONNECT_TIMEOUT');

    // Transient network errors: just close the connection and let the client retry
    if (isTransient) {
      res.destroy();
      return;
    }

    if (retryCount < maxRetries && !res.headersSent) {
      account.status = 'error';
      return forwardRequest(req, res, body, accountManager, upstreams, retryCount + 1, hooks, reqId, ctx, logDir);
    }
    ctx.status = 502;

    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: { type: 'proxy_error', message: `Upstream error: ${err.message}` },
      }));
    }
  }
}

/**
 * Stream an SSE response to the client, parsing usage data along the way.
 */
async function streamResponse(webStream, res, accountIndex, accountManager, streamLog) {
  const reader = webStream.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      // Client disconnected — stop reading from upstream
      if (res.destroyed) break;

      // Forward chunk immediately
      const ok = res.write(value);

      const text = decoder.decode(value, { stream: true });

      // Capture for logging
      if (streamLog) streamLog.push(text);

      // Parse SSE events for usage tracking
      sseBuffer += text;
      const events = sseBuffer.split('\n\n');
      sseBuffer = events.pop(); // keep incomplete event

      for (const event of events) {
        parseSSEUsage(event, accountIndex, accountManager);
      }

      // Handle backpressure — also bail out if client disconnects,
      // because 'drain' will never fire on a destroyed socket
      if (!ok) {
        await new Promise(resolve => {
          res.once('drain', resolve);
          res.once('close', resolve);
        });
        if (res.destroyed) break;
      }
    }

    // Parse any remaining buffer
    if (sseBuffer.trim()) {
      parseSSEUsage(sseBuffer, accountIndex, accountManager);
    }
  } finally {
    // Cancel upstream reader to stop consuming data nobody needs
    reader.cancel().catch(() => {});
    if (!res.writableEnded) res.end();
  }
}

function parseSSEUsage(event, accountIndex, accountManager) {
  const dataLine = event.split('\n').find(l => l.startsWith('data: '));
  if (!dataLine) return;

  try {
    const data = JSON.parse(dataLine.slice(6));
    const usage = data.type === 'response.completed' ? data.response?.usage : null;
    if (usage) {
      accountManager.updateUsage(accountIndex, usage.input_tokens, usage.output_tokens);
    }
  } catch {
    // not valid JSON, skip
  }
}

function extractUsageFromBody(buffer, accountIndex, accountManager) {
  try {
    const json = JSON.parse(buffer.toString());
    if (json.usage) {
      accountManager.updateUsage(accountIndex, json.usage.input_tokens, json.usage.output_tokens);
    }
  } catch {
    // not JSON or no usage
  }
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
