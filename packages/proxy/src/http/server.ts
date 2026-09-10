import { mkdir } from 'node:fs/promises';
import http from 'node:http';

import type { Config } from '@teamcodex/core/config';
import { errorMessage, errorResponse } from '@teamcodex/core/errors';

import type { AccountManager } from '../account-manager.ts';
import { retryPolicy } from '../retry.ts';
import { forwardRequest } from './forward.ts';
import type { ProxyHooks, RequestContext } from './types.ts';

export function createProxyServer(accountManager: AccountManager, config: Config, hooks: ProxyHooks = {}): http.Server {
  const upstream = config.upstream || 'https://chatgpt.com';
  const apiUpstream = config.apiUpstream || 'https://api.openai.com';
  const proxyApiKey = config.proxy?.apiKey;
  const logDir = config.logDir || null;
  let requestCounter = 0;
  const startedAt = new Date().toISOString();
  let activeRequests = 0;
  const activePools = new Map<string, number>();

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
      if (req.method === 'POST' && req.url?.split('?')[0] === '/teamcodex/reload') {
        if (!hooks.reloadAccounts) {
          res.writeHead(501, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(errorResponse('RELOAD_UNSUPPORTED')));
          return;
        }
        try {
          const removeMissing = /[?&]removeMissing=1(&|$)/.test(req.url ?? '');
          const result = await hooks.reloadAccounts({ removeMissing });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(errorResponse('RELOAD_FAILED', { message: (err instanceof Error ? err.message : String(err)) })));
        }
        return;
      }

      const poolName = req.headers['x-teamcodex-pool'] ?? accountManager.routing?.defaultPool;
      if (poolName !== undefined && (typeof poolName !== 'string' || !poolName || !accountManager.routing || !Object.hasOwn(accountManager.routing.pools, poolName))) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify(errorResponse('ROUTING_POOL_UNKNOWN', { name: String(poolName) })));
        return;
      }
      const limit = (poolName ? accountManager.routing?.pools[poolName]?.maxConcurrentRequests : undefined) ?? config.maxConcurrentRequests ?? 100;
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
        activePools.set(poolKey, (activePools.get(poolKey) ?? 1) - 1);
      };
      res.once('close', release);
      res.once('finish', release);
      // Track request
      const reqId = ++requestCounter;
      const requestStarted = performance.now();
      const ctx: RequestContext = { account: null, accountRef: null, status: null, attempts: 0, excluded: new Set(), poolName, maxAccountRetries: accountManager.accounts.length * 2, networkRetries: 0, recovered: false, refreshed: new Set() };
      let recorded = false;
      const recordRequest = () => {
        if (recorded) return;
        recorded = true;
        accountManager.stats?.recordRequest({ status: res.statusCode, disconnected: !res.writableFinished,
          durationMs: performance.now() - requestStarted }, ctx.accountRef);
        hooks.onRequestEnd?.(reqId, { method: req.method, path: req.url, account: ctx.account, status: ctx.status ?? res.statusCode });
      };
      res.once('finish', recordRequest);
      res.once('close', recordRequest);
      hooks.onRequestStart?.(reqId, { method: req.method, path: req.url });

      // Buffer request body (needed for retry on 429)
      const bodyChunks: Uint8Array[] = [];
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
      }
    } catch (err) {
      if (res.destroyed) return;
      console.error(errorMessage('UNHANDLED_ERROR'), err);
    }
  });

  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  return server;
}

