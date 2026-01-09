import './utils/env.mjs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import net from 'node:net';

import { parseArgs } from './utils/args.mjs';
import { run } from './utils/proc.mjs';
import { getLegacyStorageRoot, getRootDir, getStacksStorageRoot, resolveStackEnvPath } from './utils/paths.mjs';
import { createWorktree, resolveComponentSpecToDir } from './utils/worktrees.mjs';
import { isTty, prompt, promptWorktreeSource, withRl } from './utils/wizard.mjs';
import { parseDotenv } from './utils/dotenv.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli.mjs';

function stackNameFromArg(positionals, idx) {
  const name = positionals[idx]?.trim() ? positionals[idx].trim() : '';
  return name;
}

function getStackDir(stackName) {
  return resolveStackEnvPath(stackName).baseDir;
}

function getStackEnvPath(stackName) {
  return resolveStackEnvPath(stackName).envPath;
}

function getDefaultPortStart() {
  const raw = process.env.HAPPY_STACKS_STACK_PORT_START?.trim()
    ? process.env.HAPPY_STACKS_STACK_PORT_START.trim()
    : process.env.HAPPY_LOCAL_STACK_PORT_START?.trim()
      ? process.env.HAPPY_LOCAL_STACK_PORT_START.trim()
      : '';
  const n = raw ? Number(raw) : 3005;
  return Number.isFinite(n) ? n : 3005;
}

async function isPortFree(port) {
  return await new Promise((resolvePromise) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', () => resolvePromise(false));
    srv.listen({ port, host: '127.0.0.1' }, () => {
      srv.close(() => resolvePromise(true));
    });
  });
}

async function pickNextFreePort(startPort) {
  let port = startPort;
  for (let i = 0; i < 200; i++) {
    // eslint-disable-next-line no-await-in-loop
    if (await isPortFree(port)) {
      return port;
    }
    port += 1;
  }
  throw new Error(`[stack] unable to find a free port starting at ${startPort}`);
}

async function ensureDir(p) {
  await mkdir(p, { recursive: true });
}

function stringifyEnv(env) {
  const lines = [];
  for (const [k, v] of Object.entries(env)) {
    if (v == null) continue;
    const s = String(v);
    if (!s.trim()) continue;
    // Keep it simple: no quoting/escaping beyond this.
    lines.push(`${k}=${s}`);
  }
  return lines.join('\n') + '\n';
}

async function readExistingEnv(path) {
  try {
    const raw = await readFile(path, 'utf-8');
    return raw;
  } catch {
    return '';
  }
}

function parseEnvToObject(raw) {
  const parsed = parseDotenv(raw);
  return Object.fromEntries(parsed.entries());
}

async function writeStackEnv({ stackName, env }) {
  const stackDir = getStackDir(stackName);
  await ensureDir(stackDir);
  const envPath = getStackEnvPath(stackName);
  const next = stringifyEnv(env);
  const existing = await readExistingEnv(envPath);
  if (existing !== next) {
    await writeFile(envPath, next, 'utf-8');
  }
  return envPath;
}

async function withStackEnv({ stackName, fn, extraEnv = {} }) {
  const envPath = getStackEnvPath(stackName);
  // IMPORTANT: stack env file should be authoritative. If the user has HAPPY_STACKS_* / HAPPY_LOCAL_*
  // exported in their shell, it would otherwise "win" because utils/env.mjs only sets
  // env vars if they are missing/empty.
  const cleaned = { ...process.env };
  for (const k of Object.keys(cleaned)) {
    if (k === 'HAPPY_LOCAL_ENV_FILE' || k === 'HAPPY_STACKS_ENV_FILE') continue;
    if (k === 'HAPPY_LOCAL_STACK' || k === 'HAPPY_STACKS_STACK') continue;
    if (k.startsWith('HAPPY_LOCAL_') || k.startsWith('HAPPY_STACKS_')) {
      delete cleaned[k];
    }
  }
  return await fn({
    env: {
      ...cleaned,
      HAPPY_STACKS_STACK: stackName,
      HAPPY_STACKS_ENV_FILE: envPath,
      HAPPY_LOCAL_STACK: stackName,
      HAPPY_LOCAL_ENV_FILE: envPath,
      ...extraEnv,
    },
    envPath,
  });
}

