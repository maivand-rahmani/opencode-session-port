/**
 * SessionPort V2 — bounded Node process runner for the inert PostgreSQL test fixture.
 *
 * This is test-support only. It never starts PostgreSQL by itself and has no import-time
 * side effects. It matches the runner contract consumed by `postgres-fixture.mjs`:
 *
 *   runner.run(command, args, { env, stdin, timeoutMs, maxOutputBytes, signal })
 *     -> { code, timedOut, aborted, stdout, stderr, ...safe metadata }
 *
 * The runner launches only an explicitly configured absolute executable. The caller supplies
 * the env and stdin; the runner never inherits `process.env` wholesale. Secrets are written
 * to child stdin only, never argv/env, and are redacted from returned output.
 *
 * Termination is limited to the child spawned by this invocation. On Windows, an optional
 * configured `taskkill.exe /PID <owned pid> /T /F` request is used under a bounded timeout
 * before direct child termination; it is still reported as unproven process-tree cleanup.
 * A successful pg_ctl invocation may intentionally leave a postmaster running; the runner
 * does not kill descendants after a successful or normally-exited command.
 */

import { spawn } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { platform as hostPlatform } from 'node:os';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES_LIMIT = 1024 * 1024;
const MAX_STDIN_BYTES = 64 * 1024;
const DEFAULT_TERMINATION_GRACE_MS = 1_500;
const DEFAULT_TASKKILL_TIMEOUT_MS = 1_500;

export class RunnerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RunnerError';
    this.code = code;
  }
}

/**
 * Create a runner bound to an explicit executable allowlist.
 *
 * Options:
 * - allowedExecutables: required non-empty array of absolute executable paths.
 * - cwd: optional absolute working directory; defaults to the executable's directory.
 * - taskkillPath: optional absolute `...\System32\taskkill.exe` for bounded Windows tree requests.
 * - taskkillEnv: optional explicit environment for the taskkill helper (not inherited).
 * - terminationGraceMs / taskkillTimeoutMs: bounded cleanup waits.
 */
export function createNodeProcessRunner(options = {}) {
  if (!options || typeof options !== 'object') {
    throw new RunnerError('INVALID_OPTIONS', 'Runner options object required.');
  }
  if (!Array.isArray(options.allowedExecutables) || options.allowedExecutables.length === 0) {
    throw new RunnerError('INVALID_ALLOWLIST', 'allowedExecutables must be a non-empty array of absolute executable paths.');
  }
  for (const executable of options.allowedExecutables) {
    if (typeof executable !== 'string' || !isAbsolute(executable)) {
      throw new RunnerError('INVALID_ALLOWLIST', 'allowedExecutables must contain only absolute executable paths.');
    }
  }
  if (options.cwd !== undefined && (typeof options.cwd !== 'string' || !isAbsolute(options.cwd))) {
    throw new RunnerError('INVALID_CWD', 'cwd must be an absolute path when provided.');
  }
  if (options.taskkillPath !== undefined) {
    if (typeof options.taskkillPath !== 'string' || !isAbsolute(options.taskkillPath) || basename(options.taskkillPath).toLowerCase() !== 'taskkill.exe') {
      throw new RunnerError('INVALID_TASKKILL_PATH', 'taskkillPath must be an absolute path to taskkill.exe.');
    }
  }

  const platform = hostPlatform();
  const allowed = new Set(options.allowedExecutables.map((executable) => normalizePath(executable, platform)));
  const cwd = options.cwd === undefined ? null : resolve(options.cwd);
  const taskkillPath = options.taskkillPath === undefined ? null : resolve(options.taskkillPath);
  const taskkillEnv = normalizeEnv(options.taskkillEnv ?? {}, 'taskkillEnv');
  const terminationGraceMs = clampInt(options.terminationGraceMs, DEFAULT_TERMINATION_GRACE_MS, 100, 10_000, 'terminationGraceMs');
  const taskkillTimeoutMs = clampInt(options.taskkillTimeoutMs, DEFAULT_TASKKILL_TIMEOUT_MS, 100, 5_000, 'taskkillTimeoutMs');

  const runner = {
    async run(command, args, runOptions = {}) {
      return await runOnce({
        platform,
        allowed,
        cwd,
        taskkillPath,
        taskkillEnv,
        terminationGraceMs,
        taskkillTimeoutMs,
      }, command, args, runOptions);
    },
  };
  return Object.freeze(runner);
}

