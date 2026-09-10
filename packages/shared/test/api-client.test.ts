import assert from 'node:assert/strict';

import { test } from 'bun:test';

import { ApiClient, httpClient } from '../src/api-client.ts';

test('generic client encodes context and validates provider responses', async () => {
  const calls: Request[] = [];
  const client = new ApiClient<{ prompt: string }, number, { token: string }, Error>({
    encode: (input, context) => ({ url: 'https://provider.invalid/generate', options: { method: 'POST', headers: { authorization: `Bearer ${context.token}` }, body: JSON.stringify(input) } }),
    decode: async response => {
      const value: unknown = await response.json();
      if (typeof value !== 'number') throw new Error('Invalid provider response');
      return value;
    },
    mapError: error => error instanceof Error ? error : new Error(String(error)),
  }, async (url, options) => { calls.push(new Request(url, options)); return Response.json(42); });
  assert.equal(await client.request({ prompt: 'hello' }, { token: 'fake' }), 42);
  assert.equal(calls[0]?.headers.get('authorization'), 'Bearer fake');
  assert.deepEqual(await calls[0]?.json(), { prompt: 'hello' });
});

test('generic client maps decoding and transport failures through its error contract', async () => {
  const failure = new TypeError('invalid');
  for (const transportFails of [false, true]) {
    const client = new ApiClient<void, number, string, TypeError>({
      encode: () => ({ url: 'https://provider.invalid' }),
      decode: () => { throw new Error('bad body'); },
      mapError: (_error, context) => { assert.equal(context, 'account'); return failure; },
    }, async () => { if (transportFails) throw new Error('offline'); return new Response('bad'); });
    await assert.rejects(client.request(undefined, 'account'), error => error === failure);
  }
});

test('raw client retains streaming response identity, status, redirects and cancellation', async () => {
  const controller = new AbortController();
  const response = new Response(new ReadableStream({ start(stream) { stream.enqueue(new TextEncoder().encode('data: hello\n\n')); stream.close(); } }), { status: 429 });
  const original = globalThis.fetch;
  globalThis.fetch = Object.assign(async (_input: Parameters<typeof fetch>[0], options?: RequestInit) => {
    assert.equal(options?.signal, controller.signal);
    assert.equal(options?.redirect, 'manual');
    return response;
  }, { preconnect: original.preconnect });
  try {
    const actual = await httpClient.request({ url: 'https://provider.invalid', options: { signal: controller.signal, redirect: 'manual' } });
    assert.equal(actual, response);
    assert.equal(actual.bodyUsed, false);
    assert.equal(await actual.text(), 'data: hello\n\n');
  } finally { globalThis.fetch = original; }
});
