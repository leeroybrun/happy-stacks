import { runCapture } from './proc.mjs';

export async function commandExists(cmd, { cwd } = {}) {
  const c = String(cmd ?? '').trim();
  if (!c) return false;

  try {
    if (process.platform === 'win32') {
      const out = (await runCapture('where', [c], { cwd })).trim();
      return Boolean(out);
    }
    const out = (await runCapture('sh', ['-lc', `command -v "${c}" >/dev/null 2>&1 && echo yes || echo no`], { cwd })).trim();
    return out === 'yes';
  } catch {
    return false;
  }
}

