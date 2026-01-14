import { createInterface } from 'node:readline/promises';
import { listWorktreeSpecs } from '../worktrees.mjs';

export function isTty() {
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

export async function promptWorktreeSource({ rl, rootDir, component, stackName, createRemote = 'upstream' }) {
  const specs = await listWorktreeSpecs({ rootDir, component });

  const baseOptions = [{ label: `default (components/${component})`, value: 'default' }];
  if (specs.length) {
    baseOptions.push({ label: 'pick existing worktree', value: 'pick' });
  }
  baseOptions.push({ label: `create new worktree (${createRemote})`, value: 'create' });

  const kind = await promptSelect(rl, { title: `Select ${component}:`, options: baseOptions, defaultIndex: 0 });

  if (kind === 'default') {
    return 'default';
  }
  if (kind === 'pick') {
    const picked = await promptSelect(rl, {
      title: `Available ${component} worktrees:`,
      options: specs.map((s) => ({ label: s, value: s })),
      defaultIndex: 0,
    });
    return picked;
  }

  const slug = await prompt(rl, `New worktree slug for ${component} (example: pr/${stackName}/${component}): `, {
    defaultValue: '',
  });
  if (!slug) {
    return 'default';
  }
  return { create: true, slug, remote: createRemote };
}

