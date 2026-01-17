import { spawn } from 'node:child_process';

function nextLineBreakIndex(s) {
  const n = s.indexOf('\n');
  const r = s.indexOf('\r');
  if (n < 0) return r;
  if (r < 0) return n;
  return Math.min(n, r);
}

function consumeLineBreak(buf) {
  if (buf.startsWith('\r\n')) return buf.slice(2);
  if (buf.startsWith('\n') || buf.startsWith('\r')) return buf.slice(1);
  return buf;
}

function writeWithPrefix(stream, prefix, bufState, chunk) {
  const s = chunk.toString();
  bufState.buf += s;
  while (true) {
    const idx = nextLineBreakIndex(bufState.buf);
    if (idx < 0) break;
    const line = bufState.buf.slice(0, idx);
    bufState.buf = consumeLineBreak(bufState.buf.slice(idx));
    stream.write(`${prefix}${line}\n`);
  }
}

function flushPrefixed(stream, prefix, bufState) {
  if (!bufState.buf) return;
  stream.write(`${prefix}${bufState.buf}\n`);
  bufState.buf = '';
}

export function spawnProc(label, cmd, args, env, options = {}) {
  const child = spawn(cmd, args, {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    // Create a new process group so we can kill the whole tree reliably on shutdown.
    detached: process.platform !== 'win32',
    ...options,
  });

  const outState = { buf: '' };
  const errState = { buf: '' };
  const outPrefix = `[${label}] `;
  const errPrefix = `[${label}] `;

  child.stdout?.on('data', (d) => writeWithPrefix(process.stdout, outPrefix, outState, d));
  child.stderr?.on('data', (d) => writeWithPrefix(process.stderr, errPrefix, errState, d));
  child.on('close', () => {
    flushPrefixed(process.stdout, outPrefix, outState);
    flushPrefixed(process.stderr, errPrefix, errState);
  });
  child.on('exit', (code, sig) => {
    if (code !== 0) {
      process.stderr.write(`[${label}] exited (code=${code}, sig=${sig})\n`);
    }
  });

  return child;
}

export function killProcessTree(child, signal) {
  if (!child || child.exitCode != null || !child.pid) {
    return;
  }

  try {
    if (process.platform !== 'win32') {
      // Kill the process group.
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch {
    // ignore
  }
}

export async function run(cmd, args, options = {}) {
  const { timeoutMs, ...spawnOptions } = options ?? {};
  await new Promise((resolvePromise, rejectPromise) => {
    const proc = spawn(cmd, args, { stdio: 'inherit', shell: false, ...spawnOptions });
    const t =
      Number.isFinite(timeoutMs) && timeoutMs > 0
        ? setTimeout(() => {
            try {
              proc.kill('SIGKILL');
            } catch {
              // ignore
            }
            const e = new Error(`${cmd} timed out after ${timeoutMs}ms`);
            e.code = 'ETIMEDOUT';
            rejectPromise(e);
          }, timeoutMs)
        : null;
    proc.on('error', rejectPromise);
    proc.on('exit', (code) => (code === 0 ? resolvePromise() : rejectPromise(new Error(`${cmd} failed (code=${code})`))));
    proc.on('exit', () => {
      if (t) clearTimeout(t);
    });
  });
}

export async function runCapture(cmd, args, options = {}) {
  const { timeoutMs, ...spawnOptions } = options ?? {};
  return await new Promise((resolvePromise, rejectPromise) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false, ...spawnOptions });
    let out = '';
    let err = '';
    const t =
      Number.isFinite(timeoutMs) && timeoutMs > 0
        ? setTimeout(() => {
            try {
              proc.kill('SIGKILL');
            } catch {
              // ignore
            }
            const e = new Error(`${cmd} ${args.join(' ')} timed out after ${timeoutMs}ms`);
            e.code = 'ETIMEDOUT';
            e.out = out;
            e.err = err;
            rejectPromise(e);
          }, timeoutMs)
        : null;
    proc.stdout?.on('data', (d) => (out += d.toString()));
    proc.stderr?.on('data', (d) => (err += d.toString()));
    proc.on('error', rejectPromise);
    proc.on('exit', (code, signal) => {
      if (t) clearTimeout(t);
      if (code === 0) {
        resolvePromise(out);
      } else {
        const e = new Error(
          `${cmd} ${args.join(' ')} failed (code=${code ?? 'null'}, sig=${signal ?? 'null'}): ${err.trim()}`
        );
        e.code = 'EEXIT';
        e.exitCode = code;
        e.signal = signal;
        e.out = out;
        e.err = err;
        rejectPromise(e);
      }
    });
  });
}

export async function runCaptureResult(cmd, args, options = {}) {
  const { timeoutMs, ...spawnOptions } = options ?? {};
  const startedAt = Date.now();
  return await new Promise((resolvePromise) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false, ...spawnOptions });
    let out = '';
    let err = '';
    const t =
      Number.isFinite(timeoutMs) && timeoutMs > 0
        ? setTimeout(() => {
            try {
              proc.kill('SIGKILL');
            } catch {
              // ignore
            }
            resolvePromise({
              ok: false,
              exitCode: null,
              signal: null,
              out,
              err,
              timedOut: true,
              startedAt,
              finishedAt: Date.now(),
              durationMs: Date.now() - startedAt,
            });
          }, timeoutMs)
        : null;
    proc.stdout?.on('data', (d) => (out += d.toString()));
    proc.stderr?.on('data', (d) => (err += d.toString()));
    proc.on('error', (e) => {
      if (t) clearTimeout(t);
      resolvePromise({
        ok: false,
        exitCode: null,
        signal: null,
        out,
        err: err + (err.endsWith('\n') || !err ? '' : '\n') + String(e) + '\n',
        timedOut: false,
        startedAt,
        finishedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      });
    });
    proc.on('close', (code, signal) => {
      if (t) clearTimeout(t);
      resolvePromise({
        ok: code === 0,
        exitCode: code,
        signal: signal ?? null,
        out,
        err,
        timedOut: false,
        startedAt,
        finishedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