async function interactiveNew({ rootDir, rl, defaults }) {
  const out = { ...defaults };

  if (!out.stackName) {
    out.stackName = (await rl.question('Stack name: ')).trim();
  }
  if (!out.stackName) {
    throw new Error('[stack] stack name is required');
  }
  if (out.stackName === 'main') {
    throw new Error('[stack] stack name \"main\" is reserved (use the default stack without creating it)');
  }

  // Server component selection
  if (!out.serverComponent) {
    const server = (await rl.question('Server component [happy-server-light|happy-server] (default: happy-server-light): ')).trim();
    out.serverComponent = server || 'happy-server-light';
  }

  // Port
  if (!out.port) {
    const want = (await rl.question('Port (empty = auto-pick): ')).trim();
    out.port = want ? Number(want) : null;
  }

  // Remote for creating new worktrees (used by all "create new worktree" choices)
  if (!out.createRemote) {
    out.createRemote = await prompt(rl, 'Git remote for creating new worktrees (default: upstream): ', { defaultValue: 'upstream' });
  }

  // Component selections
  for (const c of ['happy', 'happy-cli']) {
    if (out.components[c] != null) continue;
    out.components[c] = await promptWorktreeSource({
      rl,
      rootDir,
      component: c,
      stackName: out.stackName,
      createRemote: out.createRemote,
    });
  }

  // Server worktree selection (optional; only for the chosen server component)
  const serverComponent = out.serverComponent === 'happy-server' ? 'happy-server' : 'happy-server-light';
  if (out.components[serverComponent] == null) {
    out.components[serverComponent] = await promptWorktreeSource({
      rl,
      rootDir,
      component: serverComponent,
      stackName: out.stackName,
      createRemote: out.createRemote,
    });
  }

  return out;
}

async function interactiveEdit({ rootDir, rl, stackName, existingEnv, defaults }) {
  const out = { ...defaults, stackName };

  // Server component selection
  const currentServer = existingEnv.HAPPY_STACKS_SERVER_COMPONENT ?? existingEnv.HAPPY_LOCAL_SERVER_COMPONENT ?? '';
  const server = await prompt(
    rl,
    `Server component [happy-server-light|happy-server] (default: ${currentServer || 'happy-server-light'}): `,
    { defaultValue: currentServer || 'happy-server-light' }
  );
  out.serverComponent = server || 'happy-server-light';

  // Port
  const currentPort = existingEnv.HAPPY_STACKS_SERVER_PORT ?? existingEnv.HAPPY_LOCAL_SERVER_PORT ?? '';
  const wantPort = await prompt(rl, `Port (empty = keep ${currentPort || 'auto'}): `, { defaultValue: '' });
  out.port = wantPort ? Number(wantPort) : (currentPort ? Number(currentPort) : null);

  // Remote for creating new worktrees
  const currentRemote = existingEnv.HAPPY_STACKS_STACK_REMOTE ?? existingEnv.HAPPY_LOCAL_STACK_REMOTE ?? '';
  out.createRemote = await prompt(rl, `Git remote for creating new worktrees (default: ${currentRemote || 'upstream'}): `, {
    defaultValue: currentRemote || 'upstream',
  });

  // Worktree selections
  for (const c of ['happy', 'happy-cli']) {
    out.components[c] = await promptWorktreeSource({
      rl,
      rootDir,
      component: c,
      stackName,
      createRemote: out.createRemote,
    });
  }

  const serverComponent = out.serverComponent === 'happy-server' ? 'happy-server' : 'happy-server-light';
  out.components[serverComponent] = await promptWorktreeSource({
    rl,
    rootDir,
    component: serverComponent,
    stackName,
    createRemote: out.createRemote,
  });

  return out;
}

