import { httpClient } from '@teamcodex/shared/api-client';

import { loadConfig } from './config.ts';

try {
  const config = await loadConfig();
  if (!config) throw new Error('No config');
  const port = process.env.TEAMCODEX_LISTEN_PORT || config.proxy.port;
  const res = await httpClient.request({ url: `http://127.0.0.1:${port}/teamcodex/status`, options: {
    headers: { 'x-api-key': config.proxy.apiKey },
    signal: AbortSignal.timeout(3000),
  } });
  if (!res.ok) process.exitCode = 1;
} catch {
  process.exitCode = 1;
}
