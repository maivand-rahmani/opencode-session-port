/**
 * Synthetic tests for cloud/api/test-support/postgres-runner.mjs.
 *
 * Run explicitly:
 *   node --test cloud/api/test-support/postgres-runner.node.mjs
 *
 * These tests spawn only bounded synthetic Node child processes. They never start
 * PostgreSQL, bind a network service, or touch a real database.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createNodeProcessRunner, RunnerError } from './postgres-runner.mjs';

const IS_WIN = process.platform === 'win32';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function nodeEnv() {
  const env = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP']) {
    if (typeof process.env[key] === 'string') env[key] = process.env[key];
  }
  return env;
}

function makeRunner(overrides = {}) {
  return createNodeProcessRunner({
    allowedExecutables: [process.execPath],
    cwd: tmpdir(),
    ...overrides,
  });
}

function runNode(runner, code, options = {}) {
  return runner.run(process.execPath, ['-e', code], {
    env: nodeEnv(),
    timeoutMs: 4_000,
    maxOutputBytes: 4_096,
    ...options,
  });
}

function parsePid(output, prefix = 'PID:') {
  const line = String(output ?? '').split(/\r?\n/u).find((entry) => entry.startsWith(prefix));
  if (!line) return null;
  const value = Number.parseInt(line.slice(prefix.length), 10);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function waitForDead(pid, timeoutMs = 3_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!isAlive(pid)) return true;
    await delay(25);
  }
  return !isAlive(pid);
}

async function killPid(pid) {
  if (!isAlive(pid)) return;
  try { process.kill(pid, 'SIGKILL'); } catch { /* synthetic cleanup */ }
  await waitForDead(pid);
}

async function killRawChild(child) {
  if (!child) return;
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 2_000);
    child.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
    try { child.kill('SIGKILL'); } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

function spawnSentinel(t) {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    stdio: 'ignore',
    windowsHide: true,
    env: nodeEnv(),
  });
  t.after(async () => { await killRawChild(child); });
  return child;
}

test('module import and runner construction are inert', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'sp-runner-inert-'));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  const imported = await import(new URL('./postgres-runner.mjs?inert-import-check=1', import.meta.url).href);
  assert.equal(typeof imported.createNodeProcessRunner, 'function');
  const runner = imported.createNodeProcessRunner({ allowedExecutables: [process.execPath], cwd: tmpdir() });
  assert.equal(typeof runner.run, 'function');
  assert.deepEqual(await readdir(dir), []);
  assert.throws(() => imported.createNodeProcessRunner({}), (error) => error.code === 'INVALID_ALLOWLIST');
});

test('successful command exits 0 with bounded stdout/stderr and no termination', async () => {
  const out = await runNode(makeRunner(), "process.stdout.write('HELLO')");
  assert.equal(out.code, 0);
  assert.equal(out.timedOut, false);
  assert.equal(out.aborted, false);
  assert.equal(out.outputOverflow, false);
  assert.equal(out.spawnError, null);
  assert.equal(out.stdinStatus, 'not-provided');
  assert.equal(out.termination, 'exited');
  assert.equal(out.processTree, 'not-terminated');
  assert.equal(out.stdout, 'HELLO');
  assert.equal(out.stderr, '');
  assert.equal(out.durationMs >= 0, true);
});

test('non-zero command returns its exit code without throwing', async () => {
  const out = await runNode(makeRunner(), "process.stderr.write('ERR');process.exit(7)");
  assert.equal(out.code, 7);
  assert.equal(out.timedOut, false);
  assert.equal(out.aborted, false);
  assert.equal(out.termination, 'exited');
  assert.equal(out.stderr, 'ERR');
});

test('spawn failure returns safe spawn metadata and no child state', async () => {
  const missing = join(tmpdir(), `sp-runner-missing-${process.pid}`, 'nope.exe');
  const runner = createNodeProcessRunner({ allowedExecutables: [missing], cwd: tmpdir() });
  const out = await runner.run(missing, [], { env: nodeEnv(), stdin: Buffer.from('spawn-secret'), timeoutMs: 2_000, maxOutputBytes: 1_024 });
  assert.equal(out.code, null);
  assert.equal(out.timedOut, false);
  assert.equal(out.aborted, false);
  assert.equal(out.stdinStatus, 'incomplete');
  assert.equal(out.termination, 'spawn-failed');
  assert.equal(out.processTree, 'none');
  assert.equal(out.spawnError.code, 'ENOENT');
  assert.equal(JSON.stringify(out).includes(missing), false);
});

