import { join, resolve } from 'node:path';

import { prompt, promptWorktreeSource } from '../cli/wizard.mjs';
import { coerceHappyMonorepoRootFromPath, getComponentsDir } from '../paths/paths.mjs';
import { resolveComponentSpecToDir } from '../git/worktrees.mjs';

function wantsNo(raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  return v === 'n' || v === 'no' || v === '0' || v === 'false';
}

function resolveHappySpecDir({ rootDir, spec }) {
  if (!spec) return '';
  if (spec === 'default' || spec === 'main') {
    return join(getComponentsDir(rootDir), 'happy');
  }
  if (typeof spec === 'string') {
    const dir = resolveComponentSpecToDir({ rootDir, component: 'happy', spec });
    return dir ? resolve(rootDir, dir) : '';
  }
  return '';
}

export async function interactiveNew({ rootDir, rl, defaults, deps = {} }) {
  const promptFn = deps.prompt ?? prompt;
  const promptWorktreeSourceFn = deps.promptWorktreeSource ?? promptWorktreeSource;

  const out = { ...defaults };

  if (!out.stackName) {
    out.stackName = (await rl.question('Stack name: ')).trim();
  }
  if (!out.stackName) {
    throw new Error('[stack] stack name is required');
  }
  if (out.stackName === 'main') {
    throw new Error('[stack] stack name "main" is reserved (use the default stack without creating it)');
  }

  if (!out.serverComponent) {
    const server = (await rl.question('Server component [happy-server-light|happy-server] (default: happy-server-light): ')).trim();
    out.serverComponent = server || 'happy-server-light';
  }

  if (!out.port) {
    const want = (await rl.question('Port (empty = ephemeral): ')).trim();
    out.port = want ? Number(want) : null;
  }

  if (!out.createRemote) {
    out.createRemote = await promptFn(rl, 'Git remote for creating new worktrees (default: upstream): ', { defaultValue: 'upstream' });
  }

  if (out.components.happy == null) {
    out.components.happy = await promptWorktreeSourceFn({
      rl,
      rootDir,
      component: 'happy',
      stackName: out.stackName,
      createRemote: out.createRemote,
    });
  }

  const happyIsCreate = Boolean(out.components.happy && typeof out.components.happy === 'object' && out.components.happy.create);
  const happyMonoRoot = coerceHappyMonorepoRootFromPath(resolveHappySpecDir({ rootDir, spec: out.components.happy }));
  const canDeriveMonorepoGroup = Boolean(happyMonoRoot) || happyIsCreate;
  let deriveMonorepoGroup = false;

  if (canDeriveMonorepoGroup) {
    const ans = await promptFn(rl, 'Detected happy monorepo checkout. Derive happy-cli + happy-server from it? [Y/n]: ', {
      defaultValue: 'y',
    });
    deriveMonorepoGroup = !wantsNo(ans);
  }

  if (deriveMonorepoGroup) {
    out.components['happy-cli'] = null;
    out.components['happy-server'] = null;
    // In monorepo mode, happy-server-light is derived when supported by the monorepo server checkout.
    // If not supported, the stack env will keep the default separate happy-server-light checkout.
    out.components['happy-server-light'] = null;
  } else if (out.components['happy-cli'] == null) {
    out.components['happy-cli'] = await promptWorktreeSourceFn({
      rl,
      rootDir,
      component: 'happy-cli',
      stackName: out.stackName,
      createRemote: out.createRemote,
    });
  }

  const serverComponent = out.serverComponent === 'happy-server' ? 'happy-server' : 'happy-server-light';
  if (serverComponent === 'happy-server-light' && deriveMonorepoGroup) {
    out.components['happy-server-light'] = null;
    return out;
  }
  if (serverComponent === 'happy-server' && deriveMonorepoGroup) {
    out.components['happy-server'] = null;
  } else if (out.components[serverComponent] == null) {
    out.components[serverComponent] = await promptWorktreeSourceFn({
      rl,
      rootDir,
      component: serverComponent,
      stackName: out.stackName,
      createRemote: out.createRemote,
    });
  }

  return out;
}

export async function interactiveEdit({ rootDir, rl, stackName, existingEnv, defaults, deps = {} }) {
  const promptFn = deps.prompt ?? prompt;
  const promptWorktreeSourceFn = deps.promptWorktreeSource ?? promptWorktreeSource;

  const out = { ...defaults, stackName };

  const currentServer = existingEnv.HAPPY_STACKS_SERVER_COMPONENT ?? existingEnv.HAPPY_LOCAL_SERVER_COMPONENT ?? '';
  const server = await promptFn(rl, `Server component [happy-server-light|happy-server] (default: ${currentServer || 'happy-server-light'}): `, {
    defaultValue: currentServer || 'happy-server-light',
  });
  out.serverComponent = server || 'happy-server-light';

  const currentPort = existingEnv.HAPPY_STACKS_SERVER_PORT ?? existingEnv.HAPPY_LOCAL_SERVER_PORT ?? '';
  const wantPort = await promptFn(rl, `Port (empty = keep ${currentPort || 'ephemeral'}; type 'ephemeral' to unpin): `, { defaultValue: '' });
  const wantTrimmed = wantPort.trim().toLowerCase();
  out.port = wantTrimmed === 'ephemeral' ? null : wantPort ? Number(wantPort) : currentPort ? Number(currentPort) : null;

  const currentRemote = existingEnv.HAPPY_STACKS_STACK_REMOTE ?? existingEnv.HAPPY_LOCAL_STACK_REMOTE ?? '';
  out.createRemote = await promptFn(rl, `Git remote for creating new worktrees (default: ${currentRemote || 'upstream'}): `, {
    defaultValue: currentRemote || 'upstream',
  });

  out.components.happy = await promptWorktreeSourceFn({
    rl,
    rootDir,
    component: 'happy',
    stackName,
    createRemote: out.createRemote,
  });

  const happyIsCreate = Boolean(out.components.happy && typeof out.components.happy === 'object' && out.components.happy.create);
  const happyMonoRoot = coerceHappyMonorepoRootFromPath(resolveHappySpecDir({ rootDir, spec: out.components.happy }));
  const canDeriveMonorepoGroup = Boolean(happyMonoRoot) || happyIsCreate;
  let deriveMonorepoGroup = false;
  if (canDeriveMonorepoGroup) {
    const ans = await promptFn(rl, 'Detected happy monorepo checkout. Derive happy-cli + happy-server from it? [Y/n]: ', {
      defaultValue: 'y',
    });
    deriveMonorepoGroup = !wantsNo(ans);
  }

  if (deriveMonorepoGroup) {
    out.components['happy-cli'] = null;
    out.components['happy-server'] = null;
    out.components['happy-server-light'] = null;
  } else if (out.components['happy-cli'] == null) {
    out.components['happy-cli'] = await promptWorktreeSourceFn({
      rl,
      rootDir,
      component: 'happy-cli',
      stackName,
      createRemote: out.createRemote,
    });
  }

  const serverComponent = out.serverComponent === 'happy-server' ? 'happy-server' : 'happy-server-light';
  if (serverComponent === 'happy-server-light' && deriveMonorepoGroup) {
    out.components['happy-server-light'] = null;
    return out;
  }
  if (serverComponent === 'happy-server' && deriveMonorepoGroup) {
    out.components['happy-server'] = null;
  } else {
    out.components[serverComponent] = await promptWorktreeSourceFn({
      rl,
      rootDir,
      component: serverComponent,
      stackName,
      createRemote: out.createRemote,
    });
  }

  return out;
}
