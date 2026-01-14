import './utils/env.mjs';
import { parseArgs } from './utils/args.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli.mjs';
import { resolveStackEnvPath, getComponentDir, getRootDir } from './utils/paths.mjs';
import { parseDotenv } from './utils/dotenv.mjs';
import { pathExists } from './utils/fs.mjs';
import { run, runCapture } from './utils/proc.mjs';
import { resolveLocalhostHost } from './utils/localhost_host.mjs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { mkdir, lstat, rename, symlink, writeFile, readdir, copyFile } from 'node:fs/promises';
import { homedir } from 'node:os';

const COMPONENTS = ['happy', 'happy-cli', 'happy-server-light', 'happy-server'];

function cleanHappyStacksEnv(baseEnv) {
  const cleaned = { ...baseEnv };
  for (const k of Object.keys(cleaned)) {
    if (k === 'HAPPY_LOCAL_ENV_FILE' || k === 'HAPPY_STACKS_ENV_FILE') continue;
    if (k === 'HAPPY_LOCAL_STACK' || k === 'HAPPY_STACKS_STACK') continue;
    if (k.startsWith('HAPPY_LOCAL_') || k.startsWith('HAPPY_STACKS_')) {
      delete cleaned[k];
    }
  }
  return cleaned;
}

async function readExistingEnv(path) {
  try {
    const raw = await readFile(path, 'utf-8');
    return raw;
  } catch {
    return '';
  }
}