test('executable outside the explicit allowlist is rejected without argv echo', async () => {
  const runner = makeRunner();
  const notAllowed = join(tmpdir(), 'other-node.exe');
  await assert.rejects(runner.run(notAllowed, [], { env: nodeEnv() }), (error) => {
    assert.equal(error instanceof RunnerError, true);
    assert.equal(error.code, 'EXECUTABLE_NOT_ALLOWED');
    assert.equal(error.message.includes(notAllowed), false);
    return true;
  });
});

test('secret is delivered on stdin only, hashed by the child, and redacted from output', async () => {
  const secret = Buffer.from(`sp-runner-secret-${process.pid}-${Date.now()}`);
  const expected = createHash('sha256').update(secret).digest('hex');
  const code = [
    "const c=require('node:crypto');",
    "const parts=[];",
    "process.stdin.on('data',d=>parts.push(d));",
    "process.stdin.on('end',()=>{",
    "const h=c.createHash('sha256').update(Buffer.concat(parts)).digest('hex');",
    "process.stdout.write('SHA:'+h);",
    '});',
  ].join('');
  const out = await runNode(makeRunner(), code, { stdin: secret });
  assert.equal(out.code, 0);
  assert.equal(out.stdout, `SHA:${expected}`);
  assert.equal(out.stdinStatus, 'completed');
  assert.equal(JSON.stringify(out).includes(secret.toString('utf8')), false);

  const echoCode = "let p=[];process.stdin.on('data',d=>p.push(d));process.stdin.on('end',()=>process.stdout.write(Buffer.concat(p).toString().trim()))";
  const echoed = await runNode(makeRunner(), echoCode, { stdin: Buffer.from(`${secret.toString('utf8')}\n`) });
  assert.equal(echoed.stdout.includes(secret.toString('utf8')), false);
  assert.equal(echoed.stdout.includes('[REDACTED]'), true);

  const runner = makeRunner();
  const secretText = secret.toString('utf8');
  await assert.rejects(runner.run(process.execPath, ['-e', '', secretText], { env: nodeEnv(), stdin: secret }), (error) => error.code === 'SECRET_IN_ARGUMENTS');
  await assert.rejects(runner.run(process.execPath, ['-e', ''], { env: { ...nodeEnv(), LEAK: secretText }, stdin: secret }), (error) => error.code === 'SECRET_IN_ENV');
});

test('stdin EPIPE from an early-exiting child does not reject the run', async () => {
  const secret = Buffer.alloc(32 * 1024, 0x61);
  const out = await runNode(makeRunner(), 'process.exit(0)', { stdin: secret, timeoutMs: 3_000 });
  assert.equal(out.code, 0);
  assert.equal(out.timedOut, false);
  assert.equal(out.aborted, false);
  assert.equal(JSON.stringify(out).includes(secret.toString('utf8')), false);
});

test('pre-aborted signal spawns nothing and returns aborted state', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'sp-runner-preabort-'));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  const marker = join(dir, 'spawned.txt');
  const controller = new AbortController();
  controller.abort();
  const code = "require('node:fs').writeFileSync(process.env.SP_RUNNER_MARKER,'spawned')";
  const out = await runNode(makeRunner(), code, {
    signal: controller.signal,
    stdin: Buffer.from('preabort-secret'),
    env: { ...nodeEnv(), SP_RUNNER_MARKER: marker },
  });
  assert.equal(out.aborted, true);
  assert.equal(out.timedOut, false);
  assert.equal(out.code, null);
  assert.equal(out.stdinStatus, 'incomplete');
  assert.equal(out.termination, 'not-spawned');
  assert.equal(out.processTree, 'none');
  await assert.rejects(readFile(marker, 'utf8'));
});

test('in-flight abort terminates only the owned child and settles', async () => {
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), 300);
  const code = "process.stdout.write('PID:'+process.pid+'\\n');setInterval(()=>{},1000)";
  let out;
  try {
    out = await runNode(makeRunner(), code, { signal: controller.signal, timeoutMs: 3_000 });
  } finally {
    clearTimeout(abortTimer);
  }
  assert.equal(out.aborted, true);
  assert.equal(out.timedOut, false);
  assert.equal(['killed', 'uncertain'].includes(out.termination), true);
  const pid = parsePid(out.stdout);
  assert.ok(pid);
  assert.equal(await waitForDead(pid), true);
});