async function cmdNew({ rootDir, argv }) {
  const { flags, kv } = parseArgs(argv);
  const positionals = argv.filter((a) => !a.startsWith('--'));
  const json = wantsJson(argv, { flags });

  // argv here is already "args after 'new'", so the first positional is the stack name.
  let stackName = stackNameFromArg(positionals, 0);
  const interactive = flags.has('--interactive') || (!stackName && isTty());

  const defaults = {
    stackName,
    port: kv.get('--port')?.trim() ? Number(kv.get('--port')) : null,
    serverComponent: (kv.get('--server') ?? '').trim() || '',
    createRemote: (kv.get('--remote') ?? '').trim() || '',
    components: {
      happy: kv.get('--happy')?.trim() || null,
      'happy-cli': kv.get('--happy-cli')?.trim() || null,
      'happy-server-light': kv.get('--happy-server-light')?.trim() || null,
      'happy-server': kv.get('--happy-server')?.trim() || null,
    },
  };

  let config = defaults;
  if (interactive) {
    config = await withRl((rl) => interactiveNew({ rootDir, rl, defaults }));
  }

  stackName = config.stackName?.trim() ? config.stackName.trim() : '';
  if (!stackName) {
    throw new Error(
      '[stack] usage: pnpm stack new <name> [--port=NNN] [--server=happy-server|happy-server-light] ' +
        '[--happy=default|<owner/...>|<path>] [--happy-cli=...] [--happy-server=...] [--happy-server-light=...] [--interactive]'
    );
  }
  if (stackName === 'main') {
    throw new Error('[stack] stack name \"main\" is reserved (use the default stack without creating it)');
  }

  const serverComponent = (config.serverComponent || 'happy-server-light').trim();
  if (serverComponent !== 'happy-server-light' && serverComponent !== 'happy-server') {
    throw new Error(`[stack] invalid server component: ${serverComponent}`);
  }

  const baseDir = getStackDir(stackName);
  const uiBuildDir = join(baseDir, 'ui');
  const cliHomeDir = join(baseDir, 'cli');

  let port = config.port;
  if (!port || !Number.isFinite(port)) {
    port = await pickNextFreePort(getDefaultPortStart());
  }

  // Always pin component dirs explicitly (so stack env is stable even if repo env changes).
  const defaultComponentDirs = {
    HAPPY_STACKS_COMPONENT_DIR_HAPPY: 'components/happy',
    HAPPY_STACKS_COMPONENT_DIR_HAPPY_CLI: 'components/happy-cli',
    HAPPY_STACKS_COMPONENT_DIR_HAPPY_SERVER_LIGHT: 'components/happy-server-light',
    HAPPY_STACKS_COMPONENT_DIR_HAPPY_SERVER: 'components/happy-server',
  };

  // Prepare component dirs (may create worktrees).
  const stackEnv = {
    HAPPY_STACKS_STACK: stackName,
    HAPPY_STACKS_SERVER_PORT: String(port),
    HAPPY_STACKS_SERVER_COMPONENT: serverComponent,
    HAPPY_STACKS_UI_BUILD_DIR: uiBuildDir,
    HAPPY_STACKS_CLI_HOME_DIR: cliHomeDir,
    HAPPY_STACKS_STACK_REMOTE: config.createRemote?.trim() ? config.createRemote.trim() : 'upstream',
    ...defaultComponentDirs,
  };

  // happy
  const happySpec = config.components.happy;
  if (happySpec && typeof happySpec === 'object' && happySpec.create) {
    const dir = await createWorktree({ rootDir, component: 'happy', slug: happySpec.slug, remoteName: happySpec.remote || 'upstream' });
    stackEnv.HAPPY_STACKS_COMPONENT_DIR_HAPPY = dir;
  } else {
    const dir = resolveComponentSpecToDir({ rootDir, component: 'happy', spec: happySpec });
    if (dir) stackEnv.HAPPY_STACKS_COMPONENT_DIR_HAPPY = resolve(rootDir, dir);
  }

  // happy-cli
  const cliSpec = config.components['happy-cli'];
  if (cliSpec && typeof cliSpec === 'object' && cliSpec.create) {
    const dir = await createWorktree({ rootDir, component: 'happy-cli', slug: cliSpec.slug, remoteName: cliSpec.remote || 'upstream' });
    stackEnv.HAPPY_STACKS_COMPONENT_DIR_HAPPY_CLI = dir;
  } else {
    const dir = resolveComponentSpecToDir({ rootDir, component: 'happy-cli', spec: cliSpec });
    if (dir) stackEnv.HAPPY_STACKS_COMPONENT_DIR_HAPPY_CLI = resolve(rootDir, dir);
  }

  // Server component directory override (optional)
  if (serverComponent === 'happy-server-light') {
    const spec = config.components['happy-server-light'];
    if (spec && typeof spec === 'object' && spec.create) {
      const dir = await createWorktree({
        rootDir,
        component: 'happy-server-light',
        slug: spec.slug,
        remoteName: spec.remote || 'upstream',
      });
      stackEnv.HAPPY_STACKS_COMPONENT_DIR_HAPPY_SERVER_LIGHT = dir;
    } else {
      const dir = resolveComponentSpecToDir({ rootDir, component: 'happy-server-light', spec });
      if (dir) stackEnv.HAPPY_STACKS_COMPONENT_DIR_HAPPY_SERVER_LIGHT = resolve(rootDir, dir);
    }
  } else if (serverComponent === 'happy-server') {
    const spec = config.components['happy-server'];
    if (spec && typeof spec === 'object' && spec.create) {
      const dir = await createWorktree({ rootDir, component: 'happy-server', slug: spec.slug, remoteName: spec.remote || 'upstream' });
      stackEnv.HAPPY_STACKS_COMPONENT_DIR_HAPPY_SERVER = dir;
    } else {
      const dir = resolveComponentSpecToDir({ rootDir, component: 'happy-server', spec });
      if (dir) stackEnv.HAPPY_STACKS_COMPONENT_DIR_HAPPY_SERVER = resolve(rootDir, dir);
    }
  }

  const envPath = await writeStackEnv({ stackName, env: stackEnv });
  printResult({
    json,
    data: { stackName, envPath, port, serverComponent },
    text: [`[stack] created ${stackName}`, `[stack] env: ${envPath}`, `[stack] port: ${port}`, `[stack] server: ${serverComponent}`].join('\n'),
  });
}

