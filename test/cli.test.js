import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createDefaultConfig } from '../src/config.js';

const exec = promisify(execFile);
const root = resolve('.');

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'teamcodex-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin');
  await mkdir(bin);
  const config = createDefaultConfig();
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify(config));
  const env = { ...process.env, TEAMCODEX_CONFIG: configPath, CODEX_HOME: dir, PATH: `${bin}:${process.env.PATH}` };
  await writeFile(join(bin, 'codex'), `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'app-server') {
  import('node:readline').then(({createInterface}) => createInterface({input:process.stdin}).on('line', line => {
    const request = JSON.parse(line);
    if (!request.id) return;
    if (request.method === 'thread/list' && request.params.modelProviders.length !== 0) process.exit(2);
    console.log(JSON.stringify({id:request.id,result:request.method === 'thread/list' ? {
      data:[{id:'saved-openai-session',modelProvider:'openai',cwd:process.cwd(),preview:'old conversation'}],nextCursor:null
    } : {}}));
  }));
} else console.log(JSON.stringify({args,key:process.env.TEAMCODEX_API_KEY,cwd:process.cwd(),home:process.env.CODEX_HOME}));
`, { mode: 0o755 });
  return { dir, bin, config, env };
}

test('native run passes literal arguments and the proxy key without changing Codex auth', async t => {
  const f = await fixture(t);
  const auth = '{"tokens":{"access_token":"unchanged"}}';
  await writeFile(join(f.dir, 'auth.json'), auth);
  const { stdout } = await exec(process.execPath, [join(root, 'src/index.js'), 'run', '--safe', 'exec', '-c', 'model_reasoning_effort=low', 'spaces $() `literal`'], { env: f.env, cwd: f.dir });
  const launch = JSON.parse(stdout);
  assert.equal(launch.key, f.config.proxy.apiKey);
  if (launch.args.includes('exec')) assert.ok(launch.args.indexOf('model_provider=teamcodex') > launch.args.indexOf('exec'));
  assert.ok(launch.args.includes('spaces $() `literal`'));
  assert.ok(launch.args.includes('model_providers.teamcodex.requires_openai_auth=false'));
  assert.ok(!launch.args.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.equal(await readFile(join(f.dir, 'auth.json'), 'utf8'), auth);
});

test('env output is safely quoted for Bash and keeps the API key out of Codex arguments', async t => {
  const f = await fixture(t);
  f.config.proxy.apiKey = "tcx-quote' $(touch DO_NOT_CREATE) `literal`";
  await writeFile(f.env.TEAMCODEX_CONFIG, JSON.stringify(f.config));
  const { stdout } = await exec(process.execPath, [join(root, 'src/index.js'), 'env'], { env: f.env });
  const executed = await exec('/bin/bash', ['-c', stdout], { env: f.env, cwd: f.dir });
  const launch = JSON.parse(executed.stdout);
  assert.equal(launch.key, f.config.proxy.apiKey);
  if (launch.args.includes('exec')) assert.ok(launch.args.indexOf('model_provider=teamcodex') > launch.args.indexOf('exec'));
  assert.ok(!launch.args.includes(f.config.proxy.apiKey));
});

test('Docker launcher works through a symlink with spaces and preserves host cwd', async t => {
  const f = await fixture(t);
  // Mock only the Docker transport; the actual CLI emits the launch protocol.
  await writeFile(join(f.bin, 'docker'), `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('run') && !args.includes('--interactive=false')) readFileSync(0);
if (args.includes('env') && args.includes('--null')) {
  const result = spawnSync(process.execPath, [${JSON.stringify(join(root, 'src/index.js'))}, 'env', '--null'], {stdio:'inherit'});
  process.exit(result.status);
}
`, { mode: 0o755 });
  // Extensionless scripts use CommonJS unless their containing package opts in.
  await writeFile(join(f.bin, 'package.json'), '{"type":"module"}');
  const { symlink } = await import('node:fs/promises');
  const link = join(f.bin, 'team codex');
  await symlink(join(root, 'teamcodex.sh'), link);
  const env = { ...f.env, TEAMCODEX_CONFIG_DIR: join(f.dir, 'config with spaces'), TEAMCODEX_CODEX_HOME: f.dir };
  const { stdout } = await exec('/bin/bash', [link, 'run', '--safe', 'exec', '-c', 'model_reasoning_effort=low', 'literal $() `prompt`'], { env, cwd: f.dir });
  const launch = JSON.parse(stdout);
  assert.equal(await realpath(launch.cwd), await realpath(f.dir));
  assert.equal(launch.key, f.config.proxy.apiKey);
  if (launch.args.includes('exec')) assert.ok(launch.args.indexOf('model_provider=teamcodex') > launch.args.indexOf('exec'));
  assert.ok(launch.args.includes('literal $() `prompt`'));
  assert.ok(!launch.args.includes('--dangerously-bypass-approvals-and-sandbox'));
  const empty = await exec('/bin/bash', [link, 'run', '--safe'], { env, cwd: f.dir });
  assert.ok(JSON.parse(empty.stdout).args.length > 0);
  const delimited = await exec('/bin/bash', [link, 'run', '--safe', '-c', 'model_reasoning_effort=low', 'exec', '--', '-literal prompt'], { env, cwd: f.dir });
  const ordered = JSON.parse(delimited.stdout).args;
  assert.ok(ordered.indexOf('model_reasoning_effort=low') > ordered.indexOf('exec'));
  assert.ok(ordered.indexOf('model_provider=teamcodex') < ordered.indexOf('--'));
  assert.equal(ordered.at(-1), '-literal prompt');
  const historyDir = join(f.dir, 'selected history');
  const customHome = await exec('/bin/bash', [link, 'run', '--safe'], {
    env: { ...env, TEAMCODEX_CODEX_HOME: historyDir }, cwd: f.dir,
  });
  assert.equal(await realpath(JSON.parse(customHome.stdout).home), await realpath(historyDir));
  for (const command of ['resume', 'fork']) {
    const result = await exec('/bin/bash', [link, command, '--safe', '--last'], { env, cwd: f.dir });
    const forwarded = JSON.parse(result.stdout).args;
    assert.equal(forwarded[0], command);
    assert.ok(forwarded.includes('saved-openai-session'));
    assert.ok(!forwarded.includes('--last'));
    assert.ok(forwarded.includes('model_provider=teamcodex'));
    assert.ok(!forwarded.includes('--dangerously-bypass-approvals-and-sandbox'));
  }
  // Commands run from an SSH-fed script must leave subsequent stdin intact.
  const shellScript = JSON.stringify(link) + ' status\nprintf "after-status\\n"\n';
  const { spawn } = await import('node:child_process');
  const child = spawn('/bin/bash', [], { env, cwd: f.dir });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stdin.end(shellScript);
  const { once } = await import('node:events');
  const [code] = await once(child, 'close');
  assert.equal(code, 0);
  assert.match(output, /after-status/);
});

async function staleGroupFixture(t, { membership = 'stale', unavailable = false } = {}) {
  const f = await fixture(t);
  await writeFile(join(f.bin, 'package.json'), '{"type":"module"}');
  const scripts = {
    uname: 'console.log("Linux");',
    id: `const args = process.argv.slice(2);
if (args[0] === '-un') console.log('tester');
else if (args[0] === '-nG') console.log(${JSON.stringify(membership)} === 'current' || (args.length > 1 && ${JSON.stringify(membership)} !== 'absent') ? 'tester docker' : 'tester');
else if (args[0] === '-g' && args.length === 1 && process.env.TEST_DOCKER_GROUP_ACTIVE) console.log('111');
else console.log('1000');`,
    docker: `import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
if (process.env.TEAMCODEX_GID !== '1000') { console.error('container group changed'); process.exit(2); }
if (args[0] === 'info' && (${unavailable} || !process.env.TEST_DOCKER_GROUP_ACTIVE)) {
  console.error('permission denied connecting to Docker socket'); process.exit(1);
}
if (args.includes('env') && args.includes('--null')) {
  const result = spawnSync(process.execPath, [${JSON.stringify(join(root, 'src/index.js'))}, 'env', '--null'], { stdio: 'inherit' });
  process.exit(result.status);
}`,
    sg: `import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] !== 'docker' || args[1] !== '-c') process.exit(2);
appendFileSync(${JSON.stringify(join(f.dir, 'sg.log'))}, 'attempt\\n');
const result = spawnSync('/bin/sh', ['-c', args[2]], {
  stdio: 'inherit', env: { ...process.env, TEST_DOCKER_GROUP_ACTIVE: '1' },
});
process.exit(result.status ?? 1);`,
  };
  for (const [name, script] of Object.entries(scripts)) {
    await writeFile(join(f.bin, name), `#!/usr/bin/env node\n${script}\n`, { mode: 0o755 });
  }
  Object.assign(f.env, { TEAMCODEX_CONFIG_DIR: join(f.dir, 'config with spaces'), TEAMCODEX_CODEX_HOME: f.dir });
  delete f.env.TEAMCODEX_DOCKER_GROUP_RETRY;
  return f;
}

test('old tmux Docker groups recover while preserving literal arguments, cwd, and proxy settings', async t => {
  const f = await staleGroupFixture(t);
  const prompt = "quotes ' and \"; $(touch DO_NOT_CREATE) `touch DO_NOT_CREATE`\nsecond line";
  const { stdout, stderr } = await exec('/bin/bash', [join(root, 'teamcodex.sh'), 'resume', '--safe', '--', prompt, ''], { env: f.env, cwd: f.dir });
  const launch = JSON.parse(stdout);
  assert.equal(launch.args[0], 'resume');
  assert.deepEqual(launch.args.slice(-3), ['--', prompt, '']);
  assert.ok(launch.args.includes('model_provider=teamcodex'));
  assert.ok(!launch.args.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.equal(launch.key, f.config.proxy.apiKey);
  assert.equal(await realpath(launch.cwd), await realpath(f.dir));
  assert.match(stderr, /Activating your existing Docker group membership/);
  assert.equal(await readFile(join(f.dir, 'sg.log'), 'utf8'), 'attempt\n');
  await assert.rejects(readFile(join(f.dir, 'DO_NOT_CREATE')), { code: 'ENOENT' });
});

test('unavailable Docker retries stale membership only once and reports the original error', async t => {
  const f = await staleGroupFixture(t, { unavailable: true });
  await assert.rejects(exec('/bin/bash', [join(root, 'teamcodex.sh'), 'ps'], { env: f.env }), err => {
    assert.equal(err.code, 1);
    assert.match(err.stderr, /permission denied connecting to Docker socket/);
    return true;
  });
  assert.equal(await readFile(join(f.dir, 'sg.log'), 'utf8'), 'attempt\n');
});

for (const membership of ['absent', 'current']) {
  test(`Docker failure does not invoke sg when group membership is ${membership}`, async t => {
    const f = await staleGroupFixture(t, { membership });
    await assert.rejects(exec('/bin/bash', [join(root, 'teamcodex.sh'), 'ps'], { env: f.env }), { code: 1 });
    await assert.rejects(readFile(join(f.dir, 'sg.log')), { code: 'ENOENT' });
  });
}
