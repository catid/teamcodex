import { spawnSync } from 'node:child_process';

import type { Config } from '@teamcodex/core/config';
import { createError, errorMessage } from '@teamcodex/core/errors';
import { loadOrCreateConfig } from '@teamcodex/proxy/config';

export async function envCommand(args: string[]): Promise<void> {
  const config = await loadOrCreateConfig();
  const overrides = codexOverrideArgs(config);
  if (args.includes('--null')) {
    process.stdout.write(`${[config.proxy.apiKey, ...overrides].join('\0')  }\0`);
    return;
  }
  const quote = (value: string) => `'${  value.replaceAll("'", "'\\''")  }'`;
  console.log(`TEAMCODEX_API_KEY=${quote(config.proxy.apiKey)} codex ${overrides.map(quote).join(' ')}`);
}

// ── run ─────────────────────────────────────────────────────

function codexOverrideArgs(config: Config): string[] {
  const port = process.env.TEAMCODEX_PORT || config.proxy.port;
  return [
    '-c', 'model_provider=teamcodex',
    '-c', 'model_providers.teamcodex.name=TeamCodex',
    '-c', `model_providers.teamcodex.base_url=http://127.0.0.1:${port}/backend-api/codex`,
    '-c', 'model_providers.teamcodex.wire_api=responses',
    '-c', 'model_providers.teamcodex.requires_openai_auth=false',
    '-c', 'model_providers.teamcodex.env_key=TEAMCODEX_API_KEY',
    '-c', 'model_providers.teamcodex.supports_websockets=false',
  ];
}

/**
 * Atomically write codex's auth.json — codex reloads this file at runtime,
 * so it must never observe a partially written one.
 */
export async function runCommand(args: string[]): Promise<void> {
  const config = await loadOrCreateConfig();

  // Everything after 'run' (skip -- separator if present)
  const codexArgs = args.slice(1);
  if (codexArgs[0] === '--') codexArgs.shift();

  // --safe: don't add the bypass flag
  let bypass = true;
  const safeIdx = codexArgs.indexOf('--safe');
  if (safeIdx >= 0) { bypass = false; codexArgs.splice(safeIdx, 1); }

  const settings = [];
  for (let i = 0; i < codexArgs.length && codexArgs[i] !== '--';) {
    if (['-c', '--config'].includes(codexArgs[i] ?? '')) {
      if (i + 1 >= codexArgs.length) throw createError('ARGUMENT_VALUE_MISSING', { argument: codexArgs[i] ?? '' });
      settings.push(...codexArgs.splice(i, 2));
    } else if (/^(--config|-c)=/.test(codexArgs[i] ?? '')) settings.push(...codexArgs.splice(i, 1));
    else i++;
  }
  settings.push(...codexOverrideArgs(config));
  if (bypass) settings.push('--dangerously-bypass-approvals-and-sandbox');
  const delimiter = codexArgs.indexOf('--');
  const fullArgs = [...codexArgs];
  fullArgs.splice(delimiter < 0 ? fullArgs.length : delimiter, 0, ...settings);

  // Authenticate to the proxy with its own key; only the proxy refreshes
  // upstream account credentials for this session.
  // Use spawnSync so the Node process blocks entirely — behaves like execvp.
  const result = spawnSync('codex', fullArgs, {
    stdio: 'inherit', env: { ...process.env, TEAMCODEX_API_KEY: config.proxy.apiKey },
  });

  if (result.error) {
    if ('code' in result.error && result.error.code === 'ENOENT') {
      console.error(errorMessage('CODEX_NOT_FOUND'));
    } else {
      console.error(errorMessage('CODEX_START_FAILED', { message: result.error.message }));
    }
    process.exit(1);
  }

  process.exit(result.status ?? 1);
}
