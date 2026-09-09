import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

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
console.log(JSON.stringify({args:process.argv.slice(2),key:process.env.TEAMCODEX_API_KEY,cwd:process.cwd()}));
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
  // Commands run from an SSH-fed script must leave subsequent stdin intact.
  const shellScript = `${JSON.stringify(link)  } status\nprintf "after-status\\n"\n`;
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
