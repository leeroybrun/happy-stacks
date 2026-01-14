import './utils/env.mjs';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

import { parseDotenv } from './utils/dotenv.mjs';
import { printResult } from './utils/cli.mjs';
import { getRootDir, resolveStackEnvPath } from './utils/paths.mjs';
import { getStackRuntimeStatePath, readStackRuntimeStateFile } from './utils/stack_runtime_state.mjs';

function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return String(s ?? '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

function padRight(s, n) {
  const str = String(s ?? '');
  if (str.length >= n) return str.slice(0, n);
  return str + ' '.repeat(n - str.length);
}

function parsePrefixedLabel(line) {
  const m = String(line ?? '').match(/^\[([^\]]+)\]\s*/);
  return m ? m[1] : null;
}

function nowTs() {
  const d = new Date();
  return d.toISOString().slice(11, 19);
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function mkPane(id, title, { visible = true, kind = 'log' } = {}) {
  return { id, title, kind, visible, lines: [], scroll: 0 };
}

function pushLine(pane, line, { maxLines = 4000 } = {}) {
  pane.lines.push(line);
  if (pane.lines.length > maxLines) {
    pane.lines.splice(0, pane.lines.length - maxLines);
  }
}

function drawBox({ x, y, w, h, title, lines, scroll }) {
  const top = y;
  const bottom = y + h - 1;
  const left = x;
  const horiz = '─'.repeat(Math.max(0, w - 2));
  const t = title ? ` ${title} ` : '';
  const titleStart = Math.max(1, Math.min(w - 2 - t.length, 2));
  const topLine =
    '┌' +
    horiz
      .split('')
      .map((ch, i) => {
        const pos = i + 1;
        if (t && pos >= titleStart && pos < titleStart + t.length) {
          return t[pos - titleStart];
        }
        return ch;
      })
      .join('') +
    '┐';

  const midLine = '│' + ' '.repeat(Math.max(0, w - 2)) + '│';
  const botLine = '└' + horiz + '┘';

  const out = [];
  out.push({ row: top, col: left, text: topLine });
  for (let r = top + 1; r < bottom; r++) {
    out.push({ row: r, col: left, text: midLine });
  }
  out.push({ row: bottom, col: left, text: botLine });

  const innerW = Math.max(0, w - 2);
  const innerH = Math.max(0, h - 2);
  const maxScroll = Math.max(0, lines.length - innerH);
  const s = clamp(scroll, 0, maxScroll);
  const start = Math.max(0, lines.length - innerH - s);
  const slice = lines.slice(start, start + innerH);
  for (let i = 0; i < innerH; i++) {
    const line = stripAnsi(slice[i] ?? '');
    out.push({ row: top + 1 + i, col: left + 1, text: padRight(line, innerW) });
  }

  return { out, maxScroll };
}

function isTuiHelp(argv) {
  if (!argv.length) return true;
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === 'help')) return true;
  return false;
}

function inferStackNameFromForwardedArgs(args) {
  // Primary: stack-scoped usage: `happys tui stack <subcmd> <name> ...`
  const i = args.indexOf('stack');
  if (i >= 0) {
    const name = args[i + 2];
    if (name && !name.startsWith('-')) return name;
  }
  // Fallback: use current environment stack (or main).
  return (process.env.HAPPY_STACKS_STACK ?? process.env.HAPPY_LOCAL_STACK ?? '').trim() || 'main';
}

async function readEnvObject(path) {
  try {
    if (!path || !existsSync(path)) return {};
    const raw = await readFile(path, 'utf-8');
    return Object.fromEntries(parseDotenv(raw).entries());
  } catch {
    return {};
  }
}

function formatComponentRef({ rootDir, component, dir }) {
  const raw = String(dir ?? '').trim();
  if (!raw) return '(unset)';

  const abs = resolve(raw);
  const defaultDir = resolve(join(rootDir, 'components', component));
  const worktreesPrefix = resolve(join(rootDir, 'components', '.worktrees', component)) + sep;

  if (abs === defaultDir) return 'default';
  if (abs.startsWith(worktreesPrefix)) {
    return abs.slice(worktreesPrefix.length);
  }
  return abs;
}