async function cmdEdit({ rootDir, argv }) {
  const { flags } = parseArgs(argv);
  const json = wantsJson(argv, { flags });
  const positionals = argv.filter((a) => !a.startsWith('--'));
  const stackName = stackNameFromArg(positionals, 1);
  if (!stackName) {
    throw new Error('[stack] usage: pnpm stack edit <name> [--interactive]');
  }

  const envPath = getStackEnvPath(stackName);
  const raw = await readExistingEnv(envPath);
  const existingEnv = parseEnvToObject(raw);

  const interactive = flags.has('--interactive') || (!flags.has('--no-interactive') && isTty());
  if (!interactive) {
    throw new Error('[stack] edit currently requires --interactive (non-interactive editing not implemented yet).');
  }

  const defaults = {
    stackName,
    port: null,
    serverComponent: '',
    createRemote: '',
    components: {
      happy: null,
      'happy-cli': null,
      'happy-server-light': null,
      'happy-server': null,
    },
  };

  const config = await withRl((rl) => interactiveEdit({ rootDir, rl, stackName, existingEnv, defaults }));

  // Build next env, starting from existing env but enforcing stack-scoped invariants.
  const baseDir = getStackDir(stackName);
  const uiBuildDir = join(baseDir, 'ui');
  const cliHomeDir = join(baseDir, 'cli');

  let port = config.port;
  if (!port || !Number.isFinite(port)) {
    port = await pickNextFreePort(getDefaultPortStart());
  }

  const serverComponent = (config.serverComponent || existingEnv.HAPPY_STACKS_SERVER_COMPONENT || existingEnv.HAPPY_LOCAL_SERVER_COMPONENT || 'happy-server-light').trim();

  const next = {
    HAPPY_STACKS_STACK: stackName,
    HAPPY_STACKS_SERVER_PORT: String(port),
    HAPPY_STACKS_SERVER_COMPONENT: serverComponent,
    HAPPY_STACKS_UI_BUILD_DIR: uiBuildDir,
    HAPPY_STACKS_CLI_HOME_DIR: cliHomeDir,
    HAPPY_STACKS_STACK_REMOTE: config.createRemote?.trim()
      ? config.createRemote.trim()
      : (existingEnv.HAPPY_STACKS_STACK_REMOTE || existingEnv.HAPPY_LOCAL_STACK_REMOTE || 'upstream'),
    // Always pin defaults; overrides below can replace.
    HAPPY_STACKS_COMPONENT_DIR_HAPPY: 'components/happy',
    HAPPY_STACKS_COMPONENT_DIR_HAPPY_CLI: 'components/happy-cli',
    HAPPY_STACKS_COMPONENT_DIR_HAPPY_SERVER_LIGHT: 'components/happy-server-light',
    HAPPY_STACKS_COMPONENT_DIR_HAPPY_SERVER: 'components/happy-server',
  };

  // Apply selections (create worktrees if needed)
  const applyComponent = async (component, key, spec) => {
    if (spec && typeof spec === 'object' && spec.create) {
      next[key] = await createWorktree({ rootDir, component, slug: spec.slug, remoteName: spec.remote || next.HAPPY_STACKS_STACK_REMOTE });
      return;
    }
    const dir = resolveComponentSpecToDir({ rootDir, component, spec });
    if (dir) {
      next[key] = resolve(rootDir, dir);
    }
  };

  await applyComponent('happy', 'HAPPY_STACKS_COMPONENT_DIR_HAPPY', config.components.happy);
  await applyComponent('happy-cli', 'HAPPY_STACKS_COMPONENT_DIR_HAPPY_CLI', config.components['happy-cli']);
  if (serverComponent === 'happy-server') {
    await applyComponent('happy-server', 'HAPPY_STACKS_COMPONENT_DIR_HAPPY_SERVER', config.components['happy-server']);
  } else {
    await applyComponent('happy-server-light', 'HAPPY_STACKS_COMPONENT_DIR_HAPPY_SERVER_LIGHT', config.components['happy-server-light']);
  }

  const wrote = await writeStackEnv({ stackName, env: next });
  printResult({ json, data: { stackName, envPath: wrote, port, serverComponent }, text: `[stack] updated ${stackName}\n[stack] env: ${wrote}` });
}

