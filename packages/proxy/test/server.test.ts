import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';

import type { AccountConfig, Config } from '@teamcodex/core/config';
import { AccountManager } from '@teamcodex/proxy/account-manager';
import { createDefaultConfig } from '@teamcodex/proxy/config';
import { createProxyServer } from '@teamcodex/proxy/server';
import { UsageStats } from '@teamcodex/proxy/stats';
import { afterEach, test } from 'bun:test';

const key = (name: string): AccountConfig => ({ name, type: 'apikey', apiKey: name });

async function listen(server: http.Server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  afterEach(() => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); }));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

async function setup(handler: http.RequestListener, accounts: AccountConfig[] = [key('first'), key('second')], config: Partial<Config> = {}, hooks: Parameters<typeof createProxyServer>[2] = {}) {
  const upstream = await listen(http.createServer(handler));
  const manager = new AccountManager(accounts, 0.98, undefined, { randomIndex: size => size - 1 });
  manager.stats = new UsageStats();
  const url = await listen(createProxyServer(manager, { ...createDefaultConfig(), upstream, apiUpstream: upstream, proxy: { port: 0, apiKey: 'proxy-secret' }, ...config }, hooks));
  return { manager, url };
}

for (const failure of ['http', 'connection']) {
  test(`${failure} retries follow a shuffled rotation schedule`, async () => {
    const seen: (string | undefined)[] = [];
    const { url, manager } = await setup((req, res) => {
      seen.push(req.headers.authorization);
      if (seen.length === 1) {
        if (failure === 'connection') req.socket.destroy();
        else { res.writeHead(503); res.end(); }
      } else { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); }
    }, ['first', 'second', 'third'].map(name => key(name)));
    manager.rotationOrder = [2, 1, 0];
    manager.currentIndex = 2;
    const response = await fetch(`${url}/backend-api/codex/responses`, { method: 'POST', body: '{}' });
    assert.equal(response.status, 200);
    await response.text();
    assert.deepEqual(seen, ['Bearer third', 'Bearer second']);
  });
}

