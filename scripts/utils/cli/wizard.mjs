import { createInterface } from 'node:readline/promises';
import { listWorktreeSpecs } from '../git/worktrees.mjs';
import { bold, cyan, dim, green } from '../ui/ansi.mjs';

export function isTty() {
  if (process.env.HAPPY_STACKS_TEST_TTY === '1') {
    return true;
  }
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export async function withRl(fn) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await fn(rl);
  } finally {
    rl.close();
  }
}

export async function prompt(rl, question, { defaultValue = '' } = {}) {
  const raw = (await rl.question(question)).trim();
  return raw || defaultValue;
}

export async function promptSelect(rl, { title, options, defaultIndex = 0 }) {
  if (!options.length) {
    throw new Error('[wizard] no options to select from');
  }
  // eslint-disable-next-line no-console
  console.log('');
  // eslint-disable-next-line no-console
  console.log(title);
  for (let i = 0; i < options.length; i++) {
    // eslint-disable-next-line no-console
    console.log(`  ${i + 1}) ${options[i].label}`);
  }
  const answer = (await rl.question(`Pick [1-${options.length}] (default: ${defaultIndex + 1}): `)).trim();
  const n = answer ? Number(answer) : defaultIndex + 1;
  const idx = Math.max(1, Math.min(options.length, Number.isFinite(n) ? n : defaultIndex + 1)) - 1;
  return options[idx].value;
}

export async function promptWorktreeSource({ rl, rootDir, component, stackName, createRemote = 'upstream', deps = {} }) {
  const promptFn = deps.prompt ?? prompt;
  const promptSelectFn = deps.promptSelect ?? promptSelect;
  const listWorktreeSpecsFn = deps.listWorktreeSpecs ?? listWorktreeSpecs;

  const baseOptions = [{ label: `default (${dim(`components/${component}`)})`, value: 'default' }];
  baseOptions.push({ label: `pick existing worktree`, value: 'pick' });
  baseOptions.push({ label: `create new worktree (${cyan(createRemote)}; ${green('recommended for PRs')})`, value: 'create' });

  const kind = await promptSelectFn(rl, { title: `Select ${component}:`, options: baseOptions, defaultIndex: 0 });

  if (kind === 'default') {
    return 'default';
  }
  if (kind === 'pick') {
    const specs = await listWorktreeSpecsFn({ rootDir, component });
    if (!specs.length) {
      return 'default';
    }
    const picked = await promptSelectFn(rl, {
      title: `${bold(`Available ${cyan(component)} worktrees`)}\n${dim('Tip: use `happys wt new ... --use` to create more worktrees.')}`,
      options: specs.map((s) => ({ label: s, value: s })),
      defaultIndex: 0,
    });
    return picked;
  }

  // eslint-disable-next-line no-console
  console.log('');
  // eslint-disable-next-line no-console
  console.log(bold(`Create a new ${cyan(component)} worktree`));
  // eslint-disable-next-line no-console
  console.log(dim(`This will create a worktree under components/.worktrees/${component}/... based on ${createRemote}.`));
  const slug = await promptFn(rl, `New worktree slug (example: pr/${stackName}/${component}): `, {
    defaultValue: '',
  });
  if (!slug) {
    return 'default';
  }
  return { create: true, slug, remote: createRemote };
}
