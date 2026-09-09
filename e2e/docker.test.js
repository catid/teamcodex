import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod,mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = resolve('.');
/** @param {string[]} args @param {NodeJS.ProcessEnv} [env] */
async function docker(args, env = process.env) {
  const result = await exec('docker', args, { env, timeout: 180_000, maxBuffer: 4 * 1024 * 1024 });
  return result.stdout.trim();
}
/** @param {() => Promise<boolean>} predicate */
async function eventually(predicate) {
  for (let i = 0; i < 100; i++) {
    if (await predicate()) return;
    await delay(100);
  }
  assert.fail('Condition did not become true within 10 seconds');
}

test('Docker lifecycle with isolated mock providers', { timeout: 240_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'teamcodex-e2e-'));
  const configDir = join(dir, 'config with spaces');
  const authDir = join(dir, 'auth with spaces');
  await mkdir(configDir);
  await mkdir(authDir);
  const project = `teamcodex-e2e-${process.pid}`;
  const image = `${project}:test`;
  const env = { ...process.env, TEAMCODEX_CONFIG_DIR: configDir, TEAMCODEX_CODEX_HOME: authDir, TEAMCODEX_UID: String(process.getuid()), TEAMCODEX_GID: String(process.getgid()) };
  const file = join(dir, 'compose.json');
  const compose = (...args) => docker(['compose', '-p', project, '-f', file, ...args], env);
  t.after(async () => {
    try { await compose('down', '--volumes', '--remove-orphans'); }
    finally {
      await docker(['image', 'rm', image]).catch(() => {});
      await rm(dir, { recursive: true, force: true });
    }
  });
  await docker(['build', '-t', image, '.']);
  const config = JSON.parse(await docker(['compose', '-f', 'compose.yaml', 'config', '--format', 'json'], env));
  const service = config.services.teamcodex;
  service.image = image;
  delete service.build;
  service.ports = [{ target: 1456, published: '0', host_ip: '127.0.0.1' }];
  service.environment.NODE_OPTIONS = '--import=/fixtures/redirect-auth.js';
  service.volumes.push({ type: 'bind', source: join(root, 'e2e'), target: '/fixtures', read_only: true });
  service.healthcheck.interval = '1s';
  config.services.mock = { image, entrypoint: ['node', '/fixtures/mock-provider.js'], user: service.user, read_only: true, cap_drop: ['ALL'], security_opt: ['no-new-privileges:true'], volumes: [{ type: 'bind', source: join(root, 'e2e'), target: '/fixtures', read_only: true }], ports: [{ target: 8080, published: '0', host_ip: '127.0.0.1' }], networks: ['default'] };
  config.networks = { default: { internal: true } };
  await writeFile(file, JSON.stringify(config));
  const configPath = join(configDir, 'config.json');
  const initial = { routing: { defaultPool: 'main', pools: { main: { accounts: ['first', 'second'], strategy: 'failover' } } }, proxy: { host: '127.0.0.1', port: 1456, apiKey: 'mock-proxy-key' }, upstream: 'http://mock:8080', apiUpstream: 'http://mock:8080', autoReset: { enabled: false }, accounts: [{ name: 'first', type: 'apikey', apiKey: 'first-key' }, { name: 'second', type: 'apikey', apiKey: 'second-key' }] };
  const cli = (...args) => compose('run', '--rm', '--no-deps', '-T', '-e', 'TEAMCODEX_SERVER_URL=http://teamcodex:1456', 'teamcodex', ...args);
  await t.test('initialization and invalid configuration rejection', async () => {
    await cli('init');
    const created = JSON.parse(await readFile(configPath, 'utf8'));
    assert.match(created.proxy.apiKey, /^tcx-/);
    assert.equal((await stat(configPath)).mode & 0o777, 0o600);
    await writeFile(configPath, JSON.stringify({ ...initial, proxy: { ...initial.proxy, port: 0 } }));
    await assert.rejects(cli('serve'), error => {
      assert.match(error.stderr, /CONFIG_PORT_INVALID/);
      return true;
    });
  });
  await t.test('permission failures preserve config and recover after repair', async () => {
    await writeFile(configPath, JSON.stringify(initial));
    const before = await readFile(configPath, 'utf8');
    await chmod(configPath, 0o000);
    try {
      await assert.rejects(cli('accounts'), error => {
        assert.match(error.stderr, /EACCES/);
        return true;
      });
    } finally { await chmod(configPath, 0o600); }
    await chmod(configDir, 0o500);
    try {
      await assert.rejects(cli('reset'), error => {
        assert.match(error.stderr, /EACCES/);
        return true;
      });
    } finally { await chmod(configDir, 0o700); }
    assert.equal(await readFile(configPath, 'utf8'), before);
    assert.ok(!(await readdir(configDir)).some(name => name.endsWith('.lock') || name.endsWith('.tmp')));
    assert.match(await cli('accounts'), /first/);
  });
  await writeFile(configPath, JSON.stringify(initial), { mode: 0o600 });
  await compose('up', '-d', '--wait', '--wait-timeout', '30');
  const base = 'http://teamcodex:1456';
  const mock = 'http://mock:8080';
  /** @param {string} url @param {RequestInit} [options] */
  const fetch = async (url, options = {}) => {
    const script = `const r=await fetch(${JSON.stringify(url)},{...${JSON.stringify(options)},signal:AbortSignal.timeout(10000)});console.log(JSON.stringify({status:r.status,headers:[...r.headers],body:await r.text()}))`;
    const data = JSON.parse(await compose('exec', '-T', 'mock', 'node', '--input-type=module', '-e', script));
    return new Response(data.body, { status: data.status, headers: data.headers });
  };
  const headers = { authorization: 'Bearer mock-proxy-key', 'content-type': 'application/json' };
  const status = async () => (await fetch(`${base}/teamcodex/status`, { headers })).json();
  const captured = async () => (await fetch(`${mock}/requests`)).json();
  const mode = value => fetch(`${mock}/control`, { method: 'POST', headers, body: JSON.stringify({ mode: value }) });
  const request = body => fetch(`${base}/backend-api/codex/responses?e2e=1`, { method: 'POST', headers: { ...headers, 'chatgpt-account-id': 'must-not-leak' }, body: JSON.stringify(body) });
  const restore = async () => {
    await compose('stop', 'teamcodex');
    await writeFile(configPath, JSON.stringify(initial));
    await compose('up', '-d', '--wait', 'teamcodex');
  };
  await t.test('image, health, permissions, authentication and CLI status', async () => {
    const id = await compose('ps', '-q', 'teamcodex');
    const [container] = JSON.parse(await docker(['inspect', id]));
    assert.equal(container.State.Health.Status, 'healthy');
    assert.equal(container.HostConfig.ReadonlyRootfs, true);
    assert.deepEqual(container.HostConfig.CapDrop, ['ALL']);
    assert.ok(container.HostConfig.SecurityOpt.includes('no-new-privileges:true'));
    assert.notEqual(container.Config.User.split(':')[0], '0');
    const checks = JSON.parse(await compose('exec', '-T', 'teamcodex', 'node', '--input-type=module', '-e', `import fs from 'node:fs';let denied=false;try{fs.writeFileSync('/app/forbidden','x')}catch(e){denied=['EROFS','EACCES'].includes(e.code)}fs.writeFileSync('/tmp/probe','ok');console.log(JSON.stringify({denied,uid:process.getuid()}))`));
    assert.equal(checks.denied, true);
    assert.equal(checks.uid, process.getuid());
    assert.equal((await stat(configPath)).mode & 0o777, 0o600);
    const unauthorized = await fetch(`${base}/teamcodex/status`);
    assert.equal(unauthorized.status, 401);
    assert.equal((await unauthorized.json()).error.code, 'INVALID_PROXY_KEY');
    assert.match(await cli('status'), /first/);
    assert.match(await cli('accounts'), /second/);
  });
  await t.test('runtime isolation, wrong identity and mount permissions', async () => {
    const probe = JSON.parse(await compose('exec', '-T', 'teamcodex', 'node', '--input-type=module', '-e', `
      import fs from 'node:fs';
      const status=fs.readFileSync('/proc/self/status','utf8');
      for(const directory of ['/config','/codex']) {
        fs.writeFileSync(directory+'/permission-probe','ok',{mode:0o600});
        fs.renameSync(directory+'/permission-probe',directory+'/renamed-probe');
        fs.unlinkSync(directory+'/renamed-probe');
      }
      console.log(JSON.stringify({status,gid:process.getgid(),config:fs.statSync('/config/config.json').uid}));
    `));
    assert.match(probe.status, /NoNewPrivs:\s+1/);
    assert.match(probe.status, /CapEff:\s+0+\n/);
    assert.equal(probe.gid, process.getgid());
    assert.equal(probe.config, process.getuid());
    await assert.rejects(compose('exec', '-T', '--user', '65534:65534', 'teamcodex', 'node', 'src/index.js', 'accounts'), error => {
      assert.match(error.stderr, /EACCES/);
      return true;
    });
    const wrongKey = await fetch(`${base}/teamcodex/status`, { headers: { authorization: 'Bearer wrong' } });
    assert.equal(wrongKey.status, 401);
    const id = await compose('ps', '-q', 'teamcodex');
    const [container] = JSON.parse(await docker(['inspect', id]));
    assert.equal(container.HostConfig.Init, true);
    assert.equal(container.HostConfig.RestartPolicy.Name, 'unless-stopped');
    assert.equal(container.HostConfig.PortBindings['1456/tcp'][0].HostIp, '127.0.0.1');
    assert.ok(container.HostConfig.Tmpfs['/tmp'] !== undefined);
  });
  await t.test('healthcheck detects broken config and shutdown releases the listener', async () => {
    const before = await readFile(configPath, 'utf8');
    try {
      await writeFile(configPath, '{broken');
      await assert.rejects(compose('exec', '-T', 'teamcodex', 'node', 'src/healthcheck.js'));
    } finally { await writeFile(configPath, before); }
    await compose('exec', '-T', 'teamcodex', 'node', 'src/healthcheck.js');
    const id = await compose('ps', '-q', 'teamcodex');
    await compose('stop', '--timeout', '10', 'teamcodex');
    const [stopped] = JSON.parse(await docker(['inspect', id]));
    assert.equal(stopped.State.Running, false);
    assert.equal(stopped.State.OOMKilled, false);
    assert.notEqual(stopped.State.ExitCode, 137);
    assert.equal(await readFile(configPath, 'utf8'), before);
    await compose('up', '-d', '--wait', 'teamcodex');
    assert.equal((await status()).accounts.length, 2);
  });
  await t.test('JSON and SSE requests preserve payloads and account usage', async () => {
    const body = { model: 'mock-model', input: 'hello', stream: false };
    assert.equal((await (await request(body)).json()).output, 'hello');
    const [upstream] = await captured();
    assert.equal(upstream.path, '/v1/responses?e2e=1');
    assert.equal(upstream.method, 'POST');
    assert.equal(upstream.headers.authorization, 'Bearer first-key');
    assert.equal(upstream.headers['chatgpt-account-id'], undefined);
    assert.deepEqual(upstream.body, body);
    const stream = await request({ ...body, stream: true });
    assert.match(await stream.text(), /response.completed/);
    const account = (await status()).accounts[0];
    assert.equal(account.usage.totalInputTokens, 14);
    assert.equal(account.usage.totalOutputTokens, 6);
    assert.equal(account.quota.tokensRemaining, 900);
    assert.match(await cli('api', '/v1/responses', '--account', 'first', '--method', 'POST', '--data', JSON.stringify(body)), /hello/);
    assert.match(await cli('smoke', '--model', 'mock-model'), /hello/i);
  });
  await t.test('weighted pools distribute requests and strip routing headers', async () => {
    await compose('stop', 'teamcodex');
    await writeFile(configPath, JSON.stringify({
      ...initial,
      accounts: initial.accounts.map((account, index) => ({ ...account, weight: index === 0 ? 3 : 1 })),
      routing: { defaultPool: 'main', pools: { main: { accounts: ['first', 'second'], strategy: 'weighted-round-robin' } } },
    }));
    await compose('up', '-d', '--wait', 'teamcodex');
    await mode('success');
    for (let i = 0; i < 8; i++) {
      const response = await fetch(`${base}/v1/responses`, {
        method: 'POST', headers: { ...headers, 'x-teamcodex-pool': 'main' }, body: JSON.stringify({ input: 'weighted' }),
      });
      assert.equal(response.status, 200);
    }
    const calls = (await captured()).filter(call => call.body?.input === 'weighted');
    assert.equal(calls.length, 8);
    assert.equal(calls.filter(call => call.headers.authorization === 'Bearer first-key').length, 6);
    assert.equal(calls.filter(call => call.headers.authorization === 'Bearer second-key').length, 2);
    assert.ok(calls.every(call => call.headers['x-teamcodex-pool'] === undefined));
    const unknown = await fetch(`${base}/v1/responses`, {
      method: 'POST', headers: { ...headers, 'x-teamcodex-pool': 'unknown' }, body: '{}',
    });
    assert.equal(unknown.status, 400);
  });
  await t.test('pool saturation, cancellation and slow SSE clients recover capacity', async () => {
    await compose('stop', 'teamcodex');
    await writeFile(configPath, JSON.stringify({
      ...initial, maxConcurrentRequests: 2,
      routing: { defaultPool: 'main', pools: {
        main: { accounts: ['first'], maxConcurrentRequests: 1 },
        other: { accounts: ['second'], maxConcurrentRequests: 1 },
      } },
    }));
    await compose('up', '-d', '--wait', 'teamcodex');
    await mode('success');
    await compose('exec', '-T', 'mock', 'node', '/fixtures/backpressure.js');
    const calls = await captured();
    assert.equal(calls.filter(call => call.body?.input === 'must-not-forward').length, 0);
  });
  for (const scenario of ['rotate', 'reject', 'all429']) {
    await t.test(`${scenario}: retries, rotation and error contract`, async () => {
      await restore();
      await mode(scenario);
      const response = await request({ input: 'retry me' });
      assert.equal(response.status, scenario === 'all429' ? 429 : 200);
      const result = await response.json();
      if (scenario === 'all429') {
        assert.equal(result.error.code, 'ACCOUNTS_EXHAUSTED');
        assert.ok(Number(response.headers.get('retry-after')) > 0);
      }
      const calls = (await captured()).filter(x => x.path.startsWith('/v1/responses'));
      assert.deepEqual(calls.slice(0, 2).map(x => x.headers.authorization), ['Bearer first-key', 'Bearer second-key']);
      assert.deepEqual(calls[0].body, calls[1].body);
    });
  }
  await t.test('import, OAuth refresh, reset credits, persistence and removal', async () => {
    await restore();
    await mode('success');
    const token = `e30.${Buffer.from(JSON.stringify({ exp: 1, 'https://api.openai.com/auth': { chatgpt_account_id: 'mock-account' } })).toString('base64url')}.fake`;
    await writeFile(join(authDir, 'auth.json'), JSON.stringify({ tokens: { access_token: token, refresh_token: 'old-refresh', account_id: 'mock-account' } }), { mode: 0o600 });
    assert.match(await cli('import', '--name', 'chat'), /Added account/);
    assert.equal((await status()).accounts.length, 3);
    await cli('remove', 'first');
    await cli('remove', 'second');
    await compose('stop', 'teamcodex');
    const disk = JSON.parse(await readFile(configPath, 'utf8'));
    disk.routing.pools.main.accounts = ['chat'];
    disk.autoReset = { enabled: true, threshold: 0.98, pollIntervalSeconds: 30 };
    await writeFile(configPath, JSON.stringify(disk));
    await compose('up', '-d', '--wait', 'teamcodex');
    await eventually(async () => (await status()).accounts[0]?.usageReset?.lastResult === 'completed');
    const calls = await captured();
    const refresh = calls.find(x => x.path === '/oauth/token');
    assert.deepEqual(refresh.body, { client_id: 'app_EMoamEEZ73f0CkXaXp7hrann', grant_type: 'refresh_token', refresh_token: 'old-refresh' });
    const redemption = calls.find(x => x.path.endsWith('/consume'));
    assert.match(redemption.body.redeem_request_id, /^[a-f0-9-]{36}$/);
    assert.equal(redemption.headers['chatgpt-account-id'], 'mock-account');
    const saved = JSON.parse(await readFile(configPath, 'utf8'));
    assert.equal(saved.accounts[0].refreshToken, 'refreshed-token');
    assert.equal(JSON.parse(await readFile(join(authDir, 'auth.json'), 'utf8')).tokens.refresh_token, 'refreshed-token');
    assert.equal((await stat(configPath)).mode & 0o777, 0o600);
    assert.equal((await stat(join(authDir, 'auth.json'))).mode & 0o777, 0o600);
    assert.equal((await request({ input: 'chat', stream: true })).status, 200);
    const chatRequest = (await captured()).find(x => x.path === '/backend-api/codex/responses?e2e=1');
    assert.equal(chatRequest.headers['chatgpt-account-id'], 'mock-account');
    assert.equal(chatRequest.headers.authorization, `Bearer ${saved.accounts[0].accessToken}`);
    await compose('restart', 'teamcodex');
    await eventually(async () => { try { return (await status()).accounts.length === 1; } catch { return false; } });
    assert.equal((await captured()).filter(x => x.path.endsWith('/consume')).length, 1);
    await compose('stop', 'teamcodex');
    await cli('reset');
    const reset = JSON.parse(await readFile(configPath, 'utf8'));
    assert.equal(reset.accounts.length, 1);
    assert.notEqual(reset.proxy.apiKey, 'mock-proxy-key');
    assert.deepEqual(reset.usageResetState, saved.usageResetState);
    const backup = (await readdir(configDir)).find(x => x.includes('.backup-'));
    assert.ok(backup);
    assert.equal((await stat(join(configDir, backup))).mode & 0o777, 0o600);
  });
});