test('401 rejection rotates credentials and API requests use the API upstream', async () => {
  const seen: { auth: string | undefined; path: string | undefined; accountId: string | string[] | undefined }[] = [];
  const { url, manager } = await setup((req, res) => {
    seen.push({ auth: req.headers.authorization, path: req.url, accountId: req.headers['chatgpt-account-id'] });
    res.writeHead(req.headers.authorization === 'Bearer first' ? 401 : 200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  const res = await fetch(`${url}/backend-api/codex/responses?test=1`, { method: 'POST', headers: { 'chatgpt-account-id': 'unrelated' }, body: '{}' });
  assert.equal(res.status, 200);
  await res.text();
  assert.deepEqual(seen.map(x => x.auth), ['Bearer first', 'Bearer second']);
  assert.equal(seen[0]?.path, '/v1/responses?test=1');
  assert.equal(seen[0]?.accountId, undefined);
  assert.equal(getAccount(manager, 0).status, 'error');
});

test('429 HTTP-date Retry-After throttles the failed account and rotates', async () => {
  const reset = Date.now() + 120000;
  const { url, manager } = await setup((req, res) => {
    if (req.headers.authorization === 'Bearer first') {
      res.writeHead(429, { 'retry-after': new Date(reset).toUTCString() });
      res.end();
    } else res.end('{"ok":true}');
  });
  const res = await fetch(`${url}/responses`);
  assert.equal(res.status, 200);
  await res.text();
  assert.ok(Math.abs((getAccount(manager, 0).rateLimitedUntil ?? 0) - reset) < 2000);
});

test('SSE with CRLF boundaries and no space after data streams immediately', async () => {
  let endUpstream: (() => void) | undefined;
  const { url, manager } = await setup((_req, res) => {
    endUpstream = () => res.end();
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data:{"type":"response.completed","response":{"usage":{"input_tokens":7,"output_tokens":3}}}\r\n\r\n');
  });
  const res = await fetch(`${url}/responses`, { signal: AbortSignal.timeout(3000) });
  assert.ok(res.body);
  const reader = res.body.getReader();
  const first = await reader.read();
  assert.match(new TextDecoder().decode(first.value), /response.completed/);
  assert.ok(endUpstream);
  endUpstream();
  await reader.cancel();
  assert.equal(getAccount(manager, 0).usage.totalInputTokens, 7);
});

test('embedded SSE 429 before any output retries another account', async () => {
  const { url, manager } = await setup((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(req.headers.authorization === 'Bearer first'
      ? 'data:{"type":"error","error":{"message":"too many requests"}}\r\n\r\n'
      : 'data: {"type":"response.completed","response":{"usage":{"input_tokens":2}}}\n\n');
  });
  const res = await fetch(`${url}/responses`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /response.completed/);
  assert.equal(getAccount(manager, 0).status, 'throttled');
});

test('removal during a response never charges usage to the next account', async () => {
  let release: (() => void) | undefined;
  const { promise: arrival, resolve: arrived } = Promise.withResolvers<void>();
  const { url, manager } = await setup((_req, res) => {
    release = () => res.end('{"usage":{"input_tokens":50,"output_tokens":20}}');
    arrived();
  });
  const pending = fetch(`${url}/responses`);
  await arrival;
  manager.removeAccount(0);
  assert.ok(release);
  release();
  await (await pending).text();
  assert.equal(getAccount(manager, 0).usage.totalInputTokens, 0);
  assert.equal(getAccount(manager, 0).usage.totalRequests, 0);
  assert.equal(getStats(manager).snapshot().totals.inputTokens, 50);
  assert.equal(getStats(manager).account(getAccount(manager, 0)).inputTokens, 0);
});

test('Docker authentication accepts bearer keys and rejects missing or wrong keys', async () => {
  const original = process.env.TEAMCODEX_REQUIRE_API_KEY;
  process.env.TEAMCODEX_REQUIRE_API_KEY = '1';
  afterEach(() => { if (original === undefined) delete process.env.TEAMCODEX_REQUIRE_API_KEY; else process.env.TEAMCODEX_REQUIRE_API_KEY = original; });
  const { url } = await setup((_req, res) => res.end());
  for (const authorization of ['', 'Bearer wrong', 'Bearer proxy-secret']) {
    const res = await fetch(`${url}/teamcodex/status`, { headers: { authorization } });
    assert.equal(res.status, authorization.endsWith('proxy-secret') ? 200 : 401);
    const body = await res.json();
    if (res.status === 401) {
      assert.equal(body.error.code, 'INVALID_PROXY_KEY');
      assert.equal(body.error.opcode, 3001);
      assert.equal(body.error.type, 'authentication_error');
    }
  }
});

const quickRetry = { retry: { maxRetries: 2, headerTimeoutSeconds: 0.1, idleTimeoutSeconds: 0.1 } };

test('starting on a different account cycles through each throttled account within one request', async () => {
  const seen: (string | undefined)[] = [];
  const { url, manager } = await setup((req, res) => {
    seen.push(req.headers.authorization);
    res.writeHead(req.headers.authorization === 'Bearer first' ? 200 : 429);
    res.end(req.headers.authorization === 'Bearer first' ? 'hello' : '');
  }, [key('first'), key('second'), key('third')]);
  manager.currentIndex = 1;
  const response = await fetch(`${url}/responses`);
  assert.equal(await response.text(), 'hello');
  assert.deepEqual(seen, ['Bearer second', 'Bearer third', 'Bearer first']);
});

for (const failure of ['disconnect', '503', 'headers', 'body']) {
  test(`${failure} failure retries the identical request on another account`, async () => {
    const seen: { body: string; key: string | undefined; id: string | string[] | undefined }[] = [];
    const { url, manager } = await setup(async (req, res) => {
      const chunks: Uint8Array[] = [];
      for await (const chunk of req) chunks.push(chunk);
      seen.push({ body: Buffer.concat(chunks).toString(), key: req.headers.authorization, id: req.headers['idempotency-key'] });
      if (seen.length === 1) {
        if (failure === 'disconnect') req.socket.destroy();
        if (failure === '503') { res.writeHead(503); res.end(); }
        if (failure === 'body') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders(); }
        return;
      }
      res.end('hello');
    }, undefined, quickRetry);
    const response = await fetch(`${url}/responses`, { method: 'POST', headers: { 'idempotency-key': 'stable' }, body: '{"input":"hello"}', signal: AbortSignal.timeout(5000) });
    assert.equal(await response.text(), 'hello');
    assert.deepEqual(seen.map(x => x.key), ['Bearer first', 'Bearer second']);
    assert.ok(seen.every(x => x.body === '{"input":"hello"}' && x.id === 'stable'));
    assert.ok(manager.accounts.every(a => a.status === 'active'));
  });
}

test('silent upstream exhausts a bounded retry budget and returns 502', async () => {
  let attempts = 0;
  const { url, manager } = await setup(() => { attempts++; }, [key('first')], quickRetry);
  const response = await fetch(`${url}/responses`, { signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 502);
  await response.text();
  assert.equal(attempts, 3);
  assert.equal(getAccount(manager, 0).status, 'active');
});

test('a stalled partial stream is closed without replaying or disabling the account', async () => {
  let attempts = 0;
  const { url, manager } = await setup((_req, res) => {
    attempts++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"type":"response.output_text.delta","delta":"hello"}\n\n');
  }, [key('first')], quickRetry);
  const response = await fetch(`${url}/responses`, { signal: AbortSignal.timeout(5000) });
  await assert.rejects(response.text());
  assert.equal(attempts, 1);
  assert.equal(getAccount(manager, 0).status, 'active');
});

test('activity renews the idle deadline throughout a long stream', async () => {
  const { url } = await setup((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    let count = 0;
    const timer = setInterval(() => {
      res.write('data: hello\n\n');
      if (++count === 8) { clearInterval(timer); res.end(); }
    }, 40);
    res.once('close', () => clearInterval(timer));
  }, [key('first')], quickRetry);
  const response = await fetch(`${url}/responses`, { signal: AbortSignal.timeout(5000) });
  assert.equal((await response.text()).match(/hello/g)?.length, 8);
});

test('all-account recovery runs once and serves the original request after capacity returns', async () => {
  let recoveries = 0;
  const { url, manager } = await setup((_req, res) => res.end('hello'), [key('first')], {}, {
    onAccountsUnavailable: async () => {
      recoveries++;
      getAccount(manager, 0).status = 'active';
      getAccount(manager, 0).rateLimitedUntil = null;
    },
  });
  manager.markRateLimited(0, 3600);
  assert.equal(await (await fetch(`${url}/responses`)).text(), 'hello');
  assert.equal(recoveries, 1);
});

test('client disconnect aborts a silent upstream without further attempts', async () => {
  const { promise: arrival, resolve: arrived } = Promise.withResolvers<void>();
  const { promise: closure, resolve: closed } = Promise.withResolvers<void>();
  let attempts = 0;
  const { url } = await setup((_req, res) => {
    attempts++;
    res.once('close', closed);
    arrived();
  }, [key('first')], quickRetry);
  const controller = new AbortController();
  const pending = fetch(`${url}/responses`, { signal: controller.signal });
  await arrival;
  assert.equal((await (await fetch(`${url}/teamcodex/status`)).json()).service.inFlight, 1);
  controller.abort();
  await assert.rejects(pending);
  await closure;
  assert.equal(attempts, 1);
  const snapshot = await (await fetch(`${url}/teamcodex/status`)).json();
  assert.equal(snapshot.service.inFlight, 0);
  assert.equal(snapshot.statistics.totals.requests, 1);
  assert.equal(snapshot.statistics.totals.disconnected, 1);
});

test('statistics distinguish one client request from retries and exclude management traffic', async () => {
  const { url, manager } = await setup((req, res) => {
    if (req.headers.authorization === 'Bearer first') { res.writeHead(429); res.end(); }
    else res.end('{"usage":{"input_tokens":10,"output_tokens":4,"input_tokens_details":{"cached_tokens":8}}}');
  });
  await (await fetch(`${url}/teamcodex/reload`, { method: 'POST' })).text();
  assert.equal((await (await fetch(`${url}/teamcodex/status`)).json()).statistics.totals.requests, 0);
  await (await fetch(`${url}/responses`)).text();
  const response = await fetch(`${url}/teamcodex/status`);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const snapshot = await response.json();
  assert.equal(snapshot.service.inFlight, 0);
  assert.equal(snapshot.statistics.totals.requests, 1);
  assert.equal(snapshot.statistics.totals.attempts, 2);
  assert.equal(snapshot.statistics.totals.retries, 1);
  assert.equal(snapshot.statistics.totals.httpErrors, 0);
  assert.equal(snapshot.statistics.totals.inputTokens, 10);
  assert.equal(snapshot.statistics.totals.outputTokens, 4);
  assert.equal(snapshot.statistics.totals.cachedInputTokens, 8);
  assert.equal(snapshot.accounts[0].totals.attempts, 1);
  assert.equal(snapshot.accounts[0].totals.requests, 0);
  assert.equal(snapshot.accounts[1].totals.requests, 1);
  assert.ok(snapshot.statistics.totals.durationMs > 0);
  assert.doesNotMatch(JSON.stringify(snapshot), /proxy-secret|apiKey|accessToken|refreshToken/);
  assert.equal(getStats(manager).snapshot().totals.requests, 1);
});

test('cumulative SSE usage, repeated events and late cached counts are counted once', async () => {
  const { url, manager } = await setup((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const event = (type: string, input_tokens: unknown, output_tokens: unknown, cached_tokens: unknown) =>
      `data: ${JSON.stringify({ type, response: { usage: { input_tokens, output_tokens, input_tokens_details: { cached_tokens } } } })}\n\n`;
    res.end(event('response.in_progress', 10, 2, 0) + event('response.incomplete', 10, 4, 6) +
      event('response.completed', 10, 4, 8).repeat(2) + event('response.completed', -1, 'bad', 999));
  });
  await (await fetch(`${url}/responses`)).text();
  assert.equal(getStats(manager).snapshot().totals.inputTokens, 10);
  assert.equal(getStats(manager).snapshot().totals.outputTokens, 4);
  assert.equal(getStats(manager).snapshot().totals.cachedInputTokens, 10);
  assert.equal(getAccount(manager, 0).usage.totalInputTokens, 10);
});

test('final HTTP failures count once even when all attempts fail', async () => {
  const { url, manager } = await setup((_req, res) => { res.writeHead(503); res.end(); }, [key('first')], quickRetry);
  await (await fetch(`${url}/responses`)).text();
  const stats = getStats(manager).snapshot().totals;
  assert.equal(stats.requests, 1);
  assert.equal(stats.attempts, 3);
  assert.equal(stats.retries, 2);
  assert.equal(stats.httpErrors, 1);
  assert.equal(stats.disconnected, 0);
});

test('credentials rejected again after a refresh rotate instead of refreshing in a loop', async () => {
  const seen: (string | undefined)[] = [];
  const { url, manager } = await setup((req, res) => {
    seen.push(req.headers.authorization);
    res.writeHead(req.headers.authorization === 'Bearer good' ? 200 : 401);
    res.end(req.headers.authorization === 'Bearer good' ? 'hello' : '');
  }, [{ name: 'bad', type: 'chatgpt', accessToken: 'old', refreshToken: 'refresh' }, key('good')]);
  let refreshed = 0;
  manager.ensureTokenFresh = async (account, force) => {
    if (force) { refreshed++; const live = typeof account === 'number' ? getAccount(manager, account) : account; live.credential = 'still-rejected'; }
  };
  assert.equal(await (await fetch(`${url}/responses`)).text(), 'hello');
  assert.equal(refreshed, 1);
  assert.deepEqual(seen, ['Bearer old', 'Bearer still-rejected', 'Bearer good']);
});

test('admission limits reject excess traffic and release slots after completion', async () => {
  let arrival = Promise.withResolvers<http.ServerResponse>();
  const { url } = await setup((_req, res) => arrival.resolve(res), [key('first')], { maxConcurrentRequests: 1 });
  const first = fetch(`${url}/responses`);
  const held = await arrival.promise;
  const excess = await fetch(`${url}/responses`);
  assert.equal(excess.status, 503);
  assert.equal((await excess.json()).error.code, 'PROXY_OVERLOADED');
  assert.equal(excess.headers.get('retry-after'), '1');
  held.end('{"ok":true}');
  await (await first).text();
  arrival = Promise.withResolvers<http.ServerResponse>();
  const next = fetch(`${url}/responses`);
  (await arrival.promise).end('{"ok":true}');
  const response = await next;
  assert.equal(response.status, 200);
  await response.text();
});

test('pool selection isolates accounts and strips the routing header upstream', async () => {
  let routed: http.IncomingHttpHeaders | undefined;
  const { manager, url } = await setup((req, res) => {
    routed = req.headers;
    res.end('{}');
  });
  manager.routing = { defaultPool: 'main', pools: { main: { accounts: ['first'] }, other: { accounts: ['second'] } } };
  const response = await fetch(`${url}/responses`, { headers: { 'x-teamcodex-pool': 'other' } });
  await response.text();
  assert.ok(routed);
  assert.equal(routed.authorization, 'Bearer second');
  assert.equal(routed['x-teamcodex-pool'], undefined);
  const invalid = await fetch(`${url}/responses`, { headers: { 'x-teamcodex-pool': 'missing' } });
  assert.equal(invalid.status, 400);
});

test('a saturated pool does not block another pool or status requests', async () => {
  const arrival = Promise.withResolvers<http.ServerResponse>();
  const { manager, url } = await setup((req, res) => {
    if (req.headers.authorization === 'Bearer first') arrival.resolve(res);
    else res.end('{}');
  }, [key('first'), key('second')], { maxConcurrentRequests: 2 });
  manager.routing = { defaultPool: 'main', pools: {
    main: { accounts: ['first'], maxConcurrentRequests: 1 },
    other: { accounts: ['second'], maxConcurrentRequests: 1 },
  } };
  const pending = fetch(`${url}/responses`);
  const held = await arrival.promise;
  try {
    const blocked = await fetch(`${url}/responses`);
    assert.equal(blocked.status, 503);
    await blocked.text();
    const other = await fetch(`${url}/responses`, { headers: { 'x-teamcodex-pool': 'other' } });
    assert.equal(other.status, 200);
    await other.text();
    const status = await fetch(`${url}/teamcodex/status`);
    assert.equal(status.status, 200);
    await status.text();
  } finally {
    held.end('{}');
    await (await pending).text();
  }
});

test('adaptive routing avoids occupied accounts and releases attempts after completion', async () => {
  let finish: (() => void) | undefined;
  const { promise: started, resolve: began } = Promise.withResolvers<void>();
  const { manager, url } = await setup((req, res) => {
    if (req.headers.authorization === 'Bearer first') { finish = () => res.end('{}'); began(); }
    else res.end('{}');
  });
  manager.routing = { defaultPool: 'main', pools: { main: { accounts: ['first', 'second'], strategy: 'adaptive' } } };
  const pending = fetch(`${url}/responses`);
  await started;
  assert.equal(manager.adaptive.status(getAccount(manager, 0)).inFlight, 1);
  const second = await fetch(`${url}/responses`);
  assert.equal(second.status, 200);
  await second.text();
  assert.ok(finish);
  finish();
  await (await pending).text();
  assert.ok(manager.getStatus().accounts.every(a => a.adaptive.inFlight === 0));
  assert.ok(manager.getStatus().accounts.every(a => a.adaptive.samples === 1));
});

test('adaptive retries record failed attempts and release both accounts', async () => {
  const { manager, url } = await setup((req, res) => {
    res.writeHead(req.headers.authorization === 'Bearer first' ? 503 : 200);
    res.end('{}');
  });
  manager.routing = { defaultPool: 'main', pools: { main: { accounts: ['first', 'second'], strategy: 'adaptive' } } };
  assert.equal((await fetch(`${url}/responses`)).status, 200);
  const status = manager.getStatus().accounts;
  assert.ok(status.every(a => a.adaptive.inFlight === 0));
  assert.ok((status[0]?.adaptive.failureRate ?? 0) > 0);
  assert.equal(status[1]?.adaptive.failureRate, 0);
});

test('adaptive client cancellation releases load without a failure sample', async () => {
  const { promise: started, resolve: began } = Promise.withResolvers<void>();
  const { manager, url } = await setup(() => { began(); });
  const controller = new AbortController();
  const pending = fetch(`${url}/responses`, { signal: controller.signal }).catch(() => {});
  await started;
  controller.abort();
  await pending;
  for (let i = 0; i < 100 && manager.adaptive.status(getAccount(manager, 0)).inFlight; i++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const metric = manager.adaptive.status(getAccount(manager, 0));
  assert.equal(metric.inFlight, 0);
  assert.equal(metric.samples, 0);
});

test('adaptive pool routing keeps persistent retry accounting and pool isolation', async () => {
  const { manager, url } = await setup((req, res) => {
    res.writeHead(req.headers.authorization === 'Bearer first' ? 503 : 200);
    res.end('{"usage":{"input_tokens":4,"output_tokens":2}}');
  }, [key('first'), key('second'), key('outside')]);
  manager.routing = { defaultPool: 'main', pools: { main: { accounts: ['first', 'second'], strategy: 'adaptive' } } };
  const response = await fetch(`${url}/responses`);
  await response.text();
  assert.equal(response.status, 200);
  const status = manager.getStatus();
  assert.equal(status.statistics?.totals.requests, 1);
  assert.equal(status.statistics?.totals.attempts, 2);
  assert.equal(status.statistics?.totals.retries, 1);
  assert.equal(status.accounts[2]?.adaptive.samples, 0);
  assert.ok(status.accounts.every(account => account.adaptive.inFlight === 0));
});

function getAccount(manager: AccountManager, index: number) {
  const account = manager.accounts[index];
  assert.ok(account);
  return account;
}

function getStats(manager: AccountManager) {
  assert.ok(manager.stats);
  return manager.stats;
}
