/**
 * SessionPort V2 — inert synthetic PostgreSQL fixture (test-support only).
 *
 * This module is deliberately NOT a production database helper and is NOT authorized
 * to launch PostgreSQL. It has no import-time side effects, performs no real process
 * execution on its own, and requires an injected process runner. The default initdb
 * password mechanism is BLOCKED: PostgreSQL 17 documents `--pwfile=FILE` and
 * `-W/--pwprompt` only, not a stdin password mechanism. This module refuses a plaintext
 * password file or a trust-auth fallback.
 *
 * See docs/evidence/postgres-fixture.md for the safety plan and blocker.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { access, appendFile, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, rmdir, unlink } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { createServer } from 'node:net';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { platform as hostPlatform } from 'node:os';
import { fileURLToPath } from 'node:url';

const MODULE_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const DEFAULT_APPROVED_SCRATCH_ROOT = join(MODULE_ROOT, '.package-verify-work');
const OWNER_FILE = 'sessionport-pg-fixture-owner.json';
const LOG_FILE = 'postgres.log';
const MARKER_SCHEMA = 'sessionport-postgres-fixture/1';
const MAX_MARKER_BYTES = 16 * 1024;
const FORBIDDEN_PORTS = new Set([5432]);

export const PG_FIXTURE_BLOCKED_PASSWORD_MECHANISM =
  'PostgreSQL initdb 17 documents --pwfile=FILE and -W/--pwprompt only; no stdin password ' +
  'mechanism is documented. This fixture refuses a plaintext password file and refuses a ' +
  'trust-auth fallback. Real execution stays blocked until an approved mechanism exists.';

export const UNSUPPORTED_INITDB_PASSWORD_MECHANISM = Object.freeze({
  name: 'unsupported',
  secretPlacement: 'none',
  extraArgs: Object.freeze([]),
  reason: PG_FIXTURE_BLOCKED_PASSWORD_MECHANISM,
});

export class PgFixtureError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'PgFixtureError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

/**
 * Build a minimal allowlisted child environment. All PG* variables, PGSERVICE and
 * PGPASSFILE are excluded regardless of what the parent process contains. HOME (and
 * Windows profile variables) are intentionally omitted.
 */
export function buildChildEnv(sourceEnv = process.env, { platform = hostPlatform() } = {}) {
  const windows = platform === 'win32';
  const allowed = windows
    ? ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'windir', 'ComSpec', 'COMSPEC', 'PATHEXT', 'Pathext', 'TEMP', 'TMP', 'SystemDrive', 'NUMBER_OF_PROCESSORS']
    : ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR'];
  const env = {};
  for (const key of allowed) {
    const value = sourceEnv?.[key];
    if (typeof value === 'string' && value.length > 0 && !isPostgresEnvKey(key)) {
      env[key] = value;
    }
  }
  return env;
}

function isPostgresEnvKey(key) {
  const upper = String(key).toUpperCase();
  return upper.startsWith('PG') || upper === 'PGSERVICE' || upper === 'PGSERVICEFILE' || upper === 'PGPASSFILE';
}

/** Build initdb arguments without a password value. A mechanism supplies only static flags. */
export function buildInitdbArgs({ dataDir, username, mechanism = UNSUPPORTED_INITDB_PASSWORD_MECHANISM }) {
  assertMechanismShape(mechanism);
  if (!isAbsolute(dataDir)) throw new PgFixtureError('INVALID_ARGUMENT', 'dataDir must be absolute.');
  if (typeof username !== 'string' || !/^[a-z_][a-z0-9_]{0,62}$/u.test(username)) {
    throw new PgFixtureError('INVALID_ARGUMENT', 'username must be a generated lowercase PostgreSQL identifier.');
  }
  return [
    '--pgdata',
    dataDir,
    '--username',
    username,
    '--auth-host=scram-sha-256',
    '--auth-local=scram-sha-256',
    '--encoding=UTF8',
    '--no-locale',
    '--no-instructions',
    ...mechanism.extraArgs,
  ];
}

function assertMechanismShape(mechanism) {
  if (!mechanism || typeof mechanism !== 'object' || mechanism.secretPlacement !== 'stdin' || !Array.isArray(mechanism.extraArgs) || mechanism.extraArgs.some((arg) => typeof arg !== 'string')) {
    throw new PgFixtureError('INITDB_PASSWORD_STDIN_UNSUPPORTED', PG_FIXTURE_BLOCKED_PASSWORD_MECHANISM);
  }
}

