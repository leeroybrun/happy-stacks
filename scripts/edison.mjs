import './utils/env.mjs';
import { parseArgs } from './utils/args.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli.mjs';
import { resolveStackEnvPath, getComponentDir, getRootDir } from './utils/paths.mjs';
import { parseDotenv } from './utils/dotenv.mjs';
import { pathExists } from './utils/fs.mjs';
import { run, runCapture } from './utils/proc.mjs';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { mkdir, lstat, rename, symlink, writeFile, readdir } from 'node:fs/promises';

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
    stacks = JSON.parse(stacksJson || '[]');
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
        '',
        'examples:',
        '  happys edison -- compose all',
        '  happys edison --stack=exp1 -- evidence capture T-123',
        '  happys edison task:scaffold T-123 --yes',
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

  let stackName = (kv.stack ?? '').toString().trim() || (process.env.HAPPY_STACKS_STACK ?? '').toString().trim();

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

    // Configure Edison multi-repo evidence fingerprinting to include the actual component dirs
    // this stack points at (worktrees or defaults), plus the stack env file itself.
    const componentDirs = resolveComponentDirsFromStackEnv({ rootDir, stackEnv });
    const roots = [rootDir, ...componentDirs];
    env.EDISON_CI__FINGERPRINT__GIT_ROOTS = JSON.stringify(roots);
    env.EDISON_CI__FINGERPRINT__EXTRA_FILES = JSON.stringify([envPath]);

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

  // Forward all args to `edison`.
  //
  // IMPORTANT: Edison CLI does not accept `--repo-root` as a global flag (it is a per-command flag),
  // so we MUST NOT prepend `--repo-root <rootDir>` ahead of the domain.
  //
  // Instead, set AGENTS_PROJECT_ROOT so Edison resolves the correct repo root automatically.
  const forward = argv.filter((a) => a !== '--');
  env.AGENTS_PROJECT_ROOT = env.AGENTS_PROJECT_ROOT || rootDir;
  const edisonArgs = forward;

  // Best-effort: if `edison` is not installed, print a helpful message.
  try {
    // eslint-disable-next-line no-console
    if (stackName && !json) console.log(`[edison] stack=${stackName}`);
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