async function runOnce(config, command, args, runOptions) {
  const startedAt = Date.now();
  if (typeof command !== 'string' || !isAbsolute(command)) {
    throw new RunnerError('EXECUTABLE_NOT_ALLOWED', 'Executable must be an absolute path in the explicit allowlist.');
  }
  if (!config.allowed.has(normalizePath(command, config.platform))) {
    throw new RunnerError('EXECUTABLE_NOT_ALLOWED', 'Executable is not in the explicit allowlist.');
  }
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
    throw new RunnerError('INVALID_ARGUMENTS', 'args must be an array of strings.');
  }
  if (!runOptions || typeof runOptions !== 'object') {
    throw new RunnerError('INVALID_OPTIONS', 'run options object required.');
  }

  const env = normalizeEnv(runOptions.env, 'env');
  const stdinBuffer = normalizeStdin(runOptions.stdin);
  if (stdinBuffer && stdinBuffer.length > MAX_STDIN_BYTES) {
    throw new RunnerError('STDIN_TOO_LARGE', 'stdin exceeds the bounded synthetic-secret limit.');
  }
  const secret = stdinBuffer ? stdinBuffer.toString('utf8') : '';
  const secretForms = buildSecretForms(secret);
  if (secretForms.length > 0) {
    if (args.some((arg) => secretForms.some((form) => arg.includes(form)))) {
      throw new RunnerError('SECRET_IN_ARGUMENTS', 'Secret must be supplied on stdin only, never in argv.');
    }
    if (Object.values(env).some((value) => secretForms.some((form) => value.includes(form)))) {
      throw new RunnerError('SECRET_IN_ENV', 'Secret must be supplied on stdin only, never in the child environment.');
    }
  }

  const timeoutMs = clampInt(runOptions.timeoutMs, DEFAULT_TIMEOUT_MS, 1, MAX_TIMEOUT_MS, 'timeoutMs');
  const maxOutputBytes = clampInt(runOptions.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, 1, MAX_OUTPUT_BYTES_LIMIT, 'maxOutputBytes');
  const signal = runOptions.signal;
  if (signal !== undefined && (typeof signal !== 'object' || typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) {
    throw new RunnerError('INVALID_SIGNAL', 'signal must be an AbortSignal.');
  }
  const cwd = config.cwd ?? dirname(command);
  if (!isAbsolute(cwd)) {
    throw new RunnerError('INVALID_CWD', 'Resolved working directory must be absolute.');
  }

  if (signal?.aborted) return preAbortedOutcome(startedAt, Boolean(stdinBuffer));

  return await new Promise((resolveOutcome) => {
    let child;
    try {
      child = spawn(command, args, {
        shell: false,
        cwd,
        env: { ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        detached: false,
      });
    } catch (error) {
      resolveOutcome(spawnFailedOutcome(error, startedAt, Boolean(stdinBuffer)));
      return;
    }

    let settled = false;
    let closeInfo = null;
    let resolveClose;
    const closePromise = new Promise((resolve) => { resolveClose = resolve; });
    let spawnError = null;
    let stdinErrorCode = null;
    let stdinStatus = stdinBuffer ? 'incomplete' : 'not-provided';
    let terminationReason = null;
    let terminationResult = null;

    const stdout = new BoundedCapture(maxOutputBytes, () => triggerTermination('overflow'));
    const stderr = new BoundedCapture(maxOutputBytes, () => triggerTermination('overflow'));

    const clearRunTimer = () => {
      clearTimeout(timeoutTimer);
    };
    const removeAbortListener = () => {
      signal?.removeEventListener('abort', onAbort);
    };

    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearRunTimer();
      removeAbortListener();
      try { child.stdin?.destroy(); } catch { /* bounded cleanup */ }
      if (!closeInfo) {
        try { child.stdout?.destroy(); } catch { /* bounded cleanup */ }
        try { child.stderr?.destroy(); } catch { /* bounded cleanup */ }
        try { child.unref(); } catch { /* bounded cleanup */ }
      }
      resolveOutcome(outcome);
    };

    const outcome = ({ termination, processTree, timedOut, aborted }) => ({
      code: closeInfo?.code ?? null,
      signal: closeInfo?.signal ?? null,
      timedOut,
      aborted,
      stdout: redactSecrets(stdout.toString(), secretForms),
      stderr: redactSecrets(stderr.toString(), secretForms),
      outputOverflow: stdout.overflow || stderr.overflow,
      spawnError,
      stdinStatus,
      stdinErrorCode,
      termination,
      processTree,
      durationMs: Date.now() - startedAt,
    });

    const finalizeTermination = () => {
      finish(outcome({
        termination: closeInfo ? 'killed' : 'uncertain',
        processTree: terminationResult?.tree ?? 'uncertain',
        // The current harness contract has no first-class uncertainty field. Conservative
        // timeout mapping makes the harness retain data for uncertain process trees and
        // output overflow. A first-class field would require a harness change (not made here).
        timedOut: terminationReason === 'timeout' || terminationReason === 'overflow',
        aborted: terminationReason === 'abort',
      }));
    };

    const triggerTermination = (reason) => {
      if (settled || terminationReason) return;
      terminationReason = reason;
      clearRunTimer();
      removeAbortListener();
      void (async () => {
        try {
          terminationResult = await terminateOwnedChild(child, config);
        } catch {
          terminationResult = { tree: 'uncertain', method: 'direct' };
        }
        if (settled) return;
        if (!closeInfo) await waitForCloseOrGrace(closePromise, config.terminationGraceMs);
        if (settled) return;
        finalizeTermination();
      })().catch(() => {
        if (settled) return;
        terminationResult = terminationResult ?? { tree: 'uncertain', method: 'direct' };
        finalizeTermination();
      });
    };

    const closeRun = (code, closeSignal) => {
      closeInfo = { code, signal: closeSignal };
      resolveClose();
      if (settled) return;
      if (!terminationReason) {
        finish(outcome({
          termination: spawnError ? 'spawn-failed' : 'exited',
          processTree: spawnError ? 'none' : 'not-terminated',
          timedOut: false,
          aborted: false,
        }));
      }
    };

    const abortRun = () => triggerTermination('abort');
    const onAbort = abortRun;
    const timeoutTimer = setTimeout(() => triggerTermination('timeout'), timeoutMs);

    child.once('close', closeRun);
    child.once('error', (error) => {
      if (settled) return;
      const safe = safeError(error);
      if (!child.pid || error?.syscall === 'spawn') {
        spawnError = safe;
        finish(outcome({
          termination: 'spawn-failed',
          processTree: 'none',
          timedOut: false,
          aborted: false,
        }));
        return;
      }
      spawnError = safe;
    });

    child.stdout?.on('data', (chunk) => stdout.push(chunk));
    child.stderr?.on('data', (chunk) => stderr.push(chunk));
    child.stdout?.on('error', () => {});
    child.stderr?.on('error', () => {});
    child.stdin?.on('error', (error) => {
      stdinErrorCode = safeError(error).code;
      if (stdinBuffer) stdinStatus = 'error';
    });

    // A finished stdin stream proves bytes were handed to the OS pipe; it does not prove
    // the child consumed them or accepted the password. Callers must not claim more.
    const markStdinCompleted = () => {
      if (stdinBuffer && stdinStatus !== 'error') stdinStatus = 'completed';
    };
    child.stdin?.once('finish', markStdinCompleted);

    try {
      if (!child.stdin) {
        stdinErrorCode = 'NO_STDIN';
        if (stdinBuffer) stdinStatus = 'incomplete';
      } else if (stdinBuffer && stdinBuffer.length > 0) {
        child.stdin.end(stdinBuffer, (error) => {
          if (error) {
            stdinErrorCode = safeError(error).code;
            if (stdinBuffer) stdinStatus = 'error';
          } else {
            markStdinCompleted();
          }
        });
      } else {
        child.stdin.end();
      }
    } catch (error) {
      stdinErrorCode = safeError(error).code;
      if (stdinBuffer) stdinStatus = 'error';
      try { child.stdin?.destroy(); } catch { /* bounded cleanup */ }
    }

    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) abortRun();
  });
}

