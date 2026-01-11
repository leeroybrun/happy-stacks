import { spawn } from 'node:child_process';

export function spawnProc(label, cmd, args, env, options = {}) {
  const child = spawn(cmd, args, {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    // Create a new process group so we can kill the whole tree reliably on shutdown.
    detached: process.platform !== 'win32',
    ...options,
  });

  child.stdout?.on('data', (d) => process.stdout.write(`[${label}] ${d.toString()}`));
  child.stderr?.on('data', (d) => process.stderr.write(`[${label}] ${d.toString()}`));
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