test('timeout terminates the owned child and reports bounded timeout metadata', async () => {
  const code = "process.stdout.write('PID:'+process.pid+'\\n');setInterval(()=>{},1000)";
  const out = await runNode(makeRunner(), code, { timeoutMs: 300 });
  assert.equal(out.timedOut, true);
  assert.equal(out.aborted, false);
  assert.equal(['killed', 'uncertain'].includes(out.termination), true);
  assert.equal(out.processTree === 'none', false);
  assert.equal(out.durationMs < 3_000, true);
  const pid = parsePid(out.stdout);
  assert.ok(pid);
  assert.equal(await waitForDead(pid), true);
});

test('output overflow stops capture and terminates instead of accumulating unbounded output', async () => {
  const code = [
    "process.stdout.write('PID:'+process.pid+'\\n');",
    "process.stdout.write('x'.repeat(200000));",
    'setInterval(()=>{},1000);',
  ].join('');
  const out = await runNode(makeRunner(), code, { maxOutputBytes: 1_024, timeoutMs: 3_000 });
  assert.equal(out.outputOverflow, true);
  assert.equal(out.timedOut, true);
  assert.equal(out.stdout.length <= 1_024, true);
  const pid = parsePid(out.stdout);
  assert.ok(pid);
  assert.equal(await waitForDead(pid), true);
});

test('output below the cap stays bounded and does not trigger overflow', async () => {
  const out = await runNode(makeRunner(), "process.stdout.write('a'.repeat(900))", { maxOutputBytes: 1_024 });
  assert.equal(out.code, 0);
  assert.equal(out.outputOverflow, false);
  assert.equal(out.stdout.length, 900);
  assert.equal(out.timedOut, false);
});

test('successful command is not allowed to blanket-kill an intentionally daemonized descendant', async (t) => {
  const code = [
    "const {spawn}=require('node:child_process');",
    "const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true});",
    "c.unref();",
    "process.stdout.write('CHILD:'+c.pid,()=>process.exit(0));",
  ].join('');
  const out = await runNode(makeRunner(), code, { timeoutMs: 3_000 });
  assert.equal(out.code, 0);
  const childPid = parsePid(out.stdout, 'CHILD:');
  assert.ok(childPid);
  t.after(async () => { await killPid(childPid); });
  await delay(100);
  assert.equal(isAlive(childPid), true);
  assert.equal(out.processTree, 'not-terminated');
  await killPid(childPid);
  assert.equal(isAlive(childPid), false);
});

test('timeout of one child does not kill a foreign synthetic process', async (t) => {
  const sentinel = spawnSentinel(t);
  const sentinelPid = sentinel.pid;
  assert.ok(Number.isInteger(sentinelPid));
  const code = "process.stdout.write('PID:'+process.pid+'\\n');setInterval(()=>{},1000)";
  const out = await runNode(makeRunner(), code, { timeoutMs: 300 });
  assert.equal(out.timedOut, true);
  assert.equal(isAlive(sentinelPid), true);
  const runnerPid = parsePid(out.stdout);
  assert.ok(runnerPid);
  assert.equal(await waitForDead(runnerPid), true);
  await killRawChild(sentinel);
  assert.equal(isAlive(sentinelPid), false);
});

test('Windows taskkill is bounded to the owned tree when explicitly configured', async (t) => {
  if (!IS_WIN) {
    t.skip('Windows-only tree-kill test');
    return;
  }
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  const taskkillPath = systemRoot ? join(systemRoot, 'System32', 'taskkill.exe') : null;
  if (!taskkillPath) {
    t.skip('taskkill path unavailable');
    return;
  }
  try {
    await access(taskkillPath);
  } catch {
    t.skip('taskkill unavailable');
    return;
  }

  const code = [
    "const {spawn}=require('node:child_process');",
    "const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});",
    "process.stdout.write(JSON.stringify({parent:process.pid,child:c.pid}));",
    'setInterval(()=>{},1000);',
  ].join('');
  const runner = makeRunner({
    taskkillPath,
    taskkillEnv: { SystemRoot: systemRoot, WINDIR: systemRoot, PATH: process.env.PATH },
    terminationGraceMs: 1_500,
    taskkillTimeoutMs: 1_500,
  });
  const out = await runNode(runner, code, { timeoutMs: 500, maxOutputBytes: 4_096 });
  assert.equal(out.timedOut, true);
  const pids = JSON.parse(out.stdout.trim());
  assert.ok(Number.isInteger(pids.parent));
  assert.ok(Number.isInteger(pids.child));
  assert.equal(await waitForDead(pids.parent), true);
  assert.equal(await waitForDead(pids.child), true);
});
