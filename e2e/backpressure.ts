import assert from 'node:assert/strict';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

import { isRecord } from '@teamcodex/core/config';

import { array, object } from './fixtures.ts';

const base = 'http://teamcodex:1456';
const headers = { authorization: 'Bearer mock-proxy-key', 'content-type': 'application/json' };
const request = (input: string, pool = 'main', signal = AbortSignal.timeout(10_000)) => fetch(`${base}/v1/responses`, {
  method: 'POST', headers: { ...headers, 'x-teamcodex-pool': pool }, body: JSON.stringify({ input }), signal,
});
const controller = new AbortController();
const held = request('hold', 'main', controller.signal).catch(error => error);
try {
  let arrived = false;
  for (let i = 0; i < 100; i++) {
    const calls = array(await (await fetch('http://mock:8080/requests')).json());
    if (calls.some((call: unknown) => isRecord(call) && isRecord(call.body) && call.body.input === 'hold')) { arrived = true; break; }
    await delay(20);
  }
  assert.ok(arrived, 'held request reached upstream');
  const rejected = await request('must-not-forward');
  assert.equal(rejected.status, 503);
  assert.equal(rejected.headers.get('retry-after'), '1');
  assert.equal(object(object(await rejected.json()).error).code, 'PROXY_OVERLOADED');
  const other = await request('other-pool', 'other');
  assert.equal(other.status, 200);
  await other.text();
} finally {
  controller.abort();
  await held;
  await fetch('http://mock:8080/release');
}
for (let i = 0; i < 100; i++) {
  const recovered = await request('recovered');
  await recovered.text();
  if (recovered.status === 200) break;
  assert.ok(i < 99, 'cancelled request must release admission');
  await delay(20);
}
// A real paused TCP consumer must receive the complete stream when it resumes.
await new Promise<void>((resolve, reject) => {
  const req = http.request(`${base}/v1/responses`, { method: 'POST', headers }, res => {
    assert.equal(res.statusCode, 200);
    res.pause();
    setTimeout(() => res.resume(), 250);
    let bytes = 0;
    let tail = '';
    res.on('data', chunk => { bytes += chunk.length; tail = `${tail}${chunk}`.slice(-512); });
    res.on('error', reject);
    res.on('end', () => {
      try {
        assert.ok(bytes > 16 * 1024 * 1024);
        assert.match(tail, /response.completed/);
        resolve();
      } catch (error) { reject(error); }
    });
  });
  req.setTimeout(10_000, () => req.destroy(new Error('slow stream timed out')));
  req.on('error', reject);
  req.end(JSON.stringify({ input: 'large-stream', stream: true }));
});
const after = await request('after-stream');
assert.equal(after.status, 200);
await after.text();