async function cmdRunScript({ rootDir, stackName, scriptPath, args }) {
  await withStackEnv({
    stackName,
    fn: async ({ env }) => {
      await run(process.execPath, [join(rootDir, 'scripts', scriptPath), ...args], { cwd: rootDir, env });
    },
  });
}

async function cmdService({ rootDir, stackName, svcCmd }) {
  await withStackEnv({
    stackName,
    fn: async ({ env }) => {
      await run(process.execPath, [join(rootDir, 'scripts', 'service.mjs'), svcCmd], { cwd: rootDir, env });
    },
  });
}

async function cmdTailscale({ rootDir, stackName, subcmd, args }) {
  await withStackEnv({
    stackName,
    fn: async ({ env }) => {
      await run(process.execPath, [join(rootDir, 'scripts', 'tailscale.mjs'), subcmd, ...args], { cwd: rootDir, env });
    },
  });
}

async function cmdSrv({ rootDir, stackName, args }) {
  // Forward to scripts/server_flavor.mjs under the stack env.
  const forwarded = args[0] === '--' ? args.slice(1) : args;
  await withStackEnv({
    stackName,
    fn: async ({ env }) => {
      await run(process.execPath, [join(rootDir, 'scripts', 'server_flavor.mjs'), ...forwarded], { cwd: rootDir, env });
    },
  });
}

