import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { mkdir, rename, writeFile } from 'node:fs/promises';

import { runCapture } from '../proc/proc.mjs';
import { getDefaultAutostartPaths } from '../paths/paths.mjs';
import { resolveInstalledCliRoot, resolveInstalledPath } from '../paths/runtime.mjs';

function plistPathForLabel(label) {
  return join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
}

function xmlEscape(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function plistXml({ label, programArgs, env = {}, stdoutPath, stderrPath, workingDirectory }) {
  const envEntries = Object.entries(env ?? {}).filter(([k, v]) => String(k).trim() && String(v ?? '').trim());
  const programArgsXml = programArgs.map((a) => `      <string>${xmlEscape(a)}</string>`).join('\n');
  const envXml = envEntries
    .map(([k, v]) => `      <key>${xmlEscape(k)}</key>\n      <string>${xmlEscape(v)}</string>`)
    .join('\n');
  const workingDirXml = workingDirectory
    ? `\n    <key>WorkingDirectory</key>\n    <string>${xmlEscape(workingDirectory)}</string>\n`
    : '\n';

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${xmlEscape(label)}</string>

    <key>ProgramArguments</key>
    <array>
${programArgsXml}
    </array>

    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
${workingDirXml}    <key>StandardOutPath</key>
    <string>${xmlEscape(stdoutPath)}</string>
    <key>StandardErrorPath</key>
    <string>${xmlEscape(stderrPath)}</string>

    <key>EnvironmentVariables</key>
    <dict>
${envXml}
    </dict>
  </dict>
</plist>
`;
}

export async function ensureMacAutostartEnabled({ rootDir, label, env }) {
  if (process.platform !== 'darwin') {
    throw new Error('[local] macOS autostart is only supported on Darwin');
  }
  const l = String(label ?? '').trim();
  if (!l) throw new Error('[local] missing launchd label');

  const plistPath = plistPathForLabel(l);
  const { stdoutPath, stderrPath } = getDefaultAutostartPaths();
  await mkdir(dirname(plistPath), { recursive: true }).catch(() => {});
  await mkdir(dirname(stdoutPath), { recursive: true }).catch(() => {});
  await mkdir(dirname(stderrPath), { recursive: true }).catch(() => {});

  const programArgs = [process.execPath, resolveInstalledPath(rootDir, 'bin/happys.mjs'), 'start'];
  const mergedEnv = {
    ...(env ?? {}),
    // Ensure a reasonable PATH for subprocesses (git/docker/etc) in launchd’s minimal environment.
    PATH: (process.env.PATH ?? '').trim() || '/usr/bin:/bin:/usr/sbin:/sbin',
  };

  const xml = plistXml({
    label: l,
    programArgs,
    env: mergedEnv,
    stdoutPath,
    stderrPath,
    workingDirectory: resolveInstalledCliRoot(rootDir),
  });

  const tmp = join(dirname(plistPath), `.tmp.${l}.${Date.now()}.plist`);
  await writeFile(tmp, xml, 'utf-8');
  await rename(tmp, plistPath);

  // Best-effort load/enable; `scripts/service.mjs` has a more robust bootstrap fallback.
  try {
    await runCapture('launchctl', ['load', '-w', plistPath]);
  } catch {
    // ignore
  }
}

export async function ensureMacAutostartDisabled({ label }) {
  if (process.platform !== 'darwin') {
    return;
  }
  const l = String(label ?? '').trim();
  if (!l) return;
  const plistPath = plistPathForLabel(l);

  const uidRaw = Number(process.env.UID);
  const uid = Number.isFinite(uidRaw) ? uidRaw : null;

  try {
    await runCapture('launchctl', ['unload', '-w', plistPath]);
  } catch {
    // ignore
  }
  try {
    await runCapture('launchctl', ['unload', plistPath]);
  } catch {
    // ignore
  }
  if (uid != null) {
    try {
      await runCapture('launchctl', ['disable', `gui/${uid}/${l}`]);
    } catch {
      // ignore
    }
    try {
      await runCapture('launchctl', ['bootout', `gui/${uid}`, plistPath]);
    } catch {
      // ignore
    }
  }
  try {
    await runCapture('launchctl', ['remove', l]);
  } catch {
    // ignore
  }
}