function getEnvVal(env, k1, k2) {
  const a = String(env?.[k1] ?? '').trim();
  if (a) return a;
  return String(env?.[k2] ?? '').trim();
}

async function buildStackSummaryLines({ rootDir, stackName }) {
  const { envPath, baseDir } = resolveStackEnvPath(stackName);
  const env = await readEnvObject(envPath);
  const runtimePath = getStackRuntimeStatePath(stackName);
  const runtime = await readStackRuntimeStateFile(runtimePath);

  const serverComponent =
    getEnvVal(env, 'HAPPY_STACKS_SERVER_COMPONENT', 'HAPPY_LOCAL_SERVER_COMPONENT') || 'happy-server-light';

  const ports = runtime?.ports && typeof runtime.ports === 'object' ? runtime.ports : {};
  const expoWebPort = runtime?.expo && typeof runtime.expo === 'object' ? runtime.expo.webPort : null;
  const processes = runtime?.processes && typeof runtime.processes === 'object' ? runtime.processes : {};

  const components = [
    { key: 'happy', envKey: 'HAPPY_STACKS_COMPONENT_DIR_HAPPY', legacyKey: 'HAPPY_LOCAL_COMPONENT_DIR_HAPPY' },
    { key: 'happy-cli', envKey: 'HAPPY_STACKS_COMPONENT_DIR_HAPPY_CLI', legacyKey: 'HAPPY_LOCAL_COMPONENT_DIR_HAPPY_CLI' },
    {
      key: serverComponent === 'happy-server' ? 'happy-server' : 'happy-server-light',
      envKey:
        serverComponent === 'happy-server'
          ? 'HAPPY_STACKS_COMPONENT_DIR_HAPPY_SERVER'
          : 'HAPPY_STACKS_COMPONENT_DIR_HAPPY_SERVER_LIGHT',
      legacyKey:
        serverComponent === 'happy-server'
          ? 'HAPPY_LOCAL_COMPONENT_DIR_HAPPY_SERVER'
          : 'HAPPY_LOCAL_COMPONENT_DIR_HAPPY_SERVER_LIGHT',
    },
  ];

  const lines = [];
  lines.push(`stack: ${stackName}`);
  lines.push(`server: ${serverComponent}`);
  lines.push(`baseDir: ${baseDir}`);
  lines.push(`env: ${envPath}`);
  lines.push(`runtime: ${runtimePath}${runtime ? '' : ' (missing)'}`);
  if (runtime?.startedAt) lines.push(`startedAt: ${runtime.startedAt}`);
  if (runtime?.updatedAt) lines.push(`updatedAt: ${runtime.updatedAt}`);
  if (runtime?.ownerPid) lines.push(`ownerPid: ${runtime.ownerPid}`);

  lines.push('');
  lines.push('ports:');
  lines.push(`  server: ${ports?.server ?? '(unknown)'}`);
  if (expoWebPort) lines.push(`  ui: ${expoWebPort}`);
  if (ports?.backend) lines.push(`  backend: ${ports.backend}`);

  lines.push('');
  lines.push('pids:');
  if (processes?.serverPid) lines.push(`  serverPid: ${processes.serverPid}`);
  if (processes?.expoWebPid) lines.push(`  expoWebPid: ${processes.expoWebPid}`);
  if (processes?.daemonPid) lines.push(`  daemonPid: ${processes.daemonPid}`);
  if (processes?.uiGatewayPid) lines.push(`  uiGatewayPid: ${processes.uiGatewayPid}`);

  lines.push('');
  lines.push('components:');
  for (const c of components) {
    const dir = getEnvVal(env, c.envKey, c.legacyKey);
    lines.push(`  ${padRight(c.key, 16)} ${formatComponentRef({ rootDir, component: c.key, dir })}`);
  }

  return lines;
}

