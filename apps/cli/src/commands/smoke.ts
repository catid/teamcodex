import { once } from 'node:events';
import type { Server } from 'node:http';

import { isRecord } from '@teamcodex/core/config';
import { createError } from '@teamcodex/core/errors';
import { AccountManager } from '@teamcodex/proxy/account-manager';
import { resolveAccounts } from '@teamcodex/proxy/accounts';
import { loadConfig } from '@teamcodex/proxy/config';
import { createProxyServer } from '@teamcodex/proxy/server';
import { createHttpClient } from '@teamcodex/shared/api-client';

export async function smokeCommand(args: string[] = []): Promise<void> {
  const config = await loadConfig();
  if (!config) throw createError('SMOKE_CONFIG_MISSING');
  const modelIndex = args.indexOf('--model');
  const model = modelIndex >= 0 ? args[modelIndex + 1] : 'gpt-6-astra';
  const started = Date.now();
  let base = process.env.TEAMCODEX_SERVER_URL || `http://127.0.0.1:${process.env.TEAMCODEX_PORT || config.proxy.port}`;
  let server: Server | undefined;
  const originalFetch = globalThis.fetch;
  const routes: string[] = [];
  let injected = 0;
  try {
    if (args.includes('--rotate')) {
      const accounts = await resolveAccounts(config);
      if (accounts.length < 2) throw createError('SMOKE_ACCOUNTS_MISSING');
      const manager = new AccountManager(accounts, config.switchThreshold);
      manager.currentIndex = 1;
      // This isolated diagnostic uses existing access tokens only. The running
      // service remains responsible for token refresh and reset redemption.
      manager.ensureTokenFresh = async () => {};
      globalThis.fetch = Object.assign(async (url: string | URL | Request, options?: RequestInit) => {
        if (String(url).startsWith(config.upstream || 'https://chatgpt.com') && !injected) {
          injected++;
          return new globalThis.Response('', { status: 429, headers: { 'retry-after': '60' } });
        }
        return originalFetch(url, options);
      }, { preconnect: originalFetch.preconnect });
      server = createProxyServer(manager, config, { onRequestRouted: (_id, info) => routes.push(info.account) });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw createError('SMOKE_CONFIG_MISSING');
      base = `http://127.0.0.1:${address.port}`;
    }
    const response = await createHttpClient(originalFetch).request({ url: `${base}/backend-api/codex/responses`, options: {
      method: 'POST',
      signal: AbortSignal.timeout(90_000),
      headers: { authorization: `Bearer ${config.proxy.apiKey}`, 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({
        model, instructions: 'Reply with exactly hello. Do not use tools.',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
        stream: true, store: false, reasoning: { effort: 'low' },
      }),
    } });
    if (!response.ok) { await response.body?.cancel(); throw createError('SMOKE_HTTP_ERROR', { status: response.status }); }
    const body = await response.text();
    let output = '', completed = false;
    for (const line of body.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const value = line.slice(5).trim();
      if (value === '[DONE]') continue;
      let event: unknown;
      try { event = JSON.parse(value); } catch { continue; }
      if (!isRecord(event)) continue;
      if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') output += event.delta;
      if (event.type === 'response.completed' && isRecord(event.response) && event.response.status === 'completed') completed = true;
    }
    if (!completed || output.trim().toLowerCase() !== 'hello') throw createError('SMOKE_RESPONSE_INVALID');
    if (args.includes('--rotate') && (injected !== 1 || new Set(routes).size < 2)) throw createError('SMOKE_ROTATION_FAILED');
    console.log(JSON.stringify({ ok: true, output: output.trim(), elapsedSeconds: (Date.now() - started) / 1000,
      ...(server ? { diagnostic: 'isolated injected 429 followed by live provider response', routes } : { service: base }) }));
  } finally {
    globalThis.fetch = originalFetch;
    if (server) { server.close(); server.closeAllConnections(); }
  }
}