/** Server configuration: loopback only; no Unix socket when the platform supports disabling it. */
export function buildPostgresConf({ port, platform = hostPlatform() }) {
  validateFixturePort(port);
  const lines = [
    "# SessionPort synthetic PostgreSQL fixture — generated metadata, no secrets.",
    "listen_addresses = '127.0.0.1'",
    `port = ${port}`,
    "password_encryption = 'scram-sha-256'",
    'ssl = off',
    'logging_collector = off',
  ];
  if (platform !== 'win32') lines.push("unix_socket_directories = ''");
  return `${lines.join('\n')}\n`;
}

export function validateFixturePort(port) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new PgFixtureError('PORT_INVALID', 'Port must be an integer in 1024..65535.');
  }
  if (FORBIDDEN_PORTS.has(port)) {
    throw new PgFixtureError('PORT_FORBIDDEN', `Port ${port} is forbidden; fixture ports must never target a default PostgreSQL service.`);
  }
  return port;
}

/** Replace the generated secret (and its URL-encoded form) anywhere in text. */
export function redactSecrets(value, secrets = []) {
  let text = String(value ?? '');
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length === 0) continue;
    text = text.split(secret).join('[REDACTED]');
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) text = text.split(encoded).join('[REDACTED]');
  }
  return text;
}

/**
 * Create an inert fixture handle. Construction performs no filesystem writes and does not
 * read PG configuration. `start()` requires an explicitly injected runner.
 */
export function createPostgresFixture(options = {}) {
  if (!options || typeof options !== 'object') throw new PgFixtureError('INVALID_OPTIONS', 'Options object required.');
  if (typeof options.scratchParent !== 'string' || !isAbsolute(options.scratchParent)) {
    throw new PgFixtureError('INVALID_OPTIONS', 'scratchParent must be an absolute path.');
  }
  if (typeof options.pgBin !== 'string' || !isAbsolute(options.pgBin)) {
    throw new PgFixtureError('INVALID_OPTIONS', 'pgBin must be an absolute path.');
  }
  if (!options.runner || typeof options.runner.run !== 'function') {
    throw new PgFixtureError('INVALID_OPTIONS', 'An injected runner with run(command, args, options) is required; no executor is bundled.');
  }

  const platform = options.platform ?? hostPlatform();
  const timeouts = {
    initdbMs: clampInt(options.timeouts?.initdbMs, 60_000, 1_000, 600_000, 'initdbMs'),
    startMs: clampInt(options.timeouts?.startMs, 60_000, 1_000, 600_000, 'startMs'),
    stopMs: clampInt(options.timeouts?.stopMs, 30_000, 1_000, 600_000, 'stopMs'),
    statusMs: clampInt(options.timeouts?.statusMs, 10_000, 1_000, 120_000, 'statusMs'),
  };
  const maxOutputBytes = clampInt(options.maxOutputBytes, 64 * 1024, 1024, 1024 * 1024, 'maxOutputBytes');
  const maxPortAttempts = clampInt(options.maxPortAttempts, 5, 1, 10, 'maxPortAttempts');

  return new PostgresFixture({
    scratchParent: resolve(options.scratchParent),
    approvedScratchRoot: resolve(options.approvedScratchRoot ?? DEFAULT_APPROVED_SCRATCH_ROOT),
    pgBin: resolve(options.pgBin),
    runner: options.runner,
    portAllocator: options.portAllocator ?? (() => allocateEphemeralLoopbackPort()),
    portProbe: options.portProbe ?? ((port) => probeLoopbackPortFree(port)),
    mechanism: options.initdbPasswordMechanism ?? UNSUPPORTED_INITDB_PASSWORD_MECHANISM,
    timeouts,
    maxOutputBytes,
    maxPortAttempts,
    platform,
    sourceEnv: options.sourceEnv ?? process.env,
    database: options.database ?? 'postgres',
  });
}

class PostgresFixture {
  #config = null;
  #state = 'idle';
  #fixtureId = null;
  #nonceHex = null;
  #rootReal = null;
  #dataReal = null;
  #scratchReal = null;
  #port = null;
  #username = null;
  #password = null;
  #bin = null;
  #logPath = null;
  #retained = false;
  #serverMayExist = false;
  #createdRootPath = null;

  constructor(config) {
    this.#config = config;
  }

