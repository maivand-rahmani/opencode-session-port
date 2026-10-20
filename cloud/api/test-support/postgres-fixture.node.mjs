/**
 * Synthetic tests for cloud/api/test-support/postgres-fixture.mjs.
 *
 * Run explicitly: node --test ./cloud/api/test-support/postgres-fixture.node.mjs
 *
 * These tests use fake executables, a fake process runner, and fake ports. They never
 * start PostgreSQL and never touch an installed service, user database, or real port.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rename, symlink, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import {
  buildChildEnv,
  buildInitdbArgs,
  buildPostgresConf,
  createPostgresFixture,
  redactSecrets,
  validateFixturePort,
  PgFixtureError,
} from './postgres-fixture.mjs';

const IS_WIN = process.platform === 'win32';
const EXE = IS_WIN ? '.exe' : '';

const TEST_STDIN_MECHANISM = Object.freeze({
  name: 'synthetic-test-double',
  secretPlacement: 'stdin',
  extraArgs: Object.freeze([]),
});

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function makeContext(t) {
  const base = await mkdtemp(join(tmpdir(), 'sp-pg-fixture-test-'));
  t.after(async () => {
    await rm(base, { recursive: true, force: true });
  });
  const approved = join(base, 'approved');
  const scratch = join(approved, 'scratch');
  const bin = join(base, 'pgbin');
  await mkdir(approved);
  await mkdir(scratch);
  await mkdir(bin);
  for (const name of ['initdb', 'pg_ctl', 'postgres']) {
    const file = join(bin, `${name}${EXE}`);
    await writeFile(file, 'synthetic placeholder; never executed\n', 'utf8');
    if (!IS_WIN) await chmod(file, 0o755);
  }
  return { base, approved, scratch, bin };
}

function createFakePg(overrides = {}) {
  const calls = [];
  const state = { running: false };
  const behavior = {
    initdb: overrides.initdb ?? (() => ({ code: 0, stdinStatus: 'completed' })),
    start: overrides.start ?? (() => {
      state.running = true;
      return { code: 0 };
    }),
    stop: overrides.stop ?? (() => {
      state.running = false;
      return { code: 0 };
    }),
    status: overrides.status ?? null,
  };
  const runner = {
    calls,
    async run(command, args, options = {}) {
      const call = {
        command,
        args: [...args],
        env: { ...(options.env ?? {}) },
        stdin: options.stdin ? Buffer.from(options.stdin) : null,
        timeoutMs: options.timeoutMs,
        maxOutputBytes: options.maxOutputBytes,
        signal: options.signal,
      };
      calls.push(call);
      const name = basename(command).replace(/\.exe$/u, '');
      if (name === 'initdb') return behavior.initdb(call, state);
      if (name === 'pg_ctl') {
        if (args[0] === 'start') {
          const outcome = await behavior.start(call, state);
          if (outcome?.code === 0) state.running = true;
          return outcome ?? { code: 0 };
        }
        if (args[0] === 'stop') {
          const outcome = await behavior.stop(call, state);
          if (outcome?.code === 0) state.running = false;
          return outcome ?? { code: 0 };
        }
        if (args[0] === 'status') {
          if (behavior.status) return behavior.status(call, state);
          return { code: state.running ? 0 : 3 };
        }
      }
      throw new Error(`unexpected synthetic command: ${command} ${args.join(' ')}`);
    },
  };
  return { runner, calls, state, behavior };
}

function fixtureFor(ctx, fake, overrides = {}) {
  return createPostgresFixture({
    scratchParent: ctx.scratch,
    approvedScratchRoot: ctx.approved,
    pgBin: ctx.bin,
    runner: fake.runner,
    portAllocator: async () => 55432,
    portProbe: async () => true,
    initdbPasswordMechanism: TEST_STDIN_MECHANISM,
    timeouts: { initdbMs: 1_000, startMs: 1_000, stopMs: 1_000, statusMs: 1_000 },
    maxOutputBytes: 4_096,
    maxPortAttempts: 3,
    sourceEnv: { PATH: 'C:\\synthetic-path', SystemRoot: 'C:\\Windows' },
    ...overrides,
  });
}

function callsOf(fake, name, subcommand) {
  return fake.calls.filter((call) => {
    if (basename(call.command).replace(/\.exe$/u, '') !== name) return false;
    return subcommand === undefined || call.args[0] === subcommand;
  });
}

async function assertZeroExitStdinRejected(t, initdbOutcome, expectedStatus, expectedErrorCode) {
  const ctx = await makeContext(t);
  const fake = createFakePg({ initdb: () => ({ ...initdbOutcome }) });
  const fixture = fixtureFor(ctx, fake);
  await assert.rejects(fixture.start(), (error) => {
    assert.equal(error.code, 'INITDB_STDIN_NOT_COMPLETED');
    assert.equal(error.details.exitCode, 0);
    assert.equal(error.details.stdinStatus, expectedStatus);
    assert.equal(error.details.stdinErrorCode, expectedErrorCode);
    return true;
  });
  assert.equal(fixture.getStatus().state, 'failed-clean');
  assert.equal(fixture.getStatus().retained, false);
  assert.equal(callsOf(fake, 'pg_ctl', 'start').length, 0);
  assert.deepEqual(await readdir(ctx.scratch), []);
}

test('module import and construction are inert: no writes, no env mutation, no process, idle state', async (t) => {
  const ctx = await makeContext(t);
  const fake = createFakePg();
  const beforeScratch = await readdir(ctx.scratch);
  const beforeApproved = await readdir(ctx.approved);
  const beforePgEnv = Object.entries(process.env).filter(([key]) => /^PG/iu.test(key));
  const imported = await import(new URL('./postgres-fixture.mjs?inert-import-check=1', import.meta.url).href);
  assert.equal(typeof imported.createPostgresFixture, 'function');
  assert.deepEqual(await readdir(ctx.scratch), beforeScratch);
  assert.deepEqual(await readdir(ctx.approved), beforeApproved);
  assert.deepEqual(Object.entries(process.env).filter(([key]) => /^PG/iu.test(key)), beforePgEnv);

  const fixture = fixtureFor(ctx, fake);
  const status = fixture.getStatus();
  assert.equal(status.state, 'idle');
  assert.equal(status.port, null);
  assert.equal(status.retained, false);
  assert.equal(fake.calls.length, 0);
  assert.deepEqual(await readdir(ctx.scratch), []);
  assert.deepEqual(await readdir(ctx.approved), ['scratch']);
});

test('child environment is allowlisted and excludes PG*, PGSERVICE, PGPASSFILE, HOME', () => {
  const source = {
    PATH: 'C:\\safe\\bin',
    SystemRoot: 'C:\\Windows',
    ComSpec: 'C:\\Windows\\system32\\cmd.exe',
    PATHEXT: '.EXE;.CMD',
    TEMP: 'C:\\Temp',
    HOME: 'C:\\Users\\user',
    APPDATA: 'C:\\Users\\user\\AppData',
    NODE_OPTIONS: '--require evil',
    PGPASSWORD: 'inherited-secret',
    PGHOST: '127.0.0.1',
    PGPORT: '5432',
    PGDATA: 'C:\\Users\\user\\pgdata',
    PGPASSFILE: 'C:\\Users\\user\\.pgpass',
    PGSERVICE: 'user-service',
    PGSERVICEFILE: 'C:\\Users\\user\\.pg_service.conf',
    PGOPTIONS: '-c shared_buffers=1GB',
  };
  const windows = buildChildEnv(source, { platform: 'win32' });
  assert.equal(windows.PATH, 'C:\\safe\\bin');
  assert.equal(windows.SystemRoot, 'C:\\Windows');
  for (const key of ['HOME', 'APPDATA', 'NODE_OPTIONS', 'PGPASSWORD', 'PGHOST', 'PGPORT', 'PGDATA', 'PGPASSFILE', 'PGSERVICE', 'PGSERVICEFILE', 'PGOPTIONS']) {
    assert.equal(Object.hasOwn(windows, key), false, `unexpected env key ${key}`);
  }
  const posix = buildChildEnv(source, { platform: 'linux' });
  assert.equal(posix.PATH, 'C:\\safe\\bin');
  assert.equal(Object.hasOwn(posix, 'SystemRoot'), false);
  assert.equal(Object.hasOwn(posix, 'PGPASSWORD'), false);
  assert.equal(Object.hasOwn(posix, 'PGPASSFILE'), false);
  assert.equal(Object.hasOwn(posix, 'HOME'), false);
});

test('initdb and server-config builders keep secrets out of args and bind loopback only', () => {
  const args = buildInitdbArgs({ dataDir: 'C:\\work\\data', username: 'spx_abcdef', mechanism: TEST_STDIN_MECHANISM });
  const joined = args.join(' ');
  assert.ok(joined.includes('--auth-host=scram-sha-256'));
  assert.ok(joined.includes('--auth-local=scram-sha-256'));
  assert.ok(joined.includes('--encoding=UTF8'));
  assert.ok(joined.includes('--no-locale'));
  assert.equal(joined.includes('inherited-secret'), false);
  assert.equal(joined.includes('password='), false);

  const linuxConf = buildPostgresConf({ port: 55432, platform: 'linux' });
  assert.ok(linuxConf.includes("listen_addresses = '127.0.0.1'"));
  assert.ok(linuxConf.includes('port = 55432'));
  assert.ok(linuxConf.includes("unix_socket_directories = ''"));
  const windowsConf = buildPostgresConf({ port: 55432, platform: 'win32' });
  assert.equal(windowsConf.includes('unix_socket_directories'), false);
  assert.ok(windowsConf.includes("listen_addresses = '127.0.0.1'"));
});

test('port validation fails closed for default/invalid ports and never falls back from 5432', async (t) => {
  for (const [value, code] of [[5432, 'PORT_FORBIDDEN'], [0, 'PORT_INVALID'], [1023, 'PORT_INVALID'], [65536, 'PORT_INVALID'], ['55432', 'PORT_INVALID'], [55432.5, 'PORT_INVALID']]) {
    assert.throws(() => validateFixturePort(value), (error) => error instanceof PgFixtureError && error.code === code);
  }

  const ctx = await makeContext(t);
  const fake = createFakePg();
  let allocations = 0;
  const fixture = fixtureFor(ctx, fake, {
    portAllocator: async () => {
      allocations += 1;
      return 55432;
    },
    portProbe: async () => false,
    maxPortAttempts: 2,
  });
  await assert.rejects(fixture.start(), (error) => error.code === 'PORT_ALLOCATION_FAILED');
  assert.equal(allocations, 2);
  assert.equal(fake.calls.length, 0);
  assert.deepEqual(await readdir(ctx.scratch), []);

  const forbidden = fixtureFor(ctx, createFakePg(), { portAllocator: async () => 5432 });
  await assert.rejects(forbidden.start(), (error) => error.code === 'PORT_FORBIDDEN');
  assert.deepEqual(await readdir(ctx.scratch), []);
});

test('bounded fresh-port retry uses the first probed-free non-default port', async (t) => {
  const ctx = await makeContext(t);
  const fake = createFakePg();
  const candidates = [55432, 55433];
  const fixture = fixtureFor(ctx, fake, {
    portAllocator: async () => candidates.shift(),
    portProbe: async (port) => port === 55433,
    maxPortAttempts: 3,
  });
  const connection = await fixture.start();
  assert.equal(connection.port, 55433);
  assert.equal(connection.host, '127.0.0.1');
  await fixture.stop();
});

test('default unsupported initdb password mechanism blocks before any write or process', async (t) => {
  const ctx = await makeContext(t);
  const fake = createFakePg();
  const fixture = fixtureFor(ctx, fake, { initdbPasswordMechanism: null });
  await assert.rejects(fixture.start(), (error) => {
    assert.equal(error.code, 'INITDB_PASSWORD_STDIN_UNSUPPORTED');
    assert.ok(error.message.includes('--pwfile'));
    assert.equal(error.message.toLowerCase().includes('trust'), true);
    return true;
  });
  assert.equal(fake.calls.length, 0);
  assert.deepEqual(await readdir(ctx.scratch), []);
  assert.equal(fixture.getStatus().state, 'failed-clean');
  assert.equal(fixture.getStatus().retained, false);
});

test('aborted start performs no writes and invokes no process', async (t) => {
  const ctx = await makeContext(t);
  const fake = createFakePg();
  const fixture = fixtureFor(ctx, fake);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(fixture.start({ signal: controller.signal }), (error) => error.code === 'ABORTED');
  assert.equal(fake.calls.length, 0);
  assert.deepEqual(await readdir(ctx.scratch), []);
});

test('successful start sends the generated secret on stdin only and cleanup removes only owned paths', async (t) => {
  const ctx = await makeContext(t);
  const fake = createFakePg();
  const fixture = fixtureFor(ctx, fake, {
    sourceEnv: {
      PATH: 'C:\\synthetic-path',
      SystemRoot: 'C:\\Windows',
      PGPASSWORD: 'inherited-secret',
      PGPASSFILE: 'C:\\user\\.pgpass',
      PGSERVICE: 'user-service',
    },
  });
  const foreign = join(ctx.scratch, 'foreign-keep.txt');
  await writeFile(foreign, 'keep me', 'utf8');

  const connection = await fixture.start();
  const status = fixture.getStatus();
  assert.equal(status.state, 'running');
  assert.equal(status.retained, false);
  assert.equal(connection.host, '127.0.0.1');
  assert.equal(connection.port, 55432);
  assert.ok(connection.user.startsWith('spx_'));
  assert.ok(connection.password.length >= 40);
  const secret = connection.password;

  const initdbCall = callsOf(fake, 'initdb')[0];
  assert.ok(initdbCall);
  assert.ok(initdbCall.args.includes('--pgdata'));
  assert.ok(initdbCall.args.includes(status.dataDir));
  assert.equal(JSON.stringify(initdbCall.args).includes(secret), false);
  assert.equal(JSON.stringify(initdbCall.env).includes(secret), false);
  assert.equal(initdbCall.env.PGPASSWORD, undefined);
  assert.equal(initdbCall.env.PGPASSFILE, undefined);
  assert.equal(initdbCall.env.PGSERVICE, undefined);
  assert.ok(Buffer.isBuffer(initdbCall.stdin));
  assert.equal(initdbCall.stdin.toString('utf8'), `${secret}\n`);

  const startCall = callsOf(fake, 'pg_ctl', 'start')[0];
  assert.ok(startCall.args.includes('-D'));
  assert.ok(startCall.args.includes(status.dataDir));
  assert.equal(JSON.stringify(startCall.args).includes(secret), false);
  assert.equal(startCall.args.some((arg) => arg.toLowerCase().includes('taskkill')), false);

  const config = await readFile(join(status.dataDir, 'postgresql.conf'), 'utf8');
  assert.ok(config.includes('listen_addresses = \'127.0.0.1\'') || config.includes("listen_addresses = '127.0.0.1'"));
  assert.ok(config.includes('port = 55432'));
  assert.equal(config.includes(secret), false);
  const marker = await readFile(join(status.rootDir, 'sessionport-pg-fixture-owner.json'), 'utf8');
  assert.equal(marker.includes(secret), false);

  const connectionString = fixture.getConnectionString();
  assert.ok(connectionString.startsWith('postgresql://'));
  assert.ok(connectionString.includes(encodeURIComponent(secret)));
  assert.equal(fixture.getStatus().state, 'running');

  const stopped = await fixture.stop();
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.cleaned, true);
  assert.equal(await exists(status.rootDir), false);
  assert.equal(await exists(status.dataDir), false);
  assert.equal(await readFile(foreign, 'utf8'), 'keep me');
  const stopCall = callsOf(fake, 'pg_ctl', 'stop')[0];
  assert.ok(stopCall.args.includes('-D'));
  assert.ok(stopCall.args.includes(status.dataDir));
  assert.equal(JSON.stringify(stopCall.args).includes(secret), false);
  assert.equal(JSON.stringify(fake.calls).includes(secret), false);
  assert.throws(() => fixture.getConnectionConfig(), (error) => error.code === 'NOT_RUNNING');
  assert.deepEqual(await fixture.stop(), { stopped: true, cleaned: true, already: true });
});

test('initdb failure cleans owned paths after process exit and redacts/truncates output', async (t) => {
  const ctx = await makeContext(t);
  let leakedSecret = '';
  const fake = createFakePg({
    initdb: (call) => {
      leakedSecret = call.stdin.toString('utf8').trim();
      return {
        code: 1,
        stdinStatus: 'completed',
        stdout: 'x'.repeat(10_000) + leakedSecret,
        stderr: `failure includes ${leakedSecret}`,
      };
    },
  });
  const fixture = fixtureFor(ctx, fake, { maxOutputBytes: 1_024 });
  await assert.rejects(fixture.start(), (error) => {    assert.equal(error.code, 'INITDB_FAILED');
    assert.equal(error.details.stderr.length <= 2_048, true);
    assert.equal(JSON.stringify(error.details).includes(leakedSecret), false);
    assert.ok(error.details.stderr.includes('[REDACTED]'));
    return true;
  });
  assert.equal(fixture.getStatus().state, 'failed-clean');
  assert.equal(fixture.getStatus().retained, false);
  assert.equal(callsOf(fake, 'initdb')[0].maxOutputBytes, 1_024);
  assert.deepEqual(await readdir(ctx.scratch), []);
});

test('zero-exit initdb with EPIPE stdin status is rejected and cleaned', async (t) => {
  await assertZeroExitStdinRejected(t, { code: 0, stdinStatus: 'error', stdinErrorCode: 'EPIPE' }, 'error', 'EPIPE');
});

test('zero-exit initdb with incomplete stdin status is rejected and cleaned', async (t) => {
  await assertZeroExitStdinRejected(t, { code: 0, stdinStatus: 'incomplete', stdinErrorCode: null }, 'incomplete', null);
});

test('zero-exit initdb with missing stdin status is rejected and cleaned', async (t) => {
  await assertZeroExitStdinRejected(t, { code: 0 }, 'missing', null);
});

test('initdb timeout retains the data directory and refuses automatic stop/deletion', async (t) => {
  const ctx = await makeContext(t);
  const fake = createFakePg({ initdb: () => ({ code: null, timedOut: true, stdout: '', stderr: '' }) });
  const fixture = fixtureFor(ctx, fake);
  let retainedPath = null;
  await assert.rejects(fixture.start(), (error) => {
    assert.equal(error.code, 'INITDB_TIMEOUT');
    retainedPath = error.details.retainedPath;
    return true;
  });
  assert.ok(retainedPath);
  assert.equal(await exists(retainedPath), true);
  assert.equal(await exists(join(retainedPath, 'data')), true);
  assert.equal(fixture.getStatus().retained, true);
  await assert.rejects(fixture.stop(), (error) => error.code === 'RETAINED_MANUAL_REVIEW' && error.details.retainedPath === retainedPath);
  assert.equal(await exists(retainedPath), true);
});

test('unexpected runner failure after preparation retains the exact owned path', async (t) => {
  const ctx = await makeContext(t);
  const fake = createFakePg({
    initdb: () => {
      const error = new Error('synthetic runner crash');
      error.code = 'EFAKE';
      throw error;
    },
  });
  const fixture = fixtureFor(ctx, fake);
  let retainedPath = null;
  await assert.rejects(fixture.start(), (error) => {
    assert.equal(error.code, 'START_UNEXPECTED_RETAINED');
    assert.equal(error.details.causeCode, 'RUNNER_FAILED');
    retainedPath = error.details.retainedPath;
    return true;
  });
  assert.equal(await exists(retainedPath), true);
  assert.equal(await exists(join(retainedPath, 'data')), true);
  assert.equal(fixture.getStatus().retained, true);
  await assert.rejects(fixture.stop(), (error) => error.code === 'RETAINED_MANUAL_REVIEW');
  assert.equal(await exists(retainedPath), true);
});

test('start timeout with unverifiable stop retains the exact owned path, then recovery cleanup verifies', async (t) => {
  const ctx = await makeContext(t);
  const fake = createFakePg({
    start: (call, state) => {
      state.running = true;
      return { code: null, timedOut: true, stdout: '', stderr: 'start timed out' };
    },
    stop: () => ({ code: 1, stdout: '', stderr: 'stop failed' }),
  });
  const fixture = fixtureFor(ctx, fake);
  let retainedPath = null;
  await assert.rejects(fixture.start(), (error) => {
    assert.equal(error.code, 'START_TIMEOUT');
    retainedPath = error.details.retainedPath;
    return true;
  });
  assert.equal(await exists(retainedPath), true);
  assert.equal(fixture.getStatus().retained, true);

  const stopCall = callsOf(fake, 'pg_ctl', 'stop').at(-1);
  assert.ok(stopCall.args.includes('-D'));
  assert.ok(stopCall.args.includes(join(retainedPath, 'data')));

  fake.behavior.stop = (call, state) => {
    state.running = false;
    return { code: 0, stdout: 'stopped', stderr: '' };
  };
  const recovered = await fixture.stop();
  assert.equal(recovered.stopped, true);
  assert.equal(recovered.cleaned, true);
  assert.equal(await exists(retainedPath), false);
});

test('stop status uncertainty retains the data directory; a later verified stop cleans it', async (t) => {
  const ctx = await makeContext(t);
  const fake = createFakePg();
  const fixture = fixtureFor(ctx, fake);
  await fixture.start();
  const { rootDir } = fixture.getStatus();

  fake.behavior.stop = () => ({ code: 1, stdout: '', stderr: 'stop uncertain' });
  await assert.rejects(fixture.stop(), (error) => {
    assert.equal(error.code, 'STOP_UNVERIFIED');
    assert.equal(error.details.retainedPath, rootDir);
    return true;
  });
  assert.equal(await exists(rootDir), true);
  assert.equal(fixture.getStatus().retained, true);

  fake.behavior.stop = (call, state) => {
    state.running = false;
    return { code: 0, stdout: '', stderr: '' };
  };
  const recovered = await fixture.stop();
  assert.equal(recovered.cleaned, true);
  assert.equal(await exists(rootDir), false);
});

test('tampered ownership marker refuses cleanup and preserves all paths', async (t) => {
  const ctx = await makeContext(t);
  const fake = createFakePg();
  const fixture = fixtureFor(ctx, fake);
  await fixture.start();
  const { rootDir, dataDir } = fixture.getStatus();
  const markerPath = join(rootDir, 'sessionport-pg-fixture-owner.json');
  const marker = JSON.parse(await readFile(markerPath, 'utf8'));
  marker.nonce = '00'.repeat(32);
  await writeFile(markerPath, `${JSON.stringify(marker)}\n`, 'utf8');

  await assert.rejects(fixture.stop(), (error) => error.code === 'OWNERSHIP_UNVERIFIED');
  assert.equal(callsOf(fake, 'pg_ctl', 'stop').length, 0);
  assert.equal(await exists(rootDir), true);
  assert.equal(await exists(dataDir), true);
  assert.equal(fixture.getStatus().retained, true);
});

test('symlinked data directory refuses cleanup and does not delete the foreign target', async (t) => {
  const ctx = await makeContext(t);
  const fake = createFakePg();
  const fixture = fixtureFor(ctx, fake);
  await fixture.start();
  const { rootDir, dataDir } = fixture.getStatus();
  const moved = join(rootDir, 'data-moved');
  const foreignTarget = join(ctx.base, 'foreign-target');
  await mkdir(foreignTarget);
  await writeFile(join(foreignTarget, 'keep.txt'), 'foreign data', 'utf8');
  await rename(dataDir, moved);
  try {
    await symlink(foreignTarget, dataDir, IS_WIN ? 'junction' : 'dir');
  } catch (error) {
    await fixture.stop().catch(() => {});
    t.skip(`symlink not available: ${error.code ?? error.message}`);
    return;
  }

  await assert.rejects(fixture.stop(), (error) => error.code === 'OWNERSHIP_UNVERIFIED');
  assert.equal(callsOf(fake, 'pg_ctl', 'stop').length, 0);
  assert.equal(await exists(join(foreignTarget, 'keep.txt')), true);
  assert.equal(await readFile(join(foreignTarget, 'keep.txt'), 'utf8'), 'foreign data');
  assert.equal(fixture.getStatus().retained, true);
});

test('each started fixture generates unique synthetic user and password', async (t) => {
  const ctx = await makeContext(t);
  const fakeOne = createFakePg();
  const fakeTwo = createFakePg();
  const first = fixtureFor(ctx, fakeOne);
  const second = fixtureFor(ctx, fakeTwo);
  const connectionOne = await first.start();
  const connectionTwo = await second.start();
  assert.equal(connectionOne.user === connectionTwo.user, false);
  assert.equal(connectionOne.password === connectionTwo.password, false);
  const secretOne = callsOf(fakeOne, 'initdb')[0].stdin.toString('utf8').trim();
  const secretTwo = callsOf(fakeTwo, 'initdb')[0].stdin.toString('utf8').trim();
  assert.equal(secretOne === secretTwo, false);
  await first.stop();
  await second.stop();
});

test('redaction removes raw and URL-encoded secret forms', () => {
  const secret = 'a+b/c=d?e&f';
  const text = `raw=${secret} encoded=${encodeURIComponent(secret)}`;
  const redacted = redactSecrets(text, [secret]);
  assert.equal(redacted.includes(secret), false);
  assert.equal(redacted.includes(encodeURIComponent(secret)), false);
  assert.ok(redacted.includes('[REDACTED]'));
});