async function readJsonIfExists(path) {
  try {
    if (!path || !(await pathExists(path))) return null;
    const raw = await readFile(path, 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function inferServerPortFromRuntimeState(runtimeState) {
  try {
    const port = runtimeState?.ports?.server;
    const n = Number(port);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function isQaValidateCommand(edisonArgs) {
  const args = Array.isArray(edisonArgs) ? edisonArgs : [];
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === 'qa' && args[i + 1] === 'validate') return true;
  }
  return false;
}

async function ensureStackServerPortForWebServerValidation({ rootDir, stackName, env, edisonArgs, json }) {
  const currentPort = (env.HAPPY_STACKS_SERVER_PORT ?? env.HAPPY_LOCAL_SERVER_PORT ?? '').toString().trim();
  if (currentPort) return;
  if (!isQaValidateCommand(edisonArgs)) return;

  const { baseDir } = resolveStackEnvPath(stackName);
  const runtimePath = join(baseDir, 'stack.runtime.json');

  const existing = await readJsonIfExists(runtimePath);
  const existingPort = inferServerPortFromRuntimeState(existing);
  if (existingPort) {
    env.HAPPY_STACKS_SERVER_PORT = String(existingPort);
    env.HAPPY_LOCAL_SERVER_PORT = String(existingPort);
    return;
  }

  // Option A: Happy-local wrapper responsibility.
  // If the stack uses ephemeral ports and isn't running yet, start it (detached) so we can
  // discover the chosen port via stack.runtime.json before Edison expands web_server URLs.
  if (!json) {
    // eslint-disable-next-line no-console
    console.log(`[edison] stack=${stackName}: server port not set; starting stack to resolve runtime port...`);
  }

  try {
    const child = spawn(
      process.execPath,
      // Do NOT force `--restart` here:
      // - If the prior ephemeral port is still occupied (common after a crash), `--restart` fails closed.
      // - For validation we prefer to bring up the stack on a fresh port rather than fail preflight.
      [join(rootDir, 'bin', 'happys.mjs'), 'stack', 'start', stackName],
      { cwd: rootDir, env, stdio: 'ignore', detached: true }
    );
    child.unref();
  } catch {
    // If we fail to spawn, we still proceed; Edison will fail closed when URL probing fails.
  }

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    const st = await readJsonIfExists(runtimePath);
    const port = inferServerPortFromRuntimeState(st);
    if (port) {
      env.HAPPY_STACKS_SERVER_PORT = String(port);
      env.HAPPY_LOCAL_SERVER_PORT = String(port);
      return;
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function readFrontmatterFile(path) {
  const text = await readFile(path, 'utf-8');
  const { fm } = parseFrontmatter(text);
  return fm ?? {};
}

async function resolveTaskFilePath({ rootDir, taskId }) {
  const taskPath = join(rootDir, '.project', 'tasks');
  const taskGlobRoots = ['todo', 'wip', 'done', 'validated', 'blocked'];
  for (const st of taskGlobRoots) {
    const p = join(taskPath, st, `${taskId}.md`);
    // eslint-disable-next-line no-await-in-loop
    if (await pathExists(p)) return p;
  }
  // Also check session-scoped tasks: .project/sessions/<sess-state>/<session-id>/tasks/<task-state>/<id>.md
  const sessionsRoot = join(rootDir, '.project', 'sessions');
  try {
    const sessStates = await readdir(sessionsRoot, { withFileTypes: true });
    for (const s of sessStates) {
      if (!s.isDirectory()) continue;
      const sessStateDir = join(sessionsRoot, s.name);
      // eslint-disable-next-line no-await-in-loop
      const sessIds = await readdir(sessStateDir, { withFileTypes: true }).catch(() => []);
      for (const sid of sessIds) {
        if (!sid.isDirectory()) continue;
        const base = join(sessStateDir, sid.name, 'tasks');
        for (const st of taskGlobRoots) {
          const p = join(base, st, `${taskId}.md`);
          // eslint-disable-next-line no-await-in-loop
          if (await pathExists(p)) return p;
        }
      }
    }
  } catch {
    // ignore
  }
  return '';
}

async function resolveQaFilePath({ rootDir, qaId }) {
  const qaPath = join(rootDir, '.project', 'qa');
  const qaStates = ['waiting', 'todo', 'wip', 'done', 'validated'];
  for (const st of qaStates) {
    const p = join(qaPath, st, `${qaId}.md`);
    // eslint-disable-next-line no-await-in-loop
    if (await pathExists(p)) return p;
  }
  // Also check session-scoped QA: .project/sessions/<sess-state>/<session-id>/qa/<qa-state>/<id>.md
  const sessionsRoot = join(rootDir, '.project', 'sessions');
  try {
    const sessStates = await readdir(sessionsRoot, { withFileTypes: true });
    for (const s of sessStates) {
      if (!s.isDirectory()) continue;
      const sessStateDir = join(sessionsRoot, s.name);
      // eslint-disable-next-line no-await-in-loop
      const sessIds = await readdir(sessStateDir, { withFileTypes: true }).catch(() => []);
      for (const sid of sessIds) {
        if (!sid.isDirectory()) continue;
        const base = join(sessStateDir, sid.name, 'qa');
        for (const st of qaStates) {
          const p = join(base, st, `${qaId}.md`);
          // eslint-disable-next-line no-await-in-loop
          if (await pathExists(p)) return p;
        }
      }
    }
  } catch {
    // ignore
  }
  return '';
}

async function inferStackFromRecordId({ rootDir, recordId }) {
  const id = String(recordId ?? '').trim();
  if (!id) return '';
  const taskPath = await resolveTaskFilePath({ rootDir, taskId: id });
  if (taskPath) {
    const fm = await readFrontmatterFile(taskPath);
    return String(fm?.stack ?? '').trim();
  }
  const qaPath = await resolveQaFilePath({ rootDir, qaId: id });
  if (qaPath) {
    const fm = await readFrontmatterFile(qaPath);
    return String(fm?.stack ?? '').trim();
  }
  return '';
}

async function inferStackFromArgs({ rootDir, edisonArgs }) {
  const args = Array.isArray(edisonArgs) ? edisonArgs : [];
  for (const a of args) {
    if (!a || a.startsWith('-')) continue;
    // eslint-disable-next-line no-await-in-loop
    const s = await inferStackFromRecordId({ rootDir, recordId: a });
    if (s) return s;
  }
  return '';
}

async function inferTaskIdFromArgs({ rootDir, edisonArgs }) {
  const args = Array.isArray(edisonArgs) ? edisonArgs : [];
  for (const a of args) {
    if (!a || a.startsWith('-')) continue;
    const id = String(a).trim();
    if (!id) continue;
    // eslint-disable-next-line no-await-in-loop
    const taskPath = await resolveTaskFilePath({ rootDir, taskId: id });
    if (taskPath) return id;
    // eslint-disable-next-line no-await-in-loop
    const qaPath = await resolveQaFilePath({ rootDir, qaId: id });
    if (qaPath) {
      // Some commands might pass a QA id; use its task_id to determine targeted components.
      // eslint-disable-next-line no-await-in-loop
      const fm = await readFrontmatterFile(qaPath);
      const tid = String(fm?.task_id ?? fm?.taskId ?? '').trim();
      if (tid) return tid;
    }
  }
  return '';
}

function parseEnvToObject(raw) {
  const parsed = parseDotenv(raw);
  return Object.fromEntries(parsed.entries());
}

function resolveComponentDirsFromStackEnv({ rootDir, stackEnv }) {
  const out = [];

  for (const name of COMPONENTS) {
    const key = `HAPPY_STACKS_COMPONENT_DIR_${name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
    const legacyKey = `HAPPY_LOCAL_COMPONENT_DIR_${name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
    const raw = (stackEnv[key] ?? stackEnv[legacyKey] ?? '').toString().trim();
    const dir = raw || getComponentDir(rootDir, name);
    out.push(dir);
  }
  return out;
}

function hasFlag(argv, name) {
  return argv.some((a) => a === name || a.startsWith(`${name}=`));
}

function parseFrontmatter(content) {
  const text = String(content ?? '');
  if (!text.startsWith('---')) return { fm: {}, body: text };
  const idx = text.indexOf('\n---', 3);
  if (idx === -1) return { fm: {}, body: text };
  const fmText = text.slice(3, idx + 1).trim();
  const body = text.slice(idx + 4);

  const fm = {};
  let currentKey = '';
  for (const rawLine of fmText.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const m = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (m) {
      currentKey = m[1];
      const v = m[2].trim();
      if (v === '[]') {
        fm[currentKey] = [];
      } else if (v.startsWith('[') && v.endsWith(']')) {
        const inside = v.slice(1, -1);
        fm[currentKey] = inside
          .split(',')
          .map((p) => p.trim())
          .filter(Boolean)
          .map((p) => p.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1'));
      } else if (v === '') {
        fm[currentKey] = '';
      } else {
        fm[currentKey] = v.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
      }
      continue;
    }
    const li = line.match(/^\s*-\s*(.*)$/);
    if (li && currentKey) {
      if (!Array.isArray(fm[currentKey])) fm[currentKey] = [];
      fm[currentKey].push(li[1].trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1'));
    }
  }
  return { fm, body };
}

function resolveComponentsFromFrontmatter(fm) {
  const hsKind = String(fm?.hs_kind ?? '').trim().toLowerCase();
  if (hsKind === 'component') {
    const c = String(fm?.component ?? '').trim();
    if (c) return [c];
  }
  const v = fm?.components;
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === 'string' && v.trim()) return v.split(',').map((p) => p.trim()).filter(Boolean);
  return [];
}

function sanitizeStackName(raw) {
  return String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .slice(0, 64);
}

function yamlQuote(v) {
  const s = String(v ?? '');
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function renderYamlFrontmatter(obj) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) {
      lines.push(`${k}:`);
      for (const item of v) {
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          const keys = Object.keys(item);
          if (!keys.length) continue;
          lines.push(`  - ${keys[0]}: ${yamlQuote(item[keys[0]])}`);
          for (const kk of keys.slice(1)) {
            lines.push(`    ${kk}: ${yamlQuote(item[kk])}`);
          }
        } else {
          lines.push(`  - ${yamlQuote(item)}`);
        }
      }
      continue;
    }
    if (v && typeof v === 'object') {
      lines.push(`${k}: ${yamlQuote(JSON.stringify(v))}`);
      continue;
    }
    if (typeof v === 'number' || typeof v === 'boolean') {
      lines.push(`${k}: ${v}`);
      continue;
    }
    if (v === null) {
      lines.push(`${k}: null`);
      continue;
    }
    lines.push(`${k}: ${yamlQuote(v)}`);
  }
  lines.push('---');
  return lines.join('\n') + '\n';
}

async function listExistingTaskIds({ rootDir }) {
  const taskRoot = join(rootDir, '.project', 'tasks');
  const states = ['todo', 'wip', 'done', 'validated', 'blocked'];
  const ids = new Set();
  for (const st of states) {
    const dir = join(taskRoot, st);
    // eslint-disable-next-line no-await-in-loop
    if (!(await pathExists(dir))) continue;
    // eslint-disable-next-line no-await-in-loop
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (!e.isFile()) continue;
      if (!e.name.endsWith('.md')) continue;
      ids.add(e.name.slice(0, -3));
    }
  }
  return ids;
}

async function listTaskFiles({ rootDir }) {
  const taskRoot = join(rootDir, '.project', 'tasks');
  const states = ['todo', 'wip', 'done', 'validated', 'blocked'];
  const out = [];
  for (const st of states) {
    const dir = join(taskRoot, st);
    // eslint-disable-next-line no-await-in-loop
    if (!(await pathExists(dir))) continue;
    // eslint-disable-next-line no-await-in-loop
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (!e.isFile()) continue;
      if (!e.name.endsWith('.md')) continue;
      out.push({ id: e.name.slice(0, -3), path: join(dir, e.name) });
    }
  }
  return out;
}

async function scanTasks({ rootDir }) {
  const files = await listTaskFiles({ rootDir });
  const tasks = [];
  for (const f of files) {
    // eslint-disable-next-line no-await-in-loop
    const text = await readFile(f.path, 'utf-8').catch(() => '');
    const { fm } = parseFrontmatter(text);
    tasks.push({ id: f.id, path: f.path, fm });
  }
  return tasks;
}

function nextChildId(parentId, existingIds) {
  const prefix = `${parentId}.`;
  let max = 0;
  for (const id of existingIds) {
    if (!String(id).startsWith(prefix)) continue;
    const rest = String(id).slice(prefix.length);
    const first = rest.split('.')[0];
    if (!/^\d+$/.test(first)) continue;
    const n = Number(first);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `${parentId}.${max + 1}`;
}

async function ensureTaskFile({ rootDir, taskId, frontmatter, body, state = 'todo' }) {
  const dir = join(rootDir, '.project', 'tasks', state);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${taskId}.md`);
  if (await pathExists(path)) return { path, created: false };
  const text = renderYamlFrontmatter(frontmatter) + '\n' + String(body || '').trim() + '\n';
  await writeFile(path, text, 'utf-8');
  return { path, created: true };
}

async function ensureQaFile({ rootDir, taskId, title, frontmatterExtra = {} }) {
  const qaId = `${taskId}-qa`;
  const dir = join(rootDir, '.project', 'qa', 'waiting');
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${qaId}.md`);
  if (await pathExists(path)) return { path, created: false };
  const fm = {
    id: qaId,
    task_id: taskId,
    title,
    round: 0,
    ...frontmatterExtra,
  };
  const body =
    `# ${title}\n\n` +
    `## Automated Checks (Happy Stacks)\n\n` +
    `- Evidence capture (stack-scoped): \`happys edison --stack=${frontmatterExtra.stack ?? '<stack>'} -- evidence capture ${taskId}\`\n`;
  const text = renderYamlFrontmatter(fm) + '\n' + body;
  await writeFile(path, text, 'utf-8');
  return { path, created: true };
}

async function cmdTaskScaffold({ rootDir, argv, json }) {
  const { flags, kv } = parseArgs(argv);
  const positionals = argv.filter((a) => !a.startsWith('--'));
  const taskId = positionals[1]?.trim?.() ? positionals[1].trim() : '';
  if (!taskId) {
    throw new Error(
      '[edison] usage: happys edison task:scaffold <task-id> [--mode=upstream|fork|both] [--tracks=upstream,fork] [--yes] [--json]'
    );
  }

  const mode = (kv.get('--mode') ?? '').trim().toLowerCase() || 'upstream';
  const yes = flags.has('--yes');

  const taskPath = join(rootDir, '.project', 'tasks');
  const taskGlobRoots = ['todo', 'wip', 'done', 'validated', 'blocked'];
  let mdPath = '';
  for (const st of taskGlobRoots) {
    const p = join(taskPath, st, `${taskId}.md`);
    // eslint-disable-next-line no-await-in-loop
    if (await pathExists(p)) {
      mdPath = p;
      break;
    }
  }
  if (!mdPath) {
    throw new Error(`[edison] task not found: ${taskId} (expected under .project/tasks/{todo,wip,done,validated,blocked}/${taskId}.md)`);
  }

  const taskText = await readFile(mdPath, 'utf-8');
  const { fm } = parseFrontmatter(taskText);

  const hsKind = String(fm?.hs_kind ?? '').trim().toLowerCase();
  if (!hsKind || !['parent', 'track', 'component'].includes(hsKind)) {
    throw new Error(`[edison] missing/invalid hs_kind in task frontmatter.\nFix: edit ${mdPath} and set:\n  hs_kind: parent|track|component`);
  }

  const components = resolveComponentsFromFrontmatter(fm);
  const stackFromTask = String(fm.stack ?? '').trim();

  const desiredTracksRaw = (kv.get('--tracks') ?? '').trim();
  let trackNames = desiredTracksRaw ? desiredTracksRaw.split(',').map((p) => p.trim()).filter(Boolean) : [];
  if (!trackNames.length) {
    trackNames = mode === 'both' ? ['upstream', 'fork'] : [mode === 'fork' ? 'fork' : 'upstream'];
  }

  const stacksJson = await runCapture('node', ['./bin/happys.mjs', 'stack', 'list', '--json'], { cwd: rootDir });
  let stacks = [];
  try {
    const parsed = JSON.parse(stacksJson || '[]');
    if (Array.isArray(parsed)) {
      stacks = parsed;
    } else if (parsed && typeof parsed === 'object' && Array.isArray(parsed.stacks)) {
      stacks = parsed.stacks;
    } else {
      stacks = [];
    }
  } catch {
    stacks = [];
  }

  const existingIds = await listExistingTaskIds({ rootDir });
  const tasks = await scanTasks({ rootDir });
  const createdStacks = [];
  const createdTasks = [];
  const createdQas = [];
  const createdWorktrees = [];
  const pinned = [];

  if (hsKind === 'parent') {
    if (!components.length) {
      throw new Error(
        `[edison] parent task must declare components.\nFix: edit ${mdPath} and set:\n  components:\n    - happy\n    - happy-cli\nThen run:\n  happys edison task:scaffold ${taskId} --yes`
      );
    }
    if (!yes) {
      throw new Error(
        `[edison] parent scaffold will create track + component subtasks, stacks, and worktrees.\nRe-run with:\n  happys edison task:scaffold ${taskId} --yes`
      );
    }

    for (const track of trackNames) {
      const existingTrack = tasks.find((t) => {
        if (!String(t.id).startsWith(`${taskId}.`)) return false;
        const k = String(t.fm?.hs_kind ?? '').trim().toLowerCase();
        if (k !== 'track') return false;
        const bt = String(t.fm?.base_task ?? '').trim();
        const tn = String(t.fm?.track ?? '').trim();
        return bt === taskId && tn === track;
      });

      const trackTaskId = existingTrack?.id || nextChildId(taskId, existingIds);
      existingIds.add(trackTaskId);
      const stack = String(existingTrack?.fm?.stack ?? '').trim() || sanitizeStackName(`${taskId}-${track}`);
      const trackTitle = `Track: ${track} (${stack})`;

      const trackFm = {
        id: trackTaskId,
        title: trackTitle,
        hs_kind: 'track',
        track,
        stack,
        base_task: taskId,
        components,
        relationships: [{ type: 'parent', target: taskId }],
      };
      const trackBody =
        `# ${trackTitle}\n\n` +
        `## Scope\n\n` +
        `- Parent: ${taskId}\n` +
        `- Track: ${track}\n` +
        `- Stack: ${stack}\n` +
        `- Components: ${components.join(', ')}\n\n` +
        `## Commands (MANDATORY)\n\n` +
        `- Run inside stack context: \`happys edison --stack=${stack} -- <edison ...>\`\n` +
        `- Evidence: \`happys edison --stack=${stack} -- evidence capture ${trackTaskId}\`\n`;

      const trackRes = await ensureTaskFile({ rootDir, taskId: trackTaskId, frontmatter: trackFm, body: trackBody, state: 'todo' });
      createdTasks.push({ id: trackTaskId, kind: 'track', stack, path: trackRes.path, created: trackRes.created });

      const stackExists = Array.isArray(stacks) && stacks.some((s) => String(s?.name ?? '') === stack);
      if (!stackExists) {
        await run('node', ['./bin/happys.mjs', 'stack', 'new', stack, '--json'], { cwd: rootDir });
        createdStacks.push({ stack });
        stacks.push({ name: stack });
      }

      const qaRes = await ensureQaFile({
        rootDir,
        taskId: trackTaskId,
        title: `QA: ${trackTitle}`,
        frontmatterExtra: { track, stack, components },
      });
      createdQas.push({ id: `${trackTaskId}-qa`, path: qaRes.path, created: qaRes.created });

      for (const c of components) {
        const existingComp = tasks.find((t) => {
          if (!String(t.id).startsWith(`${trackTaskId}.`)) return false;
          const k = String(t.fm?.hs_kind ?? '').trim().toLowerCase();
          if (k !== 'component') return false;
          const tn = String(t.fm?.track ?? '').trim();
          const st = String(t.fm?.stack ?? '').trim();
          const comp = String(t.fm?.component ?? '').trim();
          return tn === track && st === stack && comp === c;
        });

        const compTaskId = existingComp?.id || nextChildId(trackTaskId, existingIds);
        existingIds.add(compTaskId);
        const compTitle = `Component: ${c} (${track})`;
        const baseWorktree = String(existingComp?.fm?.base_worktree ?? '').trim() || `edison/${compTaskId}`;
        const compFm = {
          id: compTaskId,
          title: compTitle,
          hs_kind: 'component',
          track,
          stack,
          base_task: taskId,
          base_worktree: baseWorktree,
          components: [c],
          component: c,
          relationships: [{ type: 'parent', target: trackTaskId }],
        };
        const compBody =
          `# ${compTitle}\n\n` +
          `## Scope\n\n` +
          `- Parent feature: ${taskId}\n` +
          `- Track task: ${trackTaskId}\n` +
          `- Stack: ${stack}\n` +
          `- Component: ${c}\n\n` +
          `## Commands (MANDATORY)\n\n` +
          `- Run inside stack context: \`happys edison --stack=${stack} -- <edison ...>\`\n` +
          `- Evidence: \`happys edison --stack=${stack} -- evidence capture ${compTaskId}\`\n`;

        const compRes = await ensureTaskFile({ rootDir, taskId: compTaskId, frontmatter: compFm, body: compBody, state: 'todo' });
        createdTasks.push({ id: compTaskId, kind: 'component', component: c, stack, path: compRes.path, created: compRes.created });

        const qa2 = await ensureQaFile({
          rootDir,
          taskId: compTaskId,
          title: `QA: ${compTitle}`,
          frontmatterExtra: { track, stack, components: [c], component: c },
        });
        createdQas.push({ id: `${compTaskId}-qa`, path: qa2.path, created: qa2.created });

        const from = track === 'fork' ? 'origin' : 'upstream';
        const stdout = await runCapture(
          'node',
          ['./bin/happys.mjs', 'wt', 'new', c, baseWorktree, `--from=${from}`, '--json'],
          { cwd: rootDir }
        );
        const res = JSON.parse(stdout);
        createdWorktrees.push({ component: c, variant: from, taskId: compTaskId, path: res.path, branch: res.branch });
        await run('node', ['./bin/happys.mjs', 'stack', 'wt', stack, '--', 'use', c, res.path, '--json'], { cwd: rootDir });
        pinned.push({ stack, component: c, taskId: compTaskId, path: res.path });
      }
    }
  } else {
    const stack = (kv.get('--stack') ?? '').trim() || stackFromTask;
    if (!stack) {
      throw new Error(`[edison] missing task stack in frontmatter.\nFix: edit ${mdPath} and set:\n  stack: <name>`);
    }
    if (!components.length) {
      throw new Error(`[edison] missing task components in frontmatter.\nFix: edit ${mdPath} and set:\n  components:\n    - happy\n(or set component: happy for hs_kind=component)`);
    }

    const stackExists = Array.isArray(stacks) && stacks.some((s) => String(s?.name ?? '') === stack);
    if (!stackExists) {
      if (!yes) {
        throw new Error(
          `[edison] stack "${stack}" does not exist.\n` +
            `Fix:\n` +
            `  happys stack new ${stack} --interactive\n` +
            `Or re-run non-interactively with --yes:\n` +
            `  happys edison task:scaffold ${taskId} --yes\n`
        );
      }
      await run('node', ['./bin/happys.mjs', 'stack', 'new', stack, '--json'], { cwd: rootDir });
      createdStacks.push({ stack });
    }

    for (const c of components) {
      const baseWorktree = `edison/${taskId}`;
      const from = mode === 'fork' ? 'origin' : 'upstream';
      const stdout = await runCapture(
        'node',
        ['./bin/happys.mjs', 'wt', 'new', c, baseWorktree, `--from=${from}`, '--json'],
        { cwd: rootDir }
      );
      const res = JSON.parse(stdout);
      createdWorktrees.push({ component: c, variant: from, taskId, path: res.path, branch: res.branch });
      await run('node', ['./bin/happys.mjs', 'stack', 'wt', stack, '--', 'use', c, res.path, '--json'], { cwd: rootDir });
      pinned.push({ stack, component: c, taskId, path: res.path });
    }
  }

  printResult({
    json,
    data: {
      ok: true,
      taskId,
      hsKind,
      mode,
      trackNames,
      createdStacks,
      createdTasks,
      createdQas,
      createdWorktrees,
      pinned,
    },
    text: [
      `[edison] scaffold ok: ${taskId}`,
      `- hs_kind: ${hsKind}`,
      `- mode: ${mode}`,
      hsKind === 'parent' ? `- tracks: ${trackNames.join(', ')}` : '',
      `- created stacks: ${createdStacks.length}`,
      `- created tasks: ${createdTasks.filter((t) => t.created).length} (total touched: ${createdTasks.length})`,
      `- pinned stack worktrees: ${pinned.length}`,
      '',
      'next:',
      hsKind === 'parent' ? `- claim a TRACK or COMPONENT task (parent tasks are not claimable).` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  });
}

async function ensureSymlink({ linkPath, targetPath }) {
  try {
    const st = await lstat(linkPath);
    if (st.isSymbolicLink()) {
      return { ok: true, skipped: true, reason: 'already_symlink' };
    }
    return { ok: false, skipped: false, reason: 'exists_not_symlink' };
  } catch {
    // missing
  }
  await mkdir(join(linkPath, '..'), { recursive: true }).catch(() => {});
  await symlink(targetPath, linkPath);
  return { ok: true, skipped: false, reason: 'created' };
}

async function cmdMetaInit({ rootDir, json }) {
  // Historical note: earlier versions used a git worktree under `.worktrees/_meta` plus symlinks.
  // The recommended approach now is to keep Edison/tooling state directly in the repo root
  // (and rely on gitignore + npmignore for cleanliness).
  //
  // This command is kept as an idempotent "make sure directories exist" helper.
  const dirs = [
    '.claude',
    '.cursor',
    '.edison',
    '.edison/config',
    '.edison/packs',
    '.edison/agents',
    '.edison/constitutions',
    '.edison/guidelines',
    '.edison/validators',
    '.edison/scripts',
    '.edison/_generated',
    '.project',
    '.project/tasks',
    '.project/qa',
    '.project/sessions',
    '.project/logs',
    '.project/archive',
    '.project/plans',
  ];

  const results = [];
  for (const rel of dirs) {
    const abs = join(rootDir, rel);
    // eslint-disable-next-line no-await-in-loop
    await mkdir(abs, { recursive: true });
    results.push({ path: rel, ok: true });
  }

  // If a legacy `.worktrees/_meta` exists (non-git worktree), keep it as a backup dir by renaming.
  const legacyMeta = join(rootDir, '.worktrees', '_meta');
  try {
    const st = await lstat(legacyMeta);
    if (st.isDirectory()) {
      const backup = join(rootDir, '.worktrees', `_meta_backup_${Date.now()}`);
      await mkdir(join(rootDir, '.worktrees'), { recursive: true });
      await rename(legacyMeta, backup);
      results.push({ path: '.worktrees/_meta', ok: true, movedTo: backup });
    }
  } catch {
    // ignore
  }

  printResult({
    json,
    data: { ok: true, results },
    text: [
      '[edison] meta init: ok',
      ...results.map((r) => `- ✅ ${r.path}${r.movedTo ? ` (moved to ${r.movedTo})` : ''}`),
    ].join('\n'),
  });
}

function truncateLines(raw, maxLines) {
  const n = Number(maxLines);
  if (!Number.isFinite(n) || n <= 0) return String(raw ?? '');
  const lines = String(raw ?? '').split('\n');
  if (lines.length <= n) return String(raw ?? '');
  return `${lines.slice(0, n).join('\n')}\n… (${lines.length - n} more lines truncated)`;
}

async function listTaskFilesAll({ rootDir }) {
  const out = await listTaskFiles({ rootDir });
  const taskStates = ['todo', 'wip', 'done', 'validated', 'blocked'];
  const sessionsRoot = join(rootDir, '.project', 'sessions');
  try {
    const sessStates = await readdir(sessionsRoot, { withFileTypes: true });
    for (const s of sessStates) {
      if (!s.isDirectory()) continue;
      const sessStateDir = join(sessionsRoot, s.name);
      // eslint-disable-next-line no-await-in-loop
      const sessIds = await readdir(sessStateDir, { withFileTypes: true }).catch(() => []);
      for (const sid of sessIds) {
        if (!sid.isDirectory()) continue;
        const base = join(sessStateDir, sid.name, 'tasks');
        for (const st of taskStates) {
          const dir = join(base, st);
          // eslint-disable-next-line no-await-in-loop
          if (!(await pathExists(dir))) continue;
          // eslint-disable-next-line no-await-in-loop
          const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
          for (const e of entries) {
            if (!e.isFile()) continue;
            if (!e.name.endsWith('.md')) continue;
            out.push({ id: e.name.slice(0, -3), path: join(dir, e.name) });
          }
        }
      }
    }
  } catch {
    // ignore
  }
  return out;
}

async function scanTasksAll({ rootDir }) {
  const files = await listTaskFilesAll({ rootDir });
  const tasks = [];
  for (const f of files) {
    // eslint-disable-next-line no-await-in-loop
    const text = await readFile(f.path, 'utf-8').catch(() => '');
    const { fm } = parseFrontmatter(text);
    tasks.push({ id: f.id, path: f.path, fm });
  }
  return tasks;
}

async function gitCapture({ cwd, args }) {
  return (await runCapture('git', args, { cwd })).toString();
}

async function gitOk({ cwd }) {
  try {
    const out = await gitCapture({ cwd, args: ['rev-parse', '--is-inside-work-tree'] });
    return out.trim() === 'true';
  } catch {
    return false;
  }
}

async function gitHead({ cwd }) {
  return (await gitCapture({ cwd, args: ['rev-parse', 'HEAD'] })).trim();
}

async function gitHasObject({ cwd, sha }) {
  try {
    await gitCapture({ cwd, args: ['cat-file', '-e', `${sha}^{commit}`] });
    return true;
  } catch {
    return false;
  }
}

async function gitMergeBase({ cwd, left, right }) {
  try {
    return (await gitCapture({ cwd, args: ['merge-base', left, right] })).trim();
  } catch {
    return '';
  }
}

function parseLeftRightLog(raw) {
  const missing = [];
  const extra = [];
  for (const line of String(raw || '').split('\n')) {
    if (!line.trim()) continue;
    const trimmed = line.trimStart();
    if (trimmed.startsWith('<')) missing.push(trimmed);
    else if (trimmed.startsWith('>')) extra.push(trimmed);
  }
  return { missing, extra };
}

function resolveComponentDirFromStackEnv({ rootDir, stackEnv, component }) {
  const idx = COMPONENTS.indexOf(component);
  if (idx < 0) return '';
  const dirs = resolveComponentDirsFromStackEnv({ rootDir, stackEnv });
  return String(dirs[idx] ?? '').trim();
}

async function resolveTargetComponentsForTask({ rootDir, taskId }) {
  const id = String(taskId ?? '').trim();
  if (!id) return [];
  const mdPath = await resolveTaskFilePath({ rootDir, taskId: id });
  if (!mdPath) return [];
  const fm = await readFrontmatterFile(mdPath);
  const hsKind = String(fm?.hs_kind ?? '').trim().toLowerCase();

  const readComponents = (v) => {
    if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
    if (typeof v === 'string') return v.split(',').map((p) => p.trim()).filter(Boolean);
    return [];
  };

  if (hsKind === 'component') {
    const c = String(fm?.component ?? '').trim();
    const comps = c ? [c] : readComponents(fm?.components);
    return comps;
  }

  // Track/parent: can declare multiple components.
  return readComponents(fm?.components);
}

async function resolveFingerprintGitRoots({ rootDir, stackEnv, edisonArgs }) {
  // Default: include only the stack's component repos (never include the happy-local orchestration repo).
  const fallback = resolveComponentDirsFromStackEnv({ rootDir, stackEnv }).filter(Boolean);

  const taskId = await inferTaskIdFromArgs({ rootDir, edisonArgs });
  if (!taskId) return fallback;

  const targets = await resolveTargetComponentsForTask({ rootDir, taskId });
  if (!targets.length) return fallback;

  const dirs = [];
  for (const c of targets) {
    // Allow tasks to explicitly target the orchestration repo (happy-local) by declaring it.
    // Otherwise, keep happy-local out of evidence fingerprints to avoid invalidating evidence
    // when editing wrapper scripts/docs unrelated to the component task under review.
    if (c === 'happy-local' || c === 'happy-stacks' || c === 'happy_local' || c === 'happyStacks') {
      dirs.push(rootDir);
      continue;
    }
    const d = resolveComponentDirFromStackEnv({ rootDir, stackEnv, component: c });
    if (d) dirs.push(d);
  }
  return dirs.length ? dirs : fallback;
}

async function cmdTrackCoherence({ rootDir, argv, json }) {
  const { flags, kv } = parseArgs(argv);
  const positionals = argv.filter((a) => !a.startsWith('--'));
  const taskId = positionals[1]?.trim?.() ? positionals[1].trim() : '';
  if (!taskId) {
    throw new Error(
      '[edison] usage: happys edison track:coherence <task-id> [--source=upstream] [--targets=fork,integration] [--max-lines=120] [--fail-on-extra] [--enforce] [--json]'
    );
  }

  const source = (kv.get('--source') ?? '').toString().trim() || 'upstream';
  const targetsRaw = (kv.get('--targets') ?? '').toString().trim();
  const maxLinesRaw = (kv.get('--max-lines') ?? '').toString().trim();
  const maxLines = maxLinesRaw ? Number(maxLinesRaw) : 120;
  const failOnExtra = flags.has('--fail-on-extra');
  const enforce =
    flags.has('--enforce') || (process.env.HAPPY_STACKS_TRACK_COHERENCE_ENFORCE ?? '').toString().trim() === '1';
  const includeDiff = !flags.has('--no-diff');

  const mdPath = await resolveTaskFilePath({ rootDir, taskId });
  if (!mdPath) {
    throw new Error(`[edison] task not found: ${taskId}`);
  }
  const fm = await readFrontmatterFile(mdPath);
  const hsKind = String(fm?.hs_kind ?? '').trim().toLowerCase();
  if (!hsKind || !['parent', 'track', 'component'].includes(hsKind)) {
    throw new Error(`[edison] missing/invalid hs_kind in task frontmatter (task=${taskId})`);
  }

  const baseTask = String(fm?.base_task ?? '').trim() || (hsKind === 'parent' ? taskId : '');
  if (!baseTask) {
    throw new Error(`[edison] missing base_task in task frontmatter (task=${taskId}).`);
  }

  const tasks = await scanTasksAll({ rootDir });
  const trackTasks = tasks
    .filter((t) => String(t.fm?.hs_kind ?? '').trim().toLowerCase() === 'track')
    .filter((t) => String(t.fm?.base_task ?? '').trim() === baseTask);

  const trackMap = new Map();
  for (const t of trackTasks) {
    const track = String(t.fm?.track ?? '').trim();
    const stack = String(t.fm?.stack ?? '').trim();
    if (!track || !stack) continue;
    trackMap.set(track, { taskId: t.id, stack, fm: t.fm });
  }

  const sourceTrack = trackMap.get(source);
  if (!sourceTrack) {
    printResult({
      json,
      data: { ok: true, skipped: true, reason: 'missing_source_track', source, baseTask, taskId },
      text: `[edison] track:coherence: SKIP (no "${source}" track found for base_task=${baseTask})`,
    });
    return;
  }

  const targetTracks = targetsRaw
    ? targetsRaw.split(',').map((p) => p.trim()).filter(Boolean)
    : Array.from(trackMap.keys()).filter((t) => t !== source);

  if (!targetTracks.length) {
    printResult({
      json,
      data: { ok: true, skipped: true, reason: 'no_targets', source, baseTask, taskId },
      text: `[edison] track:coherence: SKIP (no target tracks to compare; base_task=${baseTask})`,
    });
    return;
  }

  const components = resolveComponentsFromFrontmatter(fm);
  const compsToCheck = hsKind === 'component' ? components.slice(0, 1) : components;
  if (!compsToCheck.length) {
    throw new Error(`[edison] track:coherence: missing components/component in task frontmatter (task=${taskId})`);
  }

  const sourceEnvPath = resolveStackEnvPath(sourceTrack.stack).envPath;
  const sourceEnvRaw = await readExistingEnv(sourceEnvPath);
  if (!sourceEnvRaw.trim()) {
    throw new Error(
      `[edison] track:coherence: source stack env missing/empty for stack="${sourceTrack.stack}" (expected ${sourceEnvPath})`
    );
  }
  const sourceEnv = parseEnvToObject(sourceEnvRaw);

  const results = [];
  const failures = [];

  for (const targetName of targetTracks) {
    const targetTrack = trackMap.get(targetName);
    if (!targetTrack) continue;

    const targetEnvPath = resolveStackEnvPath(targetTrack.stack).envPath;
    const targetEnvRaw = await readExistingEnv(targetEnvPath);
    if (!targetEnvRaw.trim()) {
      failures.push({
        kind: 'missing_stack_env',
        target: targetName,
        stack: targetTrack.stack,
        envPath: targetEnvPath,
      });
      continue;
    }
    const targetEnv = parseEnvToObject(targetEnvRaw);

    for (const comp of compsToCheck) {
      const a = resolveComponentDirFromStackEnv({ rootDir, stackEnv: sourceEnv, component: comp });
      const b = resolveComponentDirFromStackEnv({ rootDir, stackEnv: targetEnv, component: comp });
      if (!a || !b) {
        failures.push({ kind: 'missing_component_dir', component: comp, source, target: targetName });
        continue;
      }
      const aIsRepo = await gitOk({ cwd: a });
      const bIsRepo = await gitOk({ cwd: b });
      if (!aIsRepo || !bIsRepo) {
        failures.push({
          kind: 'not_git_repo',
          component: comp,
          source,
          target: targetName,
          sourceDir: a,
          targetDir: b,
        });
        continue;
      }

      const shaA = await gitHead({ cwd: a });
      const shaB = await gitHead({ cwd: b });

      // Ensure both SHAs are visible from the repo's object database (worktrees should share it).
      const aHasB = await gitHasObject({ cwd: a, sha: shaB });
      const bHasA = await gitHasObject({ cwd: b, sha: shaA });
      if (!aHasB && !bHasA) {
        failures.push({
          kind: 'missing_git_objects',
          component: comp,
          source,
          target: targetName,
          sourceDir: a,
          targetDir: b,
          sourceHead: shaA,
          targetHead: shaB,
        });
        continue;
      }

      // Prefer running comparisons from the side that can see both objects.
      const compareCwd = aHasB ? a : b;
      const left = shaA;
      const right = shaB;

      let logOut = '';
      try {
        logOut = await gitCapture({
          cwd: compareCwd,
          args: ['log', '--left-right', '--cherry-pick', '--no-merges', '--oneline', `${left}...${right}`],
        });
      } catch (e) {
        failures.push({
          kind: 'git_log_failed',
          component: comp,
          source,
          target: targetName,
          err: String(e?.message ?? e),
        });
        continue;
      }

      const { missing, extra } = parseLeftRightLog(logOut);

      let diffShortstat = '';
      let diffNameStatus = '';
      let mergeBase = '';
      let rangeDiff = '';
      if (includeDiff) {
        try {
          diffShortstat = (await gitCapture({ cwd: compareCwd, args: ['diff', '--shortstat', `${left}..${right}`] })).trim();
        } catch {
          diffShortstat = '';
        }
        try {
          diffNameStatus = truncateLines(
            await gitCapture({ cwd: compareCwd, args: ['diff', '--name-status', `${left}..${right}`] }),
            maxLines
          ).trim();
        } catch {
          diffNameStatus = '';
        }
        mergeBase = await gitMergeBase({ cwd: compareCwd, left, right });
        if (mergeBase) {
          try {
            rangeDiff = truncateLines(
              await gitCapture({ cwd: compareCwd, args: ['range-diff', `${mergeBase}..${left}`, `${mergeBase}..${right}`] }),
              maxLines
            ).trim();
          } catch {
            rangeDiff = '';
          }
        }
      }

      const entry = {
        component: comp,
        source,
        target: targetName,
        sourceStack: sourceTrack.stack,
        targetStack: targetTrack.stack,
        sourceDir: a,
        targetDir: b,
        sourceHead: shaA,
        targetHead: shaB,
        missing,
        extra,
        diffShortstat,
        diffNameStatus,
        mergeBase,
        rangeDiff,
      };
      results.push(entry);

      if (missing.length) {
        failures.push({
          kind: 'missing_patches',
          component: comp,
          source,
          target: targetName,
          missingCount: missing.length,
        });
      }
      if (failOnExtra && extra.length) {
        failures.push({
          kind: 'extra_patches',
          component: comp,
          source,
          target: targetName,
          extraCount: extra.length,
        });
      }
    }
  }

  const ok = failures.length === 0;
  const lines = [];
  lines.push(`[edison] track:coherence (${baseTask})`);
  lines.push(`- task: ${taskId} (hs_kind=${hsKind})`);
  lines.push(`- source: ${source} (stack=${sourceTrack.stack})`);
  lines.push(`- targets: ${targetTracks.join(', ')}`);
  lines.push(`- components: ${compsToCheck.join(', ')}`);
  lines.push(`- include diff: ${includeDiff ? 'yes' : 'no'}`);
  lines.push('');

  for (const r of results) {
    const aWt = String(r.sourceDir).includes('/components/.worktrees/');
    const bWt = String(r.targetDir).includes('/components/.worktrees/');
    lines.push(`component: ${r.component}  (${r.source} → ${r.target})`);
    lines.push(`- source stack: ${r.sourceStack}`);
    lines.push(`- target stack: ${r.targetStack}`);
    lines.push(`- source dir: ${r.sourceDir}${aWt ? '' : '   (WARNING: not a worktree path)'}`);
    lines.push(`- target dir: ${r.targetDir}${bWt ? '' : '   (WARNING: not a worktree path)'}`);
    if (r.diffShortstat) lines.push(`- diff: ${r.diffShortstat}`);
    if (r.diffNameStatus) {
      lines.push('- diff (name-status):');
      for (const ln of String(r.diffNameStatus).split('\n')) lines.push(`  ${ln}`);
    }
    if (r.mergeBase && r.rangeDiff) {
      lines.push(`- merge-base: ${r.mergeBase}`);
      lines.push('- range-diff:');
      for (const ln of String(r.rangeDiff).split('\n')) lines.push(`  ${ln}`);
    }
    lines.push(`- missing patches: ${r.missing.length}`);
    if (r.missing.length) {
      for (const m of r.missing.slice(0, maxLines)) lines.push(`  ${m}`);
      if (r.missing.length > maxLines) lines.push(`  … (${r.missing.length - maxLines} more missing truncated)`);
    }
    lines.push(`- extra patches: ${r.extra.length}${failOnExtra ? ' (FAIL-ON-EXTRA enabled)' : ''}`);
    if (r.extra.length) {
      for (const ex of r.extra.slice(0, maxLines)) lines.push(`  ${ex}`);
      if (r.extra.length > maxLines) lines.push(`  … (${r.extra.length - maxLines} more extra truncated)`);
      if (!failOnExtra) lines.push('  note: extra patches are allowed by default; use --fail-on-extra to make them fatal.');
    }
    lines.push('');
  }

  if (!ok) {
    lines.push('FAILURES:');
    for (const f of failures) {
      lines.push(`- ${f.kind}: ${JSON.stringify(f)}`);
    }
    lines.push('');
    lines.push('tips:');
    lines.push('- ensure you created both tracks via: happys edison task:scaffold <parent-task-id> --mode=both --yes');
    lines.push('- ensure stacks point at the intended worktrees: happys stack wt <stack> -- status');
    lines.push('- if git objects are missing, sync mirrors: happys wt sync-all');
  }

  printResult({
    json,
    data: {
      ok,
      baseTask,
      taskId,
      source,
      targets: targetTracks,
      results,
      failures,
      failOnExtra,
      includeDiff,
      maxLines,
    },
    text: lines.join('\n'),
  });

  if (!ok && enforce) process.exit(1);
}

async function main() {
  const rootDir = getRootDir(import.meta.url);
  const argvRaw = process.argv.slice(2);
  const argv = argvRaw[0] === '--' ? argvRaw.slice(1) : argvRaw;
  const { flags, kv } = parseArgs(argv);
  const json = wantsJson(argv, { flags });

  if (wantsHelp(argv, { flags })) {
    printResult({
      json,
      data: { flags: ['--stack=<name>', '--json'], examples: true },
      text: [
        '[edison] usage:',
        '  happys edison [--stack=<name>] -- <edison args...>',
        '  happys edison meta:init [--json]',
        '  happys edison task:scaffold <task-id> [--mode=upstream|fork|both] [--tracks=upstream,fork] [--yes] [--json]',
        '  happys edison track:coherence <task-id> [--source=upstream] [--targets=fork,integration] [--max-lines=120] [--fail-on-extra] [--enforce] [--no-diff] [--json]',
        '',
        'examples:',
        '  happys edison -- compose all',
        '  happys edison --stack=exp1 -- evidence capture T-123',
        '  happys edison task:scaffold T-123 --yes',
        '  happys edison track:coherence T-123.1 --json',
        '  happys edison meta:init',
        '',
        'notes:',
        '- When --stack is provided, this wrapper:',
        '  - exports HAPPY_STACKS_ENV_FILE + HAPPY_STACKS_STACK for stack-scoped commands',
        '  - configures Edison evidence fingerprinting to include the stack’s resolved component repos',
        '',
        'happy-stacks task model (MANDATORY):',
        '- hs_kind=parent is a planning umbrella (NOT claimable)',
        '- hs_kind=track owns exactly one stack (one stack per track)',
        '- hs_kind=component implements exactly one component under a track',
      ].join('\n'),
    });
    return;
  }

  // One-time setup helper for this repo: keep Edison/tool state in `.worktrees/_meta` via symlinks,
  // without using git worktrees.
  if (argv[0] === 'meta:init') {
    await cmdMetaInit({ rootDir, json });
    return;
  }
  if (argv[0] === 'task:scaffold') {
    await cmdTaskScaffold({ rootDir, argv, json });
    return;
  }
  if (argv[0] === 'track:coherence') {
    await cmdTrackCoherence({ rootDir, argv, json });
    return;
  }

  const stackFlag = (kv.get('--stack') ?? '').toString().trim();
  // Back-compat: older parseArgs implementations used `kv.stack`; keep it if present.
  const legacyStackFlag = (kv.stack ?? '').toString().trim();
  let stackName = stackFlag || legacyStackFlag || (process.env.HAPPY_STACKS_STACK ?? '').toString().trim();

  let env = { ...process.env };
  // If no stack was provided, best-effort infer it from a task/QA id passed to the command.
  // This allows `happys edison -- evidence capture <task-id>` (no explicit --stack) to be stack-scoped automatically.
  if (!stackName) {
    const inferred = await inferStackFromArgs({ rootDir, edisonArgs: argv.filter((a) => a !== '--') });
    if (inferred) stackName = inferred;
  }
  if (stackName) {
    const { envPath } = resolveStackEnvPath(stackName);
    const raw = await readExistingEnv(envPath);
    if (!raw.trim()) {
      throw new Error(
        `[edison] stack "${stackName}" inferred/provided but env file is missing/empty.\n` +
          `Fix:\n` +
          `  happys stack new ${stackName} --interactive\n`
      );
    }
    const stackEnv = parseEnvToObject(raw);

    const cleaned = cleanHappyStacksEnv(env);
    env = {
      ...cleaned,
      // IMPORTANT: stack env file must be authoritative.
      // Export its full contents so Edison/guards/evidence runs are fail-closed and stack-scoped.
      ...stackEnv,
      HAPPY_STACKS_STACK: stackName,
      HAPPY_STACKS_ENV_FILE: envPath,
      HAPPY_LOCAL_STACK: stackName,
      HAPPY_LOCAL_ENV_FILE: envPath,
      // Marker for Edison-core wrapper enforcement in this repo.
      HAPPY_STACKS_EDISON_WRAPPER: '1',
    };

    // Sandbox-safe Codex home:
    // In some validator environments, writes to $HOME (e.g. /Users/<user>/.codex/...) are denied.
    // Keep Codex session state inside the workspace so `global-codex` can execute.
    if (!env.CODEX_HOME) {
      const codexHome = join(rootDir, '.edison', '_tmp', 'codex-home', stackName);
      env.CODEX_HOME = codexHome;
      try {
        await mkdir(codexHome, { recursive: true });
        // Preserve existing Codex credentials/config (if any) so codex can run with the same credentials
        // while using a writable CODEX_HOME.
        //
        // IMPORTANT:
        // - Do not read or log file contents (may contain secrets).
        // - Best-effort only; if unauthenticated, codex will surface a clear error.
        const srcDir = join(homedir(), '.codex');
        try {
          const candidates = ['config.toml', 'config.json', 'auth.json', 'auth.json.bak'];
          for (const name of candidates) {
            const src = join(srcDir, name);
            const dst = join(codexHome, name);
            // eslint-disable-next-line no-await-in-loop
            if ((await pathExists(src)) && !(await pathExists(dst))) {
              // eslint-disable-next-line no-await-in-loop
              await copyFile(src, dst);
            }
          }
        } catch {
          // ignore auth seeding failures (codex will surface a clear error if unauthenticated)
        }
      } catch {
        // best-effort: codex will surface a clearer error if this path is still unwritable
      }
    }

    // We intentionally DO NOT include the happy-local repo root in evidence fingerprints by default.
    // Fingerprints should reflect only the task's target component repos (happy/happy-cli/etc).
    const componentDirs = resolveComponentDirsFromStackEnv({ rootDir, stackEnv });

    if (!json) {
      const pretty = COMPONENTS.map((name, i) => {
        const p = componentDirs[i];
        const isWt = String(p).includes('/components/.worktrees/');
        return `  - ${name}: ${p}${isWt ? '' : '   (WARNING: not a worktree path)'}`;
      });
      // eslint-disable-next-line no-console
      console.log(
        [
          `[edison] stack=${stackName} (stack-scoped)`,
          '[edison] IMPORTANT:',
          '- never edit default checkouts under components/<component>',
          '- always run inside the stack context + component worktrees',
          '- task model: parent (planning) -> track (owns 1 stack) -> component (owns 1 component)',
          '[edison] component dirs (from stack env):',
          ...pretty,
        ].join('\n')
      );
    }
  }
  // Marker for Edison-core wrapper enforcement in this repo (ensure it survives any env merges).
  env.HAPPY_STACKS_EDISON_WRAPPER = '1';
  // Provide a stack-scoped localhost hostname for validators and browser flows.
  // This ensures origin isolation even if ports are reused later (common with ephemeral ports).
  const localhostHost = resolveLocalhostHost({ stackMode: Boolean(stackName), stackName: stackName || 'main' });
  env.HAPPY_STACKS_LOCALHOST_HOST = localhostHost;
  env.HAPPY_LOCAL_LOCALHOST_HOST = localhostHost;

  // Forward all args to `edison`.
  //
  // IMPORTANT: Edison CLI does not accept `--repo-root` as a global flag (it is a per-command flag),
  // so we MUST NOT prepend `--repo-root <rootDir>` ahead of the domain.
  //
  // Instead, set AGENTS_PROJECT_ROOT so Edison resolves the correct repo root automatically.
  // Do not forward wrapper flags (e.g. --stack=...) to the Python `edison` CLI.
  const forward = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') continue;
    // Wrapper-only stack flag (both forms). Never forward to Python edison.
    if (a === '--stack') {
      i += 1; // skip the value
      continue;
    }
    if (a.startsWith('--stack=')) continue;
    forward.push(a);
  }
  env.AGENTS_PROJECT_ROOT = env.AGENTS_PROJECT_ROOT || rootDir;
  const edisonArgs = forward;

  // Configure Edison evidence fingerprinting to include ONLY repos the task targets (not happy-local itself).
  // This prevents unrelated changes in happy-local scripts/docs from invalidating command evidence
  // for tasks that target component repos (happy, happy-cli, etc).
  if (stackName) {
    const { envPath } = resolveStackEnvPath(stackName);
    const raw = await readExistingEnv(envPath);
    const stackEnv = parseEnvToObject(raw);

    const roots = await resolveFingerprintGitRoots({ rootDir, stackEnv, edisonArgs });
    env.EDISON_CI__FINGERPRINT__GIT_ROOTS = JSON.stringify(roots);
    // Stack env file still matters for stack-scoped commands (component dir overrides, server URLs, etc).
    env.EDISON_CI__FINGERPRINT__EXTRA_FILES = JSON.stringify([envPath]);
  }

  // Best-effort: if `edison` is not installed, print a helpful message.
  try {
    // eslint-disable-next-line no-console
    if (stackName && !json) console.log(`[edison] stack=${stackName}`);
    if (stackName) {
      await ensureStackServerPortForWebServerValidation({ rootDir, stackName, env, edisonArgs, json });
    }
    if (!(await pathExists(rootDir))) {
      throw new Error(`[edison] missing repo root: ${rootDir}`);
    }
    await run('edison', edisonArgs, { cwd: rootDir, env });
  } catch (e) {
    const msg = String(e?.message ?? e);
    const hint = msg.includes('ENOENT') || msg.toLowerCase().includes('not found')
      ? '\n[edison] tip: install edison (alpha) in your environment, or run it via your local dev checkout.\n'
      : '';
    printResult({ json, data: { ok: false, error: msg }, text: `[edison] failed: ${msg}${hint}` });
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[edison] failed:', err);
  process.exit(1);
});

