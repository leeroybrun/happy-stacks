import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
 
function isTty() {
  return Boolean(process.stdout.isTTY && process.stderr.isTTY);
}
 
function spinnerFrames() {
  return ['|', '/', '-', '\\'];
}
 
export function createStepPrinter({ enabled = true } = {}) {
  const tty = enabled && isTty();
  const frames = spinnerFrames();
  let timer = null;
  let idx = 0;
  let currentLine = '';
 
  const write = (s) => process.stdout.write(s);
 
  const start = (label) => {
    if (!tty) {
      write(`- [..] ${label}\n`);
      return;
    }
    currentLine = `- [${frames[idx % frames.length]}] ${label}`;
    write(currentLine);
    timer = setInterval(() => {
      idx++;
      const next = `- [${frames[idx % frames.length]}] ${label}`;
      const pad = currentLine.length > next.length ? ' '.repeat(currentLine.length - next.length) : '';
      currentLine = next;
      write(`\r${next}${pad}`);
    }, 120);
  };
 
  const stop = (result, label) => {
    if (timer) clearInterval(timer);
    timer = null;
    if (!tty) {
      write(`- [${result}] ${label}\n`);
      return;
    }
    const out = `- [${result}] ${label}`;
    const pad = currentLine.length > out.length ? ' '.repeat(currentLine.length - out.length) : '';
    currentLine = '';
    write(`\r${out}${pad}\n`);
  };
 
  const info = (line) => {
    write(`${line}\n`);
  };
 
  return { start, stop, info };
}
 
export async function runCommandLogged({
  label,
  cmd,
  args,
  cwd,
  env,
  logPath,
  showSteps = true,
  quiet = true,
}) {
  const steps = createStepPrinter({ enabled: showSteps });
  if (quiet) {
    await mkdir(dirname(logPath), { recursive: true }).catch(() => {});
  }
 
  steps.start(label);
 
  const child = spawn(cmd, args, {
    cwd,
    env,
    stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    shell: false,
  });
 
  let stdout = '';
  let stderr = '';
  let logStream = null;
  if (quiet) {
    logStream = createWriteStream(logPath, { flags: 'a' });
    child.stdout?.on('data', (d) => {
      const s = d.toString();
      stdout += s;
      logStream?.write(s);
    });
    child.stderr?.on('data', (d) => {
      const s = d.toString();
      stderr += s;
      logStream?.write(s);
    });
  }
 
  const res = await new Promise((resolvePromise, rejectPromise) => {
    child.on('error', rejectPromise);
    child.on('close', (code, signal) => resolvePromise({ code: code ?? 1, signal: signal ?? null }));
  });
 
  try {
    logStream?.end();
  } catch {
    // ignore
  }
 
  if (res.code === 0) {
    steps.stop('✓', label);
    return { ok: true, code: 0, stdout, stderr, logPath };
  }
 
  steps.stop('x', label);
  const err = new Error(`${cmd} failed (code=${res.code}${res.signal ? `, sig=${res.signal}` : ''})`);
  err.code = 'EEXIT';
  err.exitCode = res.code;
  err.signal = res.signal;
  err.stdout = stdout;
  err.stderr = stderr;
  err.logPath = logPath;
  throw err;
}