async function cmdWt({ rootDir, stackName, args }) {
  // Forward to scripts/worktrees.mjs under the stack env.
  // This makes `pnpm stack wt <name> -- ...` behave exactly like `pnpm wt ...`,
  // but read/write the stack env file (HAPPY_STACKS_ENV_FILE / legacy: HAPPY_LOCAL_ENV_FILE) instead of repo env.local.
  const forwarded = args[0] === '--' ? args.slice(1) : args;
  await withStackEnv({
    stackName,
    fn: async ({ env }) => {
      await run(process.execPath, [join(rootDir, 'scripts', 'worktrees.mjs'), ...forwarded], { cwd: rootDir, env });
    },
  });
}

async function cmdMigrate({ argv }) {
  const { flags } = parseArgs(argv);
  const json = wantsJson(argv, { flags });

  const legacyDir = join(getLegacyStorageRoot(), 'stacks');
  const newRoot = getStacksStorageRoot();

  const migrated = [];
  const skipped = [];
  const missing = [];

  let entries = [];
  try {
    entries = await readdir(legacyDir, { withFileTypes: true });
  } catch {
    entries = [];
  }

  if (!entries.length) {
    printResult({
      json,
      data: { ok: true, migrated, skipped, missing, legacyDir, newRoot },
      text: `[stack] no legacy stacks found at ${legacyDir}`,
    });
    return;
  }

  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const name = e.name;
    const legacyEnv = join(legacyDir, name, 'env');
    const targetEnv = join(newRoot, name, 'env');

    const raw = await readExistingEnv(legacyEnv);
    if (!raw.trim()) {
      missing.push({ name, legacyEnv });
      continue;
    }

    const existingTarget = await readExistingEnv(targetEnv);
    if (existingTarget.trim()) {
      skipped.push({ name, targetEnv });
      continue;
    }

    await ensureDir(join(newRoot, name));
    await writeFile(targetEnv, raw, 'utf-8');
    migrated.push({ name, targetEnv });
  }

  printResult({
    json,
    data: { ok: true, migrated, skipped, missing, legacyDir, newRoot },
    text: [
      `[stack] migrate complete`,
      `[stack] legacy: ${legacyDir}`,
      `[stack] new: ${newRoot}`,
      migrated.length ? `[stack] migrated: ${migrated.length}` : `[stack] migrated: none`,
      skipped.length ? `[stack] skipped (already exists): ${skipped.length}` : null,
      missing.length ? `[stack] skipped (missing env): ${missing.length}` : null,
      '',
      `Next steps:`,
      `- Re-run stacks normally (they'll prefer ${newRoot})`,
      `- If you use autostart: re-install to get the new label/paths: pnpm service:install`,
    ]
      .filter(Boolean)
      .join('\n'),
  });
}

async function cmdListStacks() {
  const stacksDir = getStacksStorageRoot();
  const legacyStacksDir = join(getLegacyStorageRoot(), 'stacks');
  try {
    const namesSet = new Set();
    const entries = await readdir(stacksDir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name === 'main') continue;
      namesSet.add(e.name);
    }
    try {
      const legacyEntries = await readdir(legacyStacksDir, { withFileTypes: true });
      for (const e of legacyEntries) {
        if (!e.isDirectory()) continue;
        namesSet.add(e.name);
      }
    } catch {
      // ignore
    }
    const names = Array.from(namesSet).sort();
    if (!names.length) {
      console.log('[stack] no stacks found');
      return;
    }
    console.log('[stack] stacks:');
    for (const n of names) {
      console.log(`- ${n}`);
    }
  } catch {
    console.log('[stack] no stacks found');
  }
}

