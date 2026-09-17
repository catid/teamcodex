import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import test from 'node:test';

import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

const accounts = () => ['first', 'second'].map(name => ({ name, type: 'apikey', apiKey: name }));

async function listen(t, server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

async function proxyFor(t, handler) {
  const upstream = await listen(t, http.createServer(handler));
  const manager = new AccountManager(accounts(), 0.98, undefined, { randomIndex: size => size - 1 });
  const url = await listen(t, createProxyServer(manager, {
    upstream,
    apiUpstream: upstream,
    proxy: {},
    retry: { maxRetries: 1, headerTimeoutSeconds: 1, idleTimeoutSeconds: 1 },
  }));
  return { manager, url };
}

for (const body of ['', ': keepalive\n\n']) {
  test(`stream ending ${body ? 'after an SSE comment' : 'without an event'} retries`, async t => {
    let attempts = 0;
    const { manager, url } = await proxyFor(t, (_req, res) => {
      attempts++;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(attempts === 1 ? body : 'data: {"type":"response.completed","response":{"id":"ok"}}\n\n');
    });
    const response = await fetch(`${url}/responses`, { signal: AbortSignal.timeout(3000) });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /"id":"ok"/);
    assert.equal(attempts, 2);
    assert.ok(manager.accounts.every(account => account.status === 'active'));
  });
}

test('JSON keepalive and top-level transient error before output retry as one attempt', async t => {
  let attempts = 0;
  const { manager, url } = await proxyFor(t, (req, res) => {
    attempts++;
    assert.equal(req.headers.authorization, attempts === 1 ? 'Bearer first' : 'Bearer second');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (attempts === 1) {
      res.end([
        'data: {"type":"response.created","response":{"id":"failed"}}\n\n',
        'data: {"type":"response.in_progress","response":{"id":"failed","status":"in_progress"}}\n\n',
        'data: {"type":"response.keepalive"}\n\n',
        'data: {"type":"error","error":{"code":"server_error","message":"temporary"}}\n\n',
        'data: {"type":"response.failed","response":{"status":"failed","error":{"code":"server_error","message":"temporary"}}}\n\n',
      ].join(''));
      return;
    }
    res.end('data: {"type":"response.completed","response":{"id":"ok"}}\n\n');
  });
  const response = await fetch(`${url}/responses`, { signal: AbortSignal.timeout(3000) });
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.match(text, /"id":"ok"/);
  assert.doesNotMatch(text, /temporary/);
  assert.equal(attempts, 2);
  assert.ok(manager.accounts.every(account => account.status === 'active'));
});

test('an exhausted top-level transient error still ends with a Responses failure event', async t => {
  const { url } = await proxyFor(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: {"type":"error","error":{"code":"server_error","message":"temporary"}}\n\n');
  });
  const response = await fetch(`${url}/responses`, { signal: AbortSignal.timeout(3000) });
  assert.equal(response.status, 200);
  const text = await response.text();
  const events = text.trim().split('\n\n').map(event => JSON.parse(event.slice(6)));
  assert.equal(events.at(-1).type, 'response.failed');
  assert.deepEqual(events.at(-1).response.error, { code: 'server_error', message: 'temporary' });
});

test('a terminal top-level error is normalized for Codex before EOF', async t => {
  const { url } = await proxyFor(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"type":"error","code":"invalid_prompt","message":"bad input"}\n\n');
  });
  const response = await fetch(`${url}/responses`, { signal: AbortSignal.timeout(3000) });
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.match(text, /"type":"response.failed"/);
  assert.match(text, /"code":"invalid_prompt"/);
  assert.match(text, /bad input/);
});

for (const chunks of [
  ['event: response.completed\r\ndata: {"type":\r\ndata: "response.completed","response":{"id":"multiline"}}\r\n\r\n'],
  ['event: response.completed\r', '\ndata: {"type":\r', '\ndata: "response.completed","response":{"id":"multiline"}}\r', '\n\r', '\n'],
  ['event: response.completed\rdata: {"type":\rdata: "response.completed","response":{"id":"multiline"}}\r\r'],
]) {
  test(`SSE multiline data uses complete lines across ${chunks.length} chunks`, async t => {
    const { url } = await proxyFor(t, async (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const chunk of chunks) {
        res.write(chunk);
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      // Completion must close downstream without waiting for upstream EOF.
    });
    const response = await fetch(`${url}/responses`, { signal: AbortSignal.timeout(3000) });
    const text = await response.text();
    const data = text.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5)).join('\n');
    assert.equal(JSON.parse(data).response.id, 'multiline');
    assert.doesNotMatch(text, /UPSTREAM_STREAM_INTERRUPTED/);
  });
}

test('SSE event metadata marks a top-level error as terminal', async t => {
  const { url } = await proxyFor(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('event: error\ndata: {"error":{"code":"invalid_prompt","message":"bad input"}}\n\n');
  });
  const response = await fetch(`${url}/responses`, { signal: AbortSignal.timeout(3000) });
  const text = await response.text();
  assert.match(text, /"type":"response.failed"/);
  assert.match(text, /"code":"invalid_prompt"/);
});

test('SSE CR-only event delimiters are parsed as completed responses', async t => {
  const { url } = await proxyFor(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: {"type":"response.completed","response":{"id":"cr-only"}}\r\r');
  });
  const response = await fetch(`${url}/responses`, { signal: AbortSignal.timeout(3000) });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /cr-only/);
});

test('SSE mixed CRLF and LF delimiters are parsed as completed responses', async t => {
  const { url } = await proxyFor(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: {"type":"response.completed","response":{"id":"mixed"}}\r\n\n');
  });
  const response = await fetch(`${url}/responses`, { signal: AbortSignal.timeout(3000) });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /mixed/);
});

test('SSE LF followed by CRLF delimiters are parsed as completed responses', async t => {
  const { url } = await proxyFor(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: {"type":"response.completed","response":{"id":"mixed-reverse"}}\n\r\n');
  });
  const response = await fetch(`${url}/responses`, { signal: AbortSignal.timeout(3000) });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /mixed-reverse/);
});