async function terminateOwnedChild(child, config) {
  if (!child || !Number.isInteger(child.pid)) {
    return { tree: 'none', method: 'none' };
  }
  if (child.exitCode !== null || child.signalCode !== null) {
    return { tree: 'already-exited', method: 'none' };
  }

  if (config.platform === 'win32' && config.taskkillPath) {
    const validTaskkill = await resolveTaskkillPath(config.taskkillPath);
    if (validTaskkill && child.exitCode === null && child.signalCode === null) {
      const taskkill = await runTaskkill(validTaskkill, child.pid, config.taskkillEnv, config.taskkillTimeoutMs);
      if (taskkill.ok) {
        if (child.exitCode === null && child.signalCode === null) safelyKill(child);
        return { tree: 'tree-kill-requested', method: 'taskkill' };
      }
    }
  }

  safelyKill(child);
  return { tree: 'uncertain', method: 'direct' };
}

function safelyKill(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try { child.kill('SIGKILL'); } catch { /* already exited or unsupported */ }
}

async function resolveTaskkillPath(path) {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isFile()) return null;
    if (basename(dirname(path)).toLowerCase() !== 'system32') return null;
    return path;
  } catch {
    return null;
  }
}

function runTaskkill(taskkillPath, pid, env, timeoutMs) {
  return new Promise((resolve) => {
    if (!Number.isInteger(pid) || pid <= 0) {
      resolve({ ok: false, code: 'INVALID_PID' });
      return;
    }
    let finished = false;
    let child;
    const done = (result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try { child?.kill('SIGKILL'); } catch { /* bounded cleanup */ }
      done({ ok: false, code: 'TIMEOUT' });
    }, timeoutMs);

    try {
      child = spawn(taskkillPath, ['/PID', String(pid), '/T', '/F'], {
        shell: false,
        cwd: dirname(taskkillPath),
        env: { ...env },
        stdio: 'ignore',
        windowsHide: true,
        detached: false,
      });
    } catch (error) {
      done({ ok: false, code: safeError(error).code });
      return;
    }
    child.once('error', (error) => done({ ok: false, code: safeError(error).code }));
    child.once('close', (code) => done({ ok: code === 0, code: code === 0 ? 'OK' : `EXIT_${code}` }));
  });
}

