import './utils/env.mjs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

import { parseArgs } from './utils/args.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli.mjs';
import { getRootDir } from './utils/paths.mjs';

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

function mkPane(id, title) {
  return { id, title, lines: [], scroll: 0 };
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
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

async function main() {
  const argv = process.argv.slice(2);
  const { flags } = parseArgs(argv);
  const json = wantsJson(argv, { flags });
  if (wantsHelp(argv, { flags })) {
    printResult({
      json,
      data: { usage: 'happys tui <happys args...>', json: true },
      text: [
        '[tui] usage:',
        '  happys tui <happys args...>',
        '',
        'examples:',
        '  happys tui stack dev resume-upstream',
        '  happys tui stack start resume-upstream',
        '',
        'keys:',
        '  tab / shift+tab: switch pane',
        '  1..9: jump to pane',
        '  v: toggle single/split layout',
        '  c: clear focused pane',
        '  p: pause/resume rendering',
        '  ↑/↓, PgUp/PgDn, Home/End: scroll focused pane',
        '  q / Ctrl+C: quit',
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
  if (!forwarded.length) {
    throw new Error('[tui] expected a happys command to run (e.g. `happys tui stack dev <stack>`).');
  }

  const panes = [
    mkPane('orch', 'orchestration'),
    mkPane('local', 'local'),
    mkPane('server', 'server'),
    mkPane('ui', 'ui'),
    mkPane('daemon', 'daemon'),
    mkPane('stack', 'stack'),
  ];
  const paneById = new Map(panes.map((p, i) => [p.id, i]));

  const routeLine = (line) => {
    const label = parsePrefixedLabel(line);
    const normalized = label ? label.toLowerCase() : '';
    let paneId = 'local';
    if (normalized.includes('server')) paneId = 'server';
    else if (normalized === 'ui') paneId = 'ui';
    else if (normalized.includes('daemon')) paneId = 'daemon';
    else if (normalized === 'stack') paneId = 'stack';
    else if (normalized === 'local') paneId = 'local';
    const idx = paneById.get(paneId) ?? 1;
    panes[idx].lines.push(line);
  };

  const logOrch = (msg) => {
    panes[0].lines.push(`[${nowTs()}] ${msg}`);
  };

  let layout = 'split'; // split | single
  let focused = 1; // default focus: local
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

  function scheduleRender() {
    if (paused) return;
    if (renderScheduled) return;
    renderScheduled = true;
    setTimeout(() => {
      renderScheduled = false;
      render();
    }, 16);
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
    } else {
      const leftW = Math.floor(cols / 2);
      const rightW = cols - leftW;
      const leftPane = panes[0];
      const rightPane = panes[focused === 0 ? 1 : focused];

      const leftBox = drawBox({ x: 0, y: bodyY, w: leftW, h: bodyH, title: leftPane.title, lines: leftPane.lines, scroll: leftPane.scroll });
      leftPane.scroll = clamp(leftPane.scroll, 0, leftBox.maxScroll);
      drawWrites.push(...leftBox.out);

      const rightBox = drawBox({ x: leftW, y: bodyY, w: rightW, h: bodyH, title: rightPane.title, lines: rightPane.lines, scroll: rightPane.scroll });
      rightPane.scroll = clamp(rightPane.scroll, 0, rightBox.maxScroll);
      drawWrites.push(...rightBox.out);
    }

    for (const w of drawWrites) {
      process.stdout.write(`\x1b[${w.row + 1};${w.col + 1}H${w.text}`);
    }

    const footer = 'tab:next  shift+tab:prev  v:layout  c:clear  p:pause  arrows:scroll  q/Ctrl+C:quit';
    process.stdout.write(`\x1b[${footerY + 1};1H` + padRight(footer, cols));
    process.stdout.write('\x1b[?25h');
  }

  function focusNext(delta) {
    const n = panes.length;
    focused = (focused + delta + n) % n;
    scheduleRender();
  }

  function scrollFocused(delta) {
    const pane = panes[focused];
    pane.scroll = Math.max(0, pane.scroll + delta);
    scheduleRender();
  }

  function clearFocused() {
    const pane = panes[focused];
    pane.lines = [];
    pane.scroll = 0;
    scheduleRender();
  }

  function shutdown() {
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
    process.stdout.write('\x1b[2J\x1b[H');
  }

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', (d) => {
    const s = d.toString('utf-8');
    if (s === '\u0003') {
      shutdown();
      process.exit(0);
    }
    if (s === 'q') {
      shutdown();
      process.exit(0);
    }
    if (s === '\t') return focusNext(+1);
    if (s === '\x1b[Z') return focusNext(-1);
    if (s >= '1' && s <= '9') {
      const idx = Number(s) - 1;
      if (idx >= 0 && idx < panes.length) {
        focused = idx;
        scheduleRender();
      }
      return;
    }
    if (s === 'v') {
      layout = layout === 'split' ? 'single' : 'split';
      scheduleRender();
      return;
    }
    if (s === 'c') return clearFocused();
    if (s === 'p') {
      paused = !paused;
      if (!paused) scheduleRender();
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

  render();
  await new Promise(() => {});
}

main().catch((err) => {
  console.error('[tui] failed:', err);
  process.exit(1);
});
