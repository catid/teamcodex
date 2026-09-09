import { expect, test } from 'bun:test';

import { validateConfig } from '../src/config.ts';

const base = { proxy: { port: 1456, apiKey: 'fake-proxy-key' }, accounts: [] };

test('configuration rejects malformed credential and reset metadata at the boundary', () => {
  for (const field of ['apiKey', 'accessToken', 'refreshToken', 'expiresAt', 'importFrom']) {
    expect(() => validateConfig({ ...base, accounts: [{ name: 'malformed', type: 'chatgpt', [field]: {} }] }))
      .toThrow(expect.objectContaining({ code: 'CONFIG_ACCOUNTS_INVALID' }));
  }
  for (const state of [{ lastCompletedAt: 'invalid' }, { lastResult: {} }]) {
    expect(() => validateConfig({ ...base, usageResetState: { 'chatgpt:a': state } }))
      .toThrow(expect.objectContaining({ code: 'CONFIG_RESET_STATE_INVALID' }));
  }
});

test('configuration accepts unresolved imports and nullable OAuth metadata', () => {
  expect(() => validateConfig({ ...base, accounts: [{ name: 'import', type: 'chatgpt', importFrom: '~/.codex/auth.json', refreshToken: null, expiresAt: null }] })).not.toThrow();
});
