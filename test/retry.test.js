import assert from 'node:assert/strict';
import test from 'node:test';

import { overloadRetryDelaySeconds, retryPolicy } from '../src/retry.js';

test('model-at-capacity backoff doubles to a cap and honours Retry-After', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map(attempt => overloadRetryDelaySeconds(attempt, 1)), [1, 2, 4, 8, 16, 30, 30]);
  assert.equal(overloadRetryDelaySeconds(3, 1, 7), 7);
  assert.equal(overloadRetryDelaySeconds(1, 1, 600), 60);
  assert.equal(overloadRetryDelaySeconds(1, 2, 0), 2);
  assert.equal(overloadRetryDelaySeconds(1, 0.01), 0.01);
});

test('retry policy retries model-at-capacity responses without a time limit by default', () => {
  const policy = retryPolicy({});
  assert.equal(policy.overloadBackoffSeconds, 1);
  assert.equal(policy.overloadRetrySeconds, 0);
  assert.equal(retryPolicy({ retry: { overloadRetrySeconds: 600 } }).overloadRetrySeconds, 600);
});