  getStatus() {
    return Object.freeze({
      state: this.#state,
      fixtureId: this.#fixtureId,
      rootDir: this.#rootReal,
      dataDir: this.#dataReal,
      port: this.#port,
      retained: this.#retained,
    });
  }

  /** Connection fields exist only in caller memory after a successful start. */
  getConnectionConfig() {
    if (this.#state !== 'running') {
      throw new PgFixtureError('NOT_RUNNING', 'Connection configuration is available only while the fixture is running.');
    }
    return Object.freeze({
      host: '127.0.0.1',
      port: this.#port,
      user: this.#username,
      password: this.#password,
      database: this.#config.database,
      sslmode: 'disable',
    });
  }

  /** Caller-memory connection string only; never written to disk, env, args, or logs. */
  getConnectionString() {
    const c = this.getConnectionConfig();
    return `postgresql://${encodeURIComponent(c.user)}:${encodeURIComponent(c.password)}@${c.host}:${c.port}/${encodeURIComponent(c.database)}?sslmode=disable`;
  }

  async start({ signal } = {}) {
    if (this.#state !== 'idle') throw new PgFixtureError('INVALID_STATE', `Cannot start fixture in state ${this.#state}.`);
    throwIfAborted(signal);

    try {
      return await this.#startInternal(signal);
    } catch (error) {
      if (this.#state === 'running' || this.#state === 'stopped' || this.#state === 'failed-retained' || this.#state === 'failed-clean') {
        throw error;
      }
      const retainedPath = this.#rootReal ?? this.#createdRootPath;
      if (!retainedPath) {
        this.#state = 'failed-clean';
        throw error;
      }

      this.#state = 'failed-retained';
      this.#retained = true;
      if (this.#serverMayExist && this.#bin) {
        const env = buildChildEnv(this.#config.sourceEnv, { platform: this.#platform() });
        const stopped = await this.#stopAndVerify(env, 'immediate').catch(() => false);
        if (stopped) {
          const cleanup = await this.#discardPreServerDirectories();
          if (!cleanup.retained) {
            this.#state = 'failed-clean';
            this.#retained = false;
            throw error;
          }
        }
      }
      throw new PgFixtureError('START_UNEXPECTED_RETAINED', 'Fixture start failed unexpectedly; the exact owned state could not be safely cleaned, so the path was retained.', {
        causeCode: error instanceof PgFixtureError ? error.code : 'UNKNOWN',
        retainedPath,
      });
    }
  }

  async #startInternal(signal) {
    // Fail closed before any directory or process work.
    assertMechanismShape(this.#config.mechanism);
    this.#bin = await validatePgBin(this.#config.pgBin, this.#config.platform);
    this.#scratchReal = await resolveScratchParent(this.#config, this.#platform());
    throwIfAborted(signal);

    this.#state = 'allocating-port';
    this.#port = await this.#allocatePort(signal);
    this.#fixtureId = `spf_${randomBytes(12).toString('hex')}`;
    this.#nonceHex = randomBytes(32).toString('hex');
    this.#username = `spx_${randomBytes(6).toString('hex')}`;
    this.#password = randomBytes(32).toString('base64url');

    this.#state = 'preparing';
    await this.#prepareDirectories();
    throwIfAborted(signal);

    const env = buildChildEnv(this.#config.sourceEnv, { platform: this.#platform() });
    this.#state = 'initdb';
    const initdbArgs = buildInitdbArgs({ dataDir: this.#dataReal, username: this.#username, mechanism: this.#config.mechanism });
    const initdbOutcome = await this.#run(this.#bin.initdb, initdbArgs, {
      env,
      stdin: Buffer.from(`${this.#password}\n`, 'utf8'),
      timeoutMs: this.#config.timeouts.initdbMs,
      maxOutputBytes: this.#config.maxOutputBytes,
      signal,
    });

    if (initdbOutcome.timedOut || initdbOutcome.aborted) {
      this.#state = 'failed-retained';
      this.#retained = true;
      throw new PgFixtureError('INITDB_TIMEOUT', 'initdb did not finish within the bound; owned data directory retained because process termination is unverified.', {
        retainedPath: this.#rootReal,
      });
    }
    // A finished stdin stream proves only that bytes were handed to the OS pipe. It does
    // not prove initdb consumed the password or that PostgreSQL supports this delivery.
    // The credential fixture must fail closed unless the runner explicitly reported a
    // completed stdin write and initdb exited zero.
    if (initdbOutcome.stdinStatus !== 'completed') {
      if (initdbOutcome.code === null) {
        this.#state = 'failed-retained';
        this.#retained = true;
        throw new PgFixtureError('INITDB_STDIN_UNCERTAIN', 'initdb password stdin did not complete and process exit was not confirmed; owned data directory retained.', {
          stdinStatus: initdbOutcome.stdinStatus,
          stdinErrorCode: initdbOutcome.stdinErrorCode,
          retainedPath: this.#rootReal,
        });
      }
      const cleanup = await this.#discardPreServerDirectories();
      throw new PgFixtureError('INITDB_STDIN_NOT_COMPLETED', 'initdb did not complete the password stdin write; refusing initialization even though the process exited.', {
        exitCode: initdbOutcome.code,
        stdinStatus: initdbOutcome.stdinStatus,
        stdinErrorCode: initdbOutcome.stdinErrorCode,
        retainedPath: cleanup.retained ? this.#rootReal : null,
      });
    }
    if (initdbOutcome.code !== 0) {
      const cleanup = await this.#discardPreServerDirectories();
      throw new PgFixtureError('INITDB_FAILED', 'initdb exited non-zero; no PostgreSQL server was started.', {
        exitCode: initdbOutcome.code,
        stderr: tail(initdbOutcome.stderr, 2_048),
        retainedPath: cleanup.retained ? this.#rootReal : null,
      });
    }

    await this.#assertOwnedPaths();
    await appendFile(join(this.#dataReal, 'postgresql.conf'), `\n# SessionPort synthetic fixture\n${buildPostgresConf({ port: this.#port, platform: this.#platform() })}`, 'utf8');
    this.#logPath = join(this.#rootReal, LOG_FILE);
    await this.#assertOwnedPaths();

    this.#state = 'starting';
    this.#serverMayExist = true;
    const startArgs = [
      'start',
      '-D',
      this.#dataReal,
      '-l',
      this.#logPath,
      '-w',
      '-t',
      String(Math.max(1, Math.ceil(this.#config.timeouts.startMs / 1000))),
    ];
    const startOutcome = await this.#run(this.#bin.pgCtl, startArgs, {
      env,
      timeoutMs: this.#config.timeouts.startMs + 5_000,
      maxOutputBytes: this.#config.maxOutputBytes,
      signal,
    });

    if (startOutcome.timedOut || startOutcome.aborted || startOutcome.code !== 0) {
      const stopped = await this.#stopAndVerify(env, 'immediate');
      if (!stopped) {
        this.#state = 'failed-retained';
        this.#retained = true;
        throw new PgFixtureError(startOutcome.timedOut ? 'START_TIMEOUT' : 'START_FAILED', 'PostgreSQL start did not complete; the exact owned server could not be verified stopped, so the data directory was retained.', {
          exitCode: startOutcome.code,
          stderr: tail(startOutcome.stderr, 2_048),
          retainedPath: this.#rootReal,
        });
      }
      const cleanup = await this.#discardPreServerDirectories();
      throw new PgFixtureError(startOutcome.timedOut ? 'START_TIMEOUT_CLEANED' : 'START_FAILED_CLEANED', 'PostgreSQL start failed; the exact owned server was verified stopped and owned paths were removed.', {
        exitCode: startOutcome.code,
        stderr: tail(startOutcome.stderr, 2_048),
        retainedPath: cleanup.retained ? this.#rootReal : null,
      });
    }

    const status = await this.#status(env);
    if (status.code !== 0) {
      const stopped = await this.#stopAndVerify(env, 'immediate');
      if (!stopped) {
        this.#state = 'failed-retained';
        this.#retained = true;
        throw new PgFixtureError('START_STATUS_UNVERIFIED', 'pg_ctl start returned success but pg_ctl status did not confirm a running owned server; data directory retained.', {
          retainedPath: this.#rootReal,
        });
      }
      const cleanup = await this.#discardPreServerDirectories();
      throw new PgFixtureError('START_STATUS_UNVERIFIED_CLEANED', 'pg_ctl start returned success but status did not confirm the server; exact stop was verified and owned paths were removed.', {
        retainedPath: cleanup.retained ? this.#rootReal : null,
      });
    }

    this.#state = 'running';
    return this.getConnectionConfig();
  }

  async stop({ mode = 'fast', signal } = {}) {
    if (!['fast', 'immediate', 'smart'].includes(mode)) {
      throw new PgFixtureError('INVALID_ARGUMENT', 'stop mode must be fast, immediate, or smart.');
    }
    if (this.#state === 'idle' || this.#state === 'stopped' || this.#state === 'failed-clean') {
      return Object.freeze({ stopped: true, cleaned: true, already: true });
    }
    if (this.#state === 'allocating-port' || this.#state === 'preparing' || this.#state === 'initdb' || this.#state === 'starting' || this.#state === 'stopping') {
      throw new PgFixtureError('BUSY', 'Stop is not supported while start is in progress; abort via the start signal.');
    }
    if (this.#state === 'failed-retained' && !this.#serverMayExist) {
      throw new PgFixtureError('RETAINED_MANUAL_REVIEW', 'No owned postmaster was ever started; the data directory is retained because the initdb process termination is unverified. Manual review is required before deletion.', {
        retainedPath: this.#rootReal,
      });
    }
    throwIfAborted(signal);

    // Never issue pg_ctl stop against a path whose ownership marker/symlink checks fail.
    try {
      await this.#assertOwnedPaths();
    } catch (error) {
      this.#state = 'failed-retained';
      this.#retained = true;
      if (error instanceof PgFixtureError) throw error;
      throw new PgFixtureError('OWNERSHIP_UNVERIFIED', 'Owned paths could not be verified before stop; no stop command was issued.', {
        retainedPath: this.#rootReal ?? this.#createdRootPath ?? null,
      });
    }

    this.#state = 'stopping';
    try {
      const env = buildChildEnv(this.#config.sourceEnv, { platform: this.#platform() });
      const stopOutcome = await this.#run(this.#bin.pgCtl, [
        'stop',
        '-D',
        this.#dataReal,
        '-m',
        mode,
        '-w',
        '-t',
        String(Math.max(1, Math.ceil(this.#config.timeouts.stopMs / 1000))),
      ], {
        env,
        timeoutMs: this.#config.timeouts.stopMs + 5_000,
        maxOutputBytes: this.#config.maxOutputBytes,
        signal,
      });

      const verified = await this.#verifyStopped(env);
      if (!verified) {
        this.#state = 'failed-retained';
        this.#retained = true;
        throw new PgFixtureError('STOP_UNVERIFIED', 'pg_ctl status could not verify the exact owned postmaster stopped; data directory retained.', {
          stopExitCode: stopOutcome.code,
          stopTimedOut: stopOutcome.timedOut,
          stderr: tail(stopOutcome.stderr, 2_048),
          retainedPath: this.#rootReal,
        });
      }

      try {
        await this.#cleanupOwnedDirectories();
      } catch (error) {
        this.#state = 'failed-retained';
        this.#retained = true;
        if (error instanceof PgFixtureError) throw error;
        throw new PgFixtureError('CLEANUP_REFUSED', 'Owned postmaster is stopped, but cleanup did not complete; directory retained.', {
          retainedPath: this.#rootReal,
        });
      }

      this.#state = 'stopped';
      this.#retained = false;
      this.#password = null;
      return Object.freeze({ stopped: true, cleaned: true, already: false });
    } catch (error) {
      if (this.#state === 'stopped' || this.#state === 'failed-retained' || this.#state === 'failed-clean') throw error;
      this.#state = 'failed-retained';
      this.#retained = true;
      throw new PgFixtureError('STOP_UNEXPECTED_RETAINED', 'Fixture stop failed unexpectedly; the exact owned postmaster state is unverified, so the path was retained.', {
        causeCode: error instanceof PgFixtureError ? error.code : 'UNKNOWN',
        retainedPath: this.#rootReal,
      });
    }
  }

  async #allocatePort(signal) {
    let lastReason = 'no candidate';
    for (let attempt = 0; attempt < this.#config.maxPortAttempts; attempt += 1) {
      throwIfAborted(signal);
      let candidate;
      try {
        candidate = await this.#config.portAllocator({ attempt, platform: this.#platform() });
      } catch (error) {
        if (isAddressInUse(error)) {
          lastReason = 'allocator reported address in use';
          continue;
        }
        throw new PgFixtureError('PORT_ALLOCATION_FAILED', 'Port allocator failed; no default or fallback port is used.', { reason: sanitizeReason(error) });
      }
      // Invalid or forbidden candidates fail closed immediately; they are never replaced by a fallback.
      validateFixturePort(candidate);
      let free = false;
      try {
        free = await this.#config.portProbe(candidate);
      } catch {
        free = false;
      }
      if (free) return candidate;
      lastReason = 'probe reported port unavailable';
    }
    throw new PgFixtureError('PORT_ALLOCATION_FAILED', 'No verified free loopback port after bounded attempts; no default or fallback port is used.', { attempts: this.#config.maxPortAttempts, lastReason });
  }

  async #prepareDirectories() {
    const rootDir = await mkdtemp(join(this.#scratchReal, 'sp-pg-fixture-'));
    this.#createdRootPath = rootDir;
    this.#rootReal = rootDir;
    this.#rootReal = await realpath(rootDir);
    if (!isInside(this.#scratchReal, this.#rootReal, this.#platform())) {
      await rmdir(rootDir).catch(() => {});
      throw new PgFixtureError('SCRATCH_ESCAPE', 'New fixture directory resolved outside the approved scratch root.');
    }
    const dataDir = join(this.#rootReal, 'data');
    await mkdir(dataDir, { mode: 0o700 });
    this.#dataReal = await realpath(dataDir);
    if (!isInside(this.#rootReal, this.#dataReal, this.#platform())) {
      throw new PgFixtureError('SCRATCH_ESCAPE', 'Data directory resolved outside the owned fixture root.');
    }
    const marker = {
      schema: MARKER_SCHEMA,
      fixtureId: this.#fixtureId,
      nonce: this.#nonceHex,
      rootDir: this.#rootReal,
      dataDir: this.#dataReal,
      pgBin: this.#bin.binDir,
      createdAt: new Date().toISOString(),
      platform: this.#platform(),
    };
    const handle = await open(join(this.#rootReal, OWNER_FILE), 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(marker)}\n`, 'utf8');
    } finally {
      await handle.close();
    }
  }

  async #assertOwnedPaths() {
    if (!this.#rootReal || !this.#dataReal) throw new PgFixtureError('OWNERSHIP_UNVERIFIED', 'Fixture paths are not prepared.');
    await assertRealDirectory(this.#rootReal, 'OWNERSHIP_UNVERIFIED');
    const rootNow = await realpath(this.#rootReal);
    if (!samePath(rootNow, this.#rootReal, this.#platform())) throw new PgFixtureError('OWNERSHIP_UNVERIFIED', 'Fixture root canonical path changed.');

    const markerPath = join(this.#rootReal, OWNER_FILE);
    const markerStat = await lstat(markerPath);
    if (markerStat.isSymbolicLink() || !markerStat.isFile() || markerStat.size > MAX_MARKER_BYTES) {
      throw new PgFixtureError('OWNERSHIP_UNVERIFIED', 'Ownership marker is not a bounded regular file.');
    }
    let marker;
    try {
      marker = JSON.parse(await readFile(markerPath, 'utf8'));
    } catch {
      throw new PgFixtureError('OWNERSHIP_UNVERIFIED', 'Ownership marker is unreadable or malformed.');
    }
    if (marker.schema !== MARKER_SCHEMA || marker.fixtureId !== this.#fixtureId || !safeEqualHex(marker.nonce, this.#nonceHex)) {
      throw new PgFixtureError('OWNERSHIP_UNVERIFIED', 'Ownership marker does not match this fixture instance.');
    }
    if (!samePath(marker.rootDir, this.#rootReal, this.#platform()) || !samePath(marker.dataDir, this.#dataReal, this.#platform())) {
      throw new PgFixtureError('OWNERSHIP_UNVERIFIED', 'Ownership marker paths do not match canonical paths.');
    }

    const dataStat = await lstat(this.#dataReal);
    if (dataStat.isSymbolicLink() || !dataStat.isDirectory()) {
      throw new PgFixtureError('OWNERSHIP_UNVERIFIED', 'Data directory is a symlink or not a directory; refusing cleanup.');
    }
    const dataNow = await realpath(this.#dataReal);
    if (!samePath(dataNow, this.#dataReal, this.#platform()) || !isInside(this.#rootReal, dataNow, this.#platform())) {
      throw new PgFixtureError('OWNERSHIP_UNVERIFIED', 'Data directory canonical path escaped the fixture root.');
    }
  }

  async #cleanupOwnedDirectories() {
    await this.#assertOwnedPaths();
    const entries = await readdir(this.#rootReal);
    const allowed = new Set([OWNER_FILE, 'data', LOG_FILE]);
    for (const entry of entries) {
      if (!allowed.has(entry)) throw new PgFixtureError('CLEANUP_REFUSED', 'Unexpected entry in owned fixture root; refusing broad deletion.', { entry });
    }

    if (entries.includes(LOG_FILE)) {
      const logPath = join(this.#rootReal, LOG_FILE);
      const st = await lstat(logPath);
      if (st.isSymbolicLink() || !st.isFile()) throw new PgFixtureError('CLEANUP_REFUSED', 'Fixture log is not a regular file; refusing cleanup.');
      await unlink(logPath);
    }

    await this.#assertOwnedPaths();
    await rm(this.#dataReal, { recursive: true, force: false, maxRetries: 2 });
    await unlink(join(this.#rootReal, OWNER_FILE));
    try {
      await rmdir(this.#rootReal);
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw new PgFixtureError('CLEANUP_REFUSED', 'Owned fixture root was not empty after cleanup; retained.', { retainedPath: this.#rootReal });
    }
  }

  async #discardPreServerDirectories() {
    try {
      await this.#cleanupOwnedDirectories();
      this.#state = 'failed-clean';
      this.#retained = false;
      return { retained: false };
    } catch {
      this.#state = 'failed-retained';
      this.#retained = true;
      return { retained: true };
    }
  }

  async #stopAndVerify(env, mode) {
    try {
      // If ownership cannot be proven, do not risk stopping a foreign postmaster.
      await this.#assertOwnedPaths();
      await this.#run(this.#bin.pgCtl, [
        'stop',
        '-D',
        this.#dataReal,
        '-m',
        mode,
        '-w',
        '-t',
        String(Math.max(1, Math.ceil(this.#config.timeouts.stopMs / 1000))),
      ], {
        env,
        timeoutMs: this.#config.timeouts.stopMs + 5_000,
        maxOutputBytes: this.#config.maxOutputBytes,
      });
    } catch {
      // Verification below decides; no broad kill and no PID reuse assumptions.
    }
    return this.#verifyStopped(env);
  }

  async #verifyStopped(env) {
    const status = await this.#status(env);
    return status.code === 3;
  }

  async #status(env) {
    try {
      return await this.#run(this.#bin.pgCtl, ['status', '-D', this.#dataReal], {
        env,
        timeoutMs: this.#config.timeouts.statusMs,
        maxOutputBytes: this.#config.maxOutputBytes,
      });
    } catch {
      return { code: null, timedOut: true, aborted: false, stdout: '', stderr: '' };
    }
  }

  async #run(command, args, { env, stdin, timeoutMs, maxOutputBytes, signal } = {}) {
    throwIfAborted(signal);
    let raw;
    try {
      raw = await this.#config.runner.run(command, args, {
        env,
        stdin,
        timeoutMs,
        maxOutputBytes,
        signal,
      });
    } catch (error) {
      throw new PgFixtureError('RUNNER_FAILED', 'Injected process runner failed; command output is intentionally sanitized.', {
        reason: redactSecrets(sanitizeReason(error), [this.#password]),
      });
    }
    if (!raw || typeof raw !== 'object') {
      throw new PgFixtureError('RUNNER_CONTRACT', 'Injected runner must resolve an outcome object.');
    }
    const sanitized = {
      code: Number.isInteger(raw.code) ? raw.code : null,
      timedOut: raw.timedOut === true,
      aborted: raw.aborted === true || signal?.aborted === true,
      stdinStatus: normalizeStdinStatus(raw.stdinStatus),
      stdinErrorCode: typeof raw.stdinErrorCode === 'string' && /^[A-Z0-9_]+$/u.test(raw.stdinErrorCode) ? raw.stdinErrorCode : null,
      stdout: redactSecrets(tail(toText(raw.stdout), maxOutputBytes), [this.#password]),
      stderr: redactSecrets(tail(toText(raw.stderr), maxOutputBytes), [this.#password]),
    };
    return sanitized;
  }

  #platform() {
    return this.#config.platform;
  }
}

async function validatePgBin(pgBin, platform) {
  let binReal;
  try {
    const st = await lstat(pgBin);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('not a real directory');
    binReal = await realpath(pgBin);
    if (!samePath(binReal, pgBin, platform)) throw new Error('canonical path mismatch');
  } catch {
    throw new PgFixtureError('PG_BIN_INVALID', 'pgBin must be an existing canonical directory, not a symlink.');
  }

  const names = platform === 'win32'
    ? { initdb: 'initdb.exe', pgCtl: 'pg_ctl.exe', postgres: 'postgres.exe' }
    : { initdb: 'initdb', pgCtl: 'pg_ctl', postgres: 'postgres' };
  const files = {};
  for (const [key, name] of Object.entries(names)) {
    const file = join(binReal, name);
    try {
      const st = await lstat(file);
      if (st.isSymbolicLink() || !st.isFile()) throw new Error('not a regular file');
      if (platform !== 'win32') await access(file, fsConstants.X_OK);
    } catch {
      throw new PgFixtureError('PG_BIN_INVALID', `Required PostgreSQL executable is unavailable: ${name}`);
    }
    files[key] = file;
  }
  return { binDir: binReal, ...files };
}

async function resolveScratchParent(config, platform) {
  let approvedReal;
  let scratchReal;
  try {
    const approvedStat = await lstat(config.approvedScratchRoot);
    if (approvedStat.isSymbolicLink() || !approvedStat.isDirectory()) throw new Error('approved root not canonical');
    approvedReal = await realpath(config.approvedScratchRoot);
    if (!samePath(approvedReal, config.approvedScratchRoot, platform)) throw new Error('approved root canonical mismatch');

    const scratchStat = await lstat(config.scratchParent);
    if (scratchStat.isSymbolicLink() || !scratchStat.isDirectory()) throw new Error('scratch parent not canonical');
    scratchReal = await realpath(config.scratchParent);
    if (!samePath(scratchReal, config.scratchParent, platform)) throw new Error('scratch parent canonical mismatch');
  } catch {
    throw new PgFixtureError('SCRATCH_INVALID', 'scratchParent and approvedScratchRoot must exist as canonical directories, not symlinks.');
  }
  if (!samePath(scratchReal, approvedReal, platform) && !isInside(approvedReal, scratchReal, platform)) {
    throw new PgFixtureError('SCRATCH_OUTSIDE_APPROVED', 'scratchParent must be the approved root or a canonical directory inside it.');
  }
  return scratchReal;
}

async function assertRealDirectory(path, code) {
  const st = await lstat(path);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new PgFixtureError(code, 'Expected a real directory, not a symlink.');
}

function allocateEphemeralLoopbackPort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    const timer = setTimeout(() => {
      server.close(() => reject(new Error('loopback port allocation timed out')));
    }, 3_000);
    server.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : null;
      server.close((error) => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolvePort(port);
      });
    });
  });
}

function probeLoopbackPortFree(port) {
  return new Promise((resolveProbe) => {
    const server = createServer();
    const timer = setTimeout(() => {
      server.close(() => resolveProbe(false));
    }, 3_000);
    server.once('error', () => {
      clearTimeout(timer);
      resolveProbe(false);
    });
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      server.close((error) => {
        clearTimeout(timer);
        resolveProbe(!error);
      });
    });
  });
}

function isAddressInUse(error) {
  return error?.code === 'EADDRINUSE' || error?.code === 'EACCES';
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new PgFixtureError('ABORTED', 'Fixture operation aborted before completion.');
}

function clampInt(value, fallback, min, max, name) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new PgFixtureError('INVALID_OPTIONS', `${name} must be an integer in ${min}..${max}.`);
  }
  return value;
}

function toText(value) {
  if (value === undefined || value === null) return '';
  return Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
}

function tail(text, maxBytes) {
  if (typeof text !== 'string' || text.length === 0) return '';
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const buffer = Buffer.from(text, 'utf8');
  return buffer.subarray(Math.max(0, buffer.length - maxBytes)).toString('utf8');
}

function sanitizeReason(error) {
  const code = typeof error?.code === 'string' ? error.code : 'unknown';
  return `runner error ${code}`;
}

function normalizeStdinStatus(value) {
  return value === 'completed' || value === 'incomplete' || value === 'error' || value === 'not-provided'
    ? value
    : 'missing';
}

function safeEqualHex(left, right) {
  try {
    const a = Buffer.from(String(left), 'hex');
    const b = Buffer.from(String(right), 'hex');
    return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function samePath(left, right, platform) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  if (platform === 'win32') return resolve(left).toLowerCase() === resolve(right).toLowerCase();
  return resolve(left) === resolve(right);
}

function isInside(parent, child, platform) {
  const rel = relative(platform === 'win32' ? resolve(parent).toLowerCase() : resolve(parent), platform === 'win32' ? resolve(child).toLowerCase() : resolve(child));
  return rel.length > 0 && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