function waitForCloseOrGrace(closePromise, graceMs) {
  return new Promise((resolve) => {
    let timer;
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    timer = setTimeout(done, graceMs);
    closePromise.then(done, done);
  });
}

class BoundedCapture {
  #chunks = [];
  #bytes = 0;
  #limit;
  #onOverflow;
  #overflow = false;

  constructor(limit, onOverflow) {
    this.#limit = limit;
    this.#onOverflow = onOverflow;
  }

  get overflow() {
    return this.#overflow;
  }

  push(chunk) {
    if (this.#overflow) return;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const room = this.#limit - this.#bytes;
    if (buffer.length > room) {
      if (room > 0) {
        this.#chunks.push(Buffer.from(buffer.subarray(0, room)));
        this.#bytes += room;
      }
      this.#overflow = true;
      this.#onOverflow();
      return;
    }
    if (buffer.length > 0) {
      this.#chunks.push(Buffer.from(buffer));
      this.#bytes += buffer.length;
    }
  }

  toString() {
    return Buffer.concat(this.#chunks, this.#bytes).toString('utf8');
  }
}

function normalizeEnv(value, name) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RunnerError('INVALID_ENV', `${name} must be a plain object.`);
  }
  const env = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof key !== 'string' || key.length === 0 || typeof entry !== 'string') {
      throw new RunnerError('INVALID_ENV', `${name} must contain string keys and values.`);
    }
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      throw new RunnerError('INVALID_ENV', `${name} contains a forbidden key.`);
    }
    env[key] = entry;
  }
  return env;
}

function normalizeStdin(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  throw new RunnerError('INVALID_STDIN', 'stdin must be a string or Buffer.');
}

function buildSecretForms(secret) {
  if (typeof secret !== 'string' || secret.length === 0) return [];
  const forms = new Set([secret]);
  const trimmed = secret.replace(/[\r\n]+$/u, '');
  if (trimmed.length > 0) forms.add(trimmed);
  for (const form of [...forms]) {
    const encoded = encodeURIComponent(form);
    if (encoded !== form) forms.add(encoded);
  }
  return [...forms].sort((left, right) => right.length - left.length);
}

function redactSecrets(value, secretForms) {
  let text = String(value ?? '');
  if (!Array.isArray(secretForms) || secretForms.length === 0) return text;
  for (const secret of secretForms) {
    if (typeof secret !== 'string' || secret.length === 0) continue;
    text = text.split(secret).join('[REDACTED]');
  }
  return text;
}

function normalizePath(path, platform) {
  const resolved = resolve(path);
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function clampInt(value, fallback, min, max, name) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RunnerError('INVALID_OPTIONS', `${name} must be an integer in ${min}..${max}.`);
  }
  return value;
}

function safeError(error) {
  const code = typeof error?.code === 'string' && /^[A-Z0-9_]+$/u.test(error.code) ? error.code : 'UNKNOWN';
  const name = typeof error?.name === 'string' && /^[A-Za-z0-9_]+$/u.test(error.name) ? error.name : 'Error';
  return { code, name };
}

function preAbortedOutcome(startedAt, stdinProvided) {
  return {
    code: null,
    signal: null,
    timedOut: false,
    aborted: true,
    stdout: '',
    stderr: '',
    outputOverflow: false,
    spawnError: null,
    stdinStatus: stdinProvided ? 'incomplete' : 'not-provided',
    stdinErrorCode: null,
    termination: 'not-spawned',
    processTree: 'none',
    durationMs: Date.now() - startedAt,
  };
}

function spawnFailedOutcome(error, startedAt, stdinProvided) {
  return {
    code: null,
    signal: null,
    timedOut: false,
    aborted: false,
    stdout: '',
    stderr: '',
    outputOverflow: false,
    spawnError: safeError(error),
    stdinStatus: stdinProvided ? 'incomplete' : 'not-provided',
    stdinErrorCode: null,
    termination: 'spawn-failed',
    processTree: 'none',
    durationMs: Date.now() - startedAt,
  };
}
