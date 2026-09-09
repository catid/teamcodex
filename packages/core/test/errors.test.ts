import assert from 'node:assert/strict';

import { test } from 'bun:test';

import { createError, ERROR_CODES, errorResponse } from '../src/errors.ts';

test('application errors have stable identifiers and preserve causes', () => {
  const cause = new Error('disk busy');
  const error = createError('CONFIG_LOCKED', { lock: '/tmp/config.lock' }, { cause });
  assert.equal(error.code, 'CONFIG_LOCKED');
  assert.equal(error.opcode, 1011);
  assert.equal(error.cause, cause);
  assert.match(error.message, /Config is locked at \/tmp\/config.lock/);
  assert.equal(new Set(Object.values(ERROR_CODES).map(e => e.opcode)).size, Object.keys(ERROR_CODES).length);
});

test('HTTP errors expose registered identifiers without serializing causes', () => {
  assert.deepEqual(errorResponse('INVALID_PROXY_KEY'), {
    error: { code: 'INVALID_PROXY_KEY', opcode: 3001, type: 'authentication_error', message: 'Invalid proxy API key' },
  });
});

test('missing message parameters fail instead of producing broken diagnostics', () => {
  assert.throws(() => createError('CONFIG_LOCKED'), /Missing error parameter: lock/);
});