async function main() {
  const rootDir = getRootDir(import.meta.url);
  const argv = process.argv.slice(2);
  const { flags } = parseArgs(argv);
  const positionals = argv.filter((a) => !a.startsWith('--'));
  const cmd = positionals[0] || 'help';
  const json = wantsJson(argv, { flags });

  if (wantsHelp(argv, { flags }) || cmd === 'help') {
    printResult({
      json,
      data: { commands: ['new', 'edit', 'list', 'migrate', 'dev', 'start', 'build', 'doctor', 'mobile', 'srv', 'wt', 'tailscale:*', 'service:*'] },
      text: [
        '[stack] usage:',
        '  pnpm stack new <name> [--port=NNN] [--server=happy-server|happy-server-light] [--happy=default|<owner/...>|<path>] [--happy-cli=...] [--interactive] [--json]',
        '  pnpm stack edit <name> --interactive [--json]',
        '  pnpm stack list [--json]',
        '  pnpm stack migrate [--json]   # copy legacy env files from ~/.happy/local/stacks/* -> ~/.happy/stacks/*',
        '  pnpm stack dev <name> [-- ...]',
        '  pnpm stack start <name> [-- ...]',
        '  pnpm stack build <name> [-- ...]',
        '  pnpm stack doctor <name> [-- ...]',
        '  pnpm stack mobile <name> [-- ...]',
        '  pnpm stack srv <name> -- status|use ...',
        '  pnpm stack wt <name> -- <wt args...>',
        '  pnpm stack tailscale:status|enable|disable|url <name> [-- ...]',
        '  pnpm stack service:* <name>',
      ].join('\n'),
    });
    return;
  }

  if (cmd === 'new') {
    await cmdNew({ rootDir, argv: argv.slice(1) });
    return;
  }
  if (cmd === 'edit') {
    await cmdEdit({ rootDir, argv });
    return;
  }
  if (cmd === 'list') {
    let names = [];
    try {
      const stacksDir = getStacksStorageRoot();
      const legacyStacksDir = join(getLegacyStorageRoot(), 'stacks');
      const namesSet = new Set();
      const entries = await readdir(stacksDir, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        if (e.name === 'main') continue;
        namesSet.add(e.name);
      }
      try {
        const legacyEntries = await readdir(legacyStacksDir, { withFileTypes: true });
        for (const e of legacyEntries) {
          if (!e.isDirectory()) continue;
          namesSet.add(e.name);
        }
      } catch {
        // ignore
      }
      names = Array.from(namesSet).sort();
    } catch {
      names = [];
    }
    if (json) {
      printResult({ json, data: { stacks: names } });
    } else {
      await cmdListStacks();
    }
    return;
  }

  if (cmd === 'migrate') {
    await cmdMigrate({ argv });
    return;
  }

  // Commands that need a stack name.
  const stackName = stackNameFromArg(positionals, 1);
  if (!stackName) {
    throw new Error('[stack] missing stack name (run with --help)');
  }

  // Remaining args after "<cmd> <name>"
  const passthrough = argv.slice(2);

  if (cmd === 'dev') {
    await cmdRunScript({ rootDir, stackName, scriptPath: 'dev.mjs', args: passthrough });
    return;
  }
  if (cmd === 'start') {
    await cmdRunScript({ rootDir, stackName, scriptPath: 'run.mjs', args: passthrough });
    return;
  }
  if (cmd === 'build') {
    await cmdRunScript({ rootDir, stackName, scriptPath: 'build.mjs', args: passthrough });
    return;
  }
  if (cmd === 'doctor') {
    await cmdRunScript({ rootDir, stackName, scriptPath: 'doctor.mjs', args: passthrough });
    return;
  }
  if (cmd === 'mobile') {
    await cmdRunScript({ rootDir, stackName, scriptPath: 'mobile.mjs', args: passthrough });
    return;
  }

  if (cmd === 'srv') {
    await cmdSrv({ rootDir, stackName, args: passthrough });
    return;
  }
  if (cmd === 'wt') {
    await cmdWt({ rootDir, stackName, args: passthrough });
    return;
  }

  if (cmd.startsWith('service:')) {
    const svcCmd = cmd.slice('service:'.length);
    await cmdService({ rootDir, stackName, svcCmd });
    return;
  }
  if (cmd.startsWith('tailscale:')) {
    const subcmd = cmd.slice('tailscale:'.length);
    await cmdTailscale({ rootDir, stackName, subcmd, args: passthrough });
    return;
  }

  if (flags.has('--interactive') && cmd === 'help') {
    // no-op
  }

  console.log(`[stack] unknown command: ${cmd}`);
}

main().catch((err) => {
  console.error('[stack] failed:', err);
  process.exit(1);
});