async function main() {
  const argv = process.argv.slice(2);

  if (isTuiHelp(argv)) {
    printResult({
      json: false,
      data: { usage: 'happys tui <happys args...>', json: false },
      text: [
        '[tui] usage:',
        '  happys tui <happys args...>',
        '',
        'examples:',
        '  happys tui stack dev resume-upstream',
        '  happys tui stack start resume-upstream',
        '  happys tui stack auth dev-auth login',
        '',
        'layouts:',
        '  single  : one pane (focused)',
        '  split   : two panes (left=orchestration, right=focused)',
        '  columns : multiple panes stacked in two columns (toggle visibility per pane)',
        '',
        'keys:',
        '  tab / shift+tab : focus next/prev (visible panes only)',
        '  1..9            : jump to pane index',
        '  v               : cycle layout (single → split → columns)',
        '  m               : toggle focused pane visibility (columns layout)',
        '  c               : clear focused pane',
        '  p               : pause/resume rendering',
        '  ↑/↓, PgUp/PgDn   : scroll focused pane',
        '  Home/End        : jump bottom/top (focused pane)',
        '  q / Ctrl+C      : quit (sends SIGINT to child)',
        '',
        'panes (default):',
        '  orchestration | summary | local | server | ui | daemon | stack logs',
      ].join('\n'),
    });
    return;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('[tui] requires a TTY (interactive terminal)');
  }

  const rootDir = getRootDir(import.meta.url);
  const happysBin = join(rootDir, 'bin', 'happys.mjs');
  const forwarded = argv;

  const stackName = inferStackNameFromForwardedArgs(forwarded);

  const panes = [
    mkPane('orch', 'orchestration', { visible: true, kind: 'log' }),
    mkPane('summary', `stack summary (${stackName})`, { visible: true, kind: 'summary' }),
    mkPane('local', 'local', { visible: true, kind: 'log' }),
    mkPane('server', 'server', { visible: true, kind: 'log' }),
    mkPane('ui', 'ui', { visible: true, kind: 'log' }),
    mkPane('daemon', 'daemon', { visible: true, kind: 'log' }),
    mkPane('stacklog', 'stack logs', { visible: true, kind: 'log' }),
  ];

  const paneIndexById = new Map(panes.map((p, i) => [p.id, i]));

  const routeLine = (line) => {
    const label = parsePrefixedLabel(line);
    const normalized = label ? label.toLowerCase() : '';

    let paneId = 'local';
    if (normalized.includes('server')) paneId = 'server';
    else if (normalized === 'ui') paneId = 'ui';
    else if (normalized.includes('daemon')) paneId = 'daemon';
    else if (normalized === 'stack') paneId = 'stacklog';
    else if (normalized === 'local') paneId = 'local';

    const idx = paneIndexById.get(paneId) ?? paneIndexById.get('local');
    pushLine(panes[idx], line);
  };

  const logOrch = (msg) => {
    pushLine(panes[paneIndexById.get('orch')], `[${nowTs()}] ${msg}`);
  };

  let layout = 'columns'; // single | split | columns
  let focused = 2; // local
  let paused = false;
  let renderScheduled = false;

  const child = spawn(process.execPath, [happysBin, ...forwarded], {
    cwd: rootDir,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });

  logOrch(`spawned: node ${happysBin} ${forwarded.join(' ')} (pid=${child.pid})`);

  const buf = { out: '', err: '' };
  const flush = (kind) => {
    const key = kind === 'stderr' ? 'err' : 'out';
    let b = buf[key];
    while (true) {
      const idx = b.indexOf('\n');
      if (idx < 0) break;
      const line = b.slice(0, idx);
      b = b.slice(idx + 1);
      routeLine(line);
    }
    buf[key] = b;
  };

  child.stdout?.on('data', (d) => {
    buf.out += d.toString();
    flush('stdout');
    scheduleRender();
  });
  child.stderr?.on('data', (d) => {
    buf.err += d.toString();
    flush('stderr');
    scheduleRender();
  });
  child.on('exit', (code, sig) => {
    logOrch(`child exited (code=${code}, sig=${sig ?? 'null'})`);
    scheduleRender();
  });

  async function refreshSummary() {
    const idx = paneIndexById.get('summary');
    try {
      const lines = await buildStackSummaryLines({ rootDir, stackName });
      panes[idx].lines = lines;
    } catch (e) {
      panes[idx].lines = [`summary error: ${e instanceof Error ? e.message : String(e)}`];
    }
    scheduleRender();
  }

  const summaryTimer = setInterval(() => {
    if (!paused) {
      void refreshSummary();
    }
  }, 1000);

  function scheduleRender() {
    if (paused) return;
    if (renderScheduled) return;
    renderScheduled = true;
    setTimeout(() => {
      renderScheduled = false;
      render();
    }, 16);
  }

  function visiblePaneIndexes() {
    return panes
      .map((p, idx) => ({ p, idx }))
      .filter(({ p }) => p.visible)
      .map(({ idx }) => idx);
  }

  function focusNext(delta) {
    const visible = visiblePaneIndexes();
    if (!visible.length) return;
    const pos = Math.max(0, visible.indexOf(focused));
    const next = (pos + delta + visible.length) % visible.length;
    focused = visible[next];
    scheduleRender();
  }

  function scrollFocused(delta) {
    const pane = panes[focused];
    pane.scroll = Math.max(0, pane.scroll + delta);
    scheduleRender();
  }

  function clearFocused() {
    const pane = panes[focused];
    if (pane.kind === 'summary') return;
    pane.lines = [];
    pane.scroll = 0;
    scheduleRender();
  }

  function cycleLayout() {
    layout = layout === 'single' ? 'split' : layout === 'split' ? 'columns' : 'single';
    scheduleRender();
  }

  function toggleFocusedVisibility() {
    if (layout !== 'columns') return;
    const pane = panes[focused];
    if (pane.id === 'orch') return; // always visible
    pane.visible = !pane.visible;
    if (!pane.visible) {
      // Move focus to next visible pane.
      focusNext(+1);
    }
    scheduleRender();
  }

  function render() {
    if (paused) return;
    const cols = process.stdout.columns ?? 120;
    const rows = process.stdout.rows ?? 40;
    process.stdout.write('\x1b[?25l');
    process.stdout.write('\x1b[2J\x1b[H');

    const header = `happys tui | ${forwarded.join(' ')} | layout=${layout} | focus=${panes[focused]?.title ?? focused}`;
    process.stdout.write(padRight(header, cols) + '\n');

    const bodyY = 1;
    const bodyH = rows - 2;
    const footerY = rows - 1;

    const drawWrites = [];
    if (layout === 'single') {
      const pane = panes[focused];
      const box = drawBox({ x: 0, y: bodyY, w: cols, h: bodyH, title: pane.title, lines: pane.lines, scroll: pane.scroll });
      pane.scroll = clamp(pane.scroll, 0, box.maxScroll);
      drawWrites.push(...box.out);
    } else if (layout === 'split') {
      const leftW = Math.floor(cols / 2);
      const rightW = cols - leftW;

      const leftPane = panes[paneIndexById.get('orch')];
      const rightPane = panes[focused === paneIndexById.get('orch') ? paneIndexById.get('local') : focused];

      const leftBox = drawBox({ x: 0, y: bodyY, w: leftW, h: bodyH, title: leftPane.title, lines: leftPane.lines, scroll: leftPane.scroll });
      leftPane.scroll = clamp(leftPane.scroll, 0, leftBox.maxScroll);
      drawWrites.push(...leftBox.out);

      const rightBox = drawBox({ x: leftW, y: bodyY, w: rightW, h: bodyH, title: rightPane.title, lines: rightPane.lines, scroll: rightPane.scroll });
      rightPane.scroll = clamp(rightPane.scroll, 0, rightBox.maxScroll);
      drawWrites.push(...rightBox.out);
    } else {
      // columns: render all visible panes in two columns, stacked.
      const visible = visiblePaneIndexes().map((idx) => panes[idx]);
      const leftW = Math.floor(cols / 2);
      const rightW = cols - leftW;

      const leftPanes = [];
      const rightPanes = [];
      for (let i = 0; i < visible.length; i++) {
        (i % 2 === 0 ? leftPanes : rightPanes).push(visible[i]);
      }

      const layoutColumn = (colX, colW, colPanes) => {
        if (!colPanes.length) return;
        const n = colPanes.length;
        const base = Math.max(3, Math.floor(bodyH / n));
        let y = bodyY;
        for (let i = 0; i < n; i++) {
          const pane = colPanes[i];
          const remaining = bodyY + bodyH - y;
          const h = i === n - 1 ? remaining : Math.min(base, remaining);
          if (h < 3) break;
          const box = drawBox({ x: colX, y, w: colW, h, title: pane.title, lines: pane.lines, scroll: pane.scroll });
          pane.scroll = clamp(pane.scroll, 0, box.maxScroll);
          drawWrites.push(...box.out);
          y += h;
        }
      };

      layoutColumn(0, leftW, leftPanes);
      layoutColumn(leftW, rightW, rightPanes);
    }

    for (const w of drawWrites) {
      process.stdout.write(`\x1b[${w.row + 1};${w.col + 1}H${w.text}`);
    }

    const footer =
      'tab:next  shift+tab:prev  1..9:jump  v:layout  m:toggle-pane  c:clear  p:pause  arrows:scroll  q/Ctrl+C:quit';
    process.stdout.write(`\x1b[${footerY + 1};1H` + padRight(footer, cols));
    process.stdout.write('\x1b[?25h');
  }

  function shutdown() {
    clearInterval(summaryTimer);
    try {
      process.stdin.setRawMode(false);
    } catch {
      // ignore
    }
    try {
      process.stdin.pause();
    } catch {
      // ignore
    }
    try {
      if (child.exitCode == null && child.pid) {
        if (process.platform !== 'win32') process.kill(-child.pid, 'SIGINT');
        else child.kill('SIGINT');
      }
    } catch {
      // ignore
    }
    process.stdout.write('\x1b[2J\x1b[H\x1b[?25h');
  }

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', (d) => {
    const s = d.toString('utf-8');
    if (s === '\u0003' || s === 'q') {
      shutdown();
      process.exit(0);
    }
    if (s === '\t') return focusNext(+1);
    if (s === '\x1b[Z') return focusNext(-1);
    if (s >= '1' && s <= '9') {
      const idx = Number(s) - 1;
      if (idx >= 0 && idx < panes.length) {
        if (panes[idx].visible) {
          focused = idx;
          scheduleRender();
        }
      }
      return;
    }
    if (s === 'v') return cycleLayout();
    if (s === 'm') return toggleFocusedVisibility();
    if (s === 'c') return clearFocused();
    if (s === 'p') {
      paused = !paused;
      if (!paused) {
        void refreshSummary();
        scheduleRender();
      }
      return;
    }

    if (s === '\x1b[A') return scrollFocused(+1);
    if (s === '\x1b[B') return scrollFocused(-1);
    if (s === '\x1b[5~') return scrollFocused(+10);
    if (s === '\x1b[6~') return scrollFocused(-10);
    if (s === '\x1b[H') {
      panes[focused].scroll = 1000000;
      scheduleRender();
      return;
    }
    if (s === '\x1b[F') {
      panes[focused].scroll = 0;
      scheduleRender();
      return;
    }
  });

  await refreshSummary();
  render();
  await new Promise(() => {});
}

main().catch((err) => {
  console.error('[tui] failed:', err);
  process.exit(1);
});
