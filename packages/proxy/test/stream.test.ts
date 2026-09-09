import assert from 'node:assert/strict';
import http from 'node:http';

import { afterEach, test } from 'bun:test';

import { AccountManager } from '../src/account-manager.ts';
import { createDefaultConfig } from '../src/config.ts';
import { createProxyServer } from '../src/http/server.ts';

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) =>
    server.close(error => error ? reject(error) : resolve()))));
});

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

test('Bun SSE forwarding preserves split events and counts cumulative usage once', async () => {
  const upstream = await listen(http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"type":"response.created"}\r\n');
    res.write('\r\ndata: {"response":{"usage":{"input_tokens":12,"output_tokens":4}}}\n\n');
    res.write('data: {"response":{"usage":{"input_tokens":12,"output_tokens":7}}}\n\n');
    res.end('data: [DONE]\n\n');
  }));
  const config = createDefaultConfig();
  config.apiUpstream = upstream;
  config.accounts = [{ name: 'mock', type: 'apikey', apiKey: 'fake' }];
  const manager = new AccountManager(config.accounts);
  const proxy = await listen(createProxyServer(manager, config));
  const response = await fetch(`${proxy}/responses`);
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.match(text, /response.created/);
  assert.match(text, /data: \[DONE\]/);
  assert.equal(manager.accounts[0]?.usage.totalInputTokens, 12);
  assert.equal(manager.accounts[0]?.usage.totalOutputTokens, 7);
  assert.equal(manager.getStatus().accounts[0]?.adaptive.inFlight, 0);
});

test('Bun embedded throttling retries before output and keeps assistant text about 429', async () => {
  const calls: (string | undefined)[] = [];
  const upstream = await listen(http.createServer((req, res) => {
    calls.push(req.headers.authorization);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(req.headers.authorization === 'Bearer a'
      ? 'data: {"type":"error","error":{"message":"rate limit 429"}}\n\n'
      : 'data: {"type":"response.output_text.delta","delta":"Explain HTTP 429"}\n\ndata: [DONE]\n\n');
  }));
  const config = createDefaultConfig();
  config.apiUpstream = upstream;
  config.accounts = ['a', 'b'].map(name => ({ name, type: 'apikey', apiKey: name }));
  config.routing = { defaultPool: 'main', pools: { main: { accounts: ['a', 'b'], strategy: 'failover' } } };
  const manager = new AccountManager(config.accounts, 0.98, config.routing);
  const proxy = await listen(createProxyServer(manager, config));
  const response = await fetch(`${proxy}/responses`);
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.deepEqual(calls, ['Bearer a', 'Bearer b']);
  assert.match(text, /Explain HTTP 429/);
  assert.doesNotMatch(text, /rate limit 429/);
  assert.equal(manager.accounts[0]?.status, 'throttled');
});
