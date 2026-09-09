import { createInterface } from 'node:readline';

import type { AccountConfig } from '@teamcodex/core/config';
import { isRecord } from '@teamcodex/core/config';
import { errorMessage } from '@teamcodex/core/errors';
import { preserveAccountRouting } from '@teamcodex/core/routing';
import { deviceCodeLogin } from '@teamcodex/proxy/auth/device';
import type { Credentials } from '@teamcodex/proxy/auth/tokens';
import { accountInfoFromTokens, defaultCodexAuthPath, importCredentials } from '@teamcodex/proxy/auth/tokens';
import { atomicConfigUpdate, getConfigPath, loadOrCreateConfig } from '@teamcodex/proxy/config';

import { notifyServerReload, upsertChatGPTAccount } from '../accounts.ts';
import { argValue } from '../arguments.ts';
import { loginOAuth } from '../oauth.ts';
import { devicePrompt } from '../tui/login.ts';
import { ESC } from '../tui/style.ts';

export async function importCommand(args: string[]): Promise<void> {
  await loadOrCreateConfig();

  const name = argValue(args, '--name');
  const jsonStr = argValue(args, '--json');

  let creds: Credentials;
  if (jsonStr) {
    // Accept raw JSON: --json '{"tokens":{"access_token":"...","refresh_token":"...","account_id":"..."}}'
    // or flat: --json '{"access_token":"...","refresh_token":"..."}'
    try {
      const raw: unknown = JSON.parse(jsonStr);
      const data = isRecord(raw) && isRecord(raw.tokens) ? raw.tokens : isRecord(raw) ? raw : {};
      const accessToken = typeof data.access_token === 'string' ? data.access_token : typeof data.accessToken === 'string' ? data.accessToken : null;
      if (!accessToken) {
        console.error(errorMessage('IMPORT_JSON_TOKEN_MISSING'));
        process.exit(1);
      }
      creds = {
        accessToken,
        refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : typeof data.refreshToken === 'string' ? data.refreshToken : null,
        idToken: typeof data.id_token === 'string' ? data.id_token : typeof data.idToken === 'string' ? data.idToken : null,
        accountId: typeof data.account_id === 'string' ? data.account_id : typeof data.accountId === 'string' ? data.accountId : null,
        expiresAt: null,
      };
      const info = accountInfoFromTokens(creds);
      creds.accountId = info.accountId;
      creds.expiresAt = info.expiresAt;
    } catch (err) {
      console.error(errorMessage('IMPORT_JSON_INVALID', { message: (err instanceof Error ? err.message : String(err)) }));
      process.exit(1);
    }
  } else {
    const fromPath = argValue(args, '--from');
    try {
      creds = await importCredentials(fromPath ?? undefined);
    } catch (err) {
      console.error(errorMessage('IMPORT_FILE_FAILED', { path: fromPath || defaultCodexAuthPath(), message: (err instanceof Error ? err.message : String(err)) }));
      process.exit(1);
    }
  }

  await upsertChatGPTAccount(name, creds, 'import');
}

// ── login ───────────────────────────────────────────────────

export async function loginCommand(args: string[]): Promise<void> {
  if (args.includes('--api')) {
    await loginApiCommand(args);
    return;
  }
  if (args.includes('--device-auth') || args.includes('--device')) {
    await loginDeviceCommand(args);
    return;
  }
  if (args.includes('--browser')) {
    await loginOAuthCommand(args);
    return;
  }
  // On a headless box the browser flow's localhost:1455 callback is
  // unreachable — steer those users to device-auth automatically.
  const headless = process.platform === 'linux' &&
    !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
  if (headless) {
    console.log('No display detected (headless) — using device-code login.');
    console.log('(Force the browser flow with: teamcodex login --browser)');
    await loginDeviceCommand(args);
    return;
  }
  await loginOAuthCommand(args);
}

async function loginDeviceCommand(args: string[]): Promise<void> {
  await loadOrCreateConfig();
  const name = argValue(args, '--name');

  let creds: Credentials;
  try {
    creds = await deviceCodeLogin({
      onPrompt: ({ verificationUrl, userCode }) => {
        if (process.stdout.isTTY) {
          process.stdout.write(`${ESC}H${ESC}2J`);
          console.log(devicePrompt(verificationUrl, userCode, Math.max(40, Math.min(80, (process.stdout.columns || 80) - 1))).join('\n'));
        } else {
          console.log(`Sign in to ChatGPT: ${verificationUrl}\nDevice code: ${userCode}\nWaiting for authorization (expires in 15 minutes).`);
        }
      },
    });
  } catch (err) {
    console.error(errorMessage('DEVICE_LOGIN_FAILED', { message: (err instanceof Error ? err.message : String(err)) }));
    console.error('');
    console.error('Alternatives:');
    console.error('  teamcodex import         Import from existing Codex CLI credentials');
    console.error('  teamcodex login --api    Add an OpenAI API key instead');
    process.exit(1);
  }

  await upsertChatGPTAccount(name, creds, 'device');
}

async function loginApiCommand(args: string[]): Promise<void> {
  await loadOrCreateConfig();
  let name = argValue(args, '--name');

  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const apiKey = await new Promise<string>(resolve => rl.question('OpenAI API key: ', resolve));
  rl.close();

  if (!apiKey.trim()) {
    console.error(errorMessage('API_KEY_MISSING'));
    process.exit(1);
  }

  const saved = await atomicConfigUpdate(diskConfig => {
    if (!name) {
      let n = 1;
      while (diskConfig.accounts.some(a => a.name === `api-${n}`)) n++;
      name = `api-${n}`;
    }
    const entry: AccountConfig = { name, type: 'apikey', apiKey: apiKey.trim() };
    const idx = diskConfig.accounts.findIndex(a => a.name === name);
    if (idx >= 0) {
      const previous = diskConfig.accounts[idx];
      if (previous) preserveAccountRouting(diskConfig, previous, entry);
      diskConfig.accounts[idx] = entry;
    }
    else diskConfig.accounts.push(entry);
  });
  console.log(`Added API key account "${name}"`);
  console.log(`Saved to ${getConfigPath()}`);
  await notifyServerReload(saved);
}

async function loginOAuthCommand(args: string[]): Promise<void> {
  await loadOrCreateConfig();
  const name = argValue(args, '--name');

  console.log('Starting OAuth login...');
  let creds: Credentials;
  try {
    creds = await loginOAuth();
  } catch (err) {
    console.error(errorMessage('OAUTH_LOGIN_FAILED', { message: (err instanceof Error ? err.message : String(err)) }));
    console.error('');
    console.error('Alternatives:');
    console.error('  teamcodex login --device-auth   Headless / no local browser');
    console.error('  teamcodex import                Import from existing Codex CLI credentials');
    console.error('  teamcodex login --api           Add an OpenAI API key instead');
    process.exit(1);
  }

  await upsertChatGPTAccount(name, creds, 'login');
}
