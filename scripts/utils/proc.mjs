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
  await new Promise((resolvePromise, rejectPromise) => {
    const proc = spawn(cmd, args, { stdio: 'inherit', shell: false, ...options });
    proc.on('error', rejectPromise);
    proc.on('exit', (code) => (code === 0 ? resolvePromise() : rejectPromise(new Error(`${cmd} failed (code=${code})`))));
  });
}

export async function runCapture(cmd, args, options = {}) {
  return await new Promise((resolvePromise, rejectPromise) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false, ...options });
    let out = '';
    let err = '';
    proc.stdout?.on('data', (d) => (out += d.toString()));
    proc.stderr?.on('data', (d) => (err += d.toString()));
    proc.on('error', rejectPromise);
    proc.on('exit', (code) => {
      if (code === 0) {
        resolvePromise(out);
      } else {
        rejectPromise(new Error(`${cmd} ${args.join(' ')} failed (code=${code}): ${err.trim()}`));
      }
    });
  });
}

