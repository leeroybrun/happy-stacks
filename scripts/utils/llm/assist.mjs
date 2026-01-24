import { detectInstalledLlmTools } from './tools.mjs';
import { buildCodexExecScript, CODEX_PERMISSION_MODES, runCodexExecHere } from './codex_exec.mjs';
import { canLaunchNewTerminal, launchScriptInNewTerminal } from '../ui/terminal_launcher.mjs';
import { clipboardAvailable, copyTextToClipboard } from '../ui/clipboard.mjs';
import { isTty, promptSelect, withRl } from '../cli/wizard.mjs';
import { banner, bullets, cmd as cmdFmt, sectionTitle } from '../ui/layout.mjs';
import { bold, cyan, dim, green, red, yellow } from '../ui/ansi.mjs';

function codexPermissionOptions() {
  return [
    { value: 'full-auto', label: `${green('recommended')} — full-auto (approvals on request + workspace sandbox)` },
    { value: 'safe', label: `safe — always ask on risky actions (workspace sandbox)` },
    { value: 'yolo', label: `${red('danger')} — run without approvals/sandbox (YOLO)` },
  ];
}

function shouldAsk(options) {
  return isTty() && options.length > 1;
}

export async function launchLlmAssistant({
  title,
  subtitle,
  promptText,
  cwd,
  preferredToolId = '',
  env = process.env,
  allowRunHere = true,
  allowCopyOnly = true,
  defaultPermissionMode = 'full-auto',
}) {
  const prompt = String(promptText ?? '').trimEnd();
  const cd = String(cwd ?? '').trim();
  if (!prompt) return { ok: false, reason: 'empty prompt' };
  if (!cd) return { ok: false, reason: 'missing cwd' };

  const tools = await detectInstalledLlmTools({ onlyAutoExec: true });
  const terminalSupport = await canLaunchNewTerminal({ env });

  if (tools.length === 0) {
    return { ok: false, reason: 'no supported LLM CLI detected (auto-exec)', terminalSupport };
  }

  const chosenTool =
    tools.length === 1
      ? tools[0]
      : tools.find((t) => t.id === preferredToolId) ||
        (await withRl(async (rl) => {
          const picked = await promptSelect(rl, {
            title:
              `${bold('Pick an LLM CLI')}\n` +
              `${dim('We will launch it with a pre-filled migration prompt so it can run the port and resolve conflicts.')}`,
            options: tools.map((t) => ({
              value: t.id,
              label: `${cyan(t.id)} — ${t.label}${t.note ? ` ${dim(`— ${t.note}`)}` : ''}`,
            })),
            defaultIndex: 0,
          });
          return tools.find((t) => t.id === picked) || tools[0];
        }));

  // For now only Codex supports auto-exec.
  if (chosenTool.id !== 'codex') {
    return { ok: false, reason: `unsupported tool for auto-exec: ${chosenTool.id}`, terminalSupport };
  }

  const launchOptions = [];
  if (terminalSupport.ok) {
    launchOptions.push({ value: 'new-terminal', label: `${green('recommended')} — launch in a new terminal window` });
  }
  if (allowRunHere) {
    launchOptions.push({ value: 'here', label: `run in this terminal ${dim('(will take over this session)')}` });
  }
  if (allowCopyOnly) {
    launchOptions.push({ value: 'copy', label: `copy the prompt and run it yourself` });
  }

  const launchMode =
    launchOptions.length === 1
      ? launchOptions[0].value
      : await withRl(async (rl) => {
          return await promptSelect(rl, {
            title: `${bold('How do you want to run the migration assistant?')}`,
            options: launchOptions,
            defaultIndex: 0,
          });
        });

  const permissionMode =
    CODEX_PERMISSION_MODES.length === 1 || !isTty()
      ? defaultPermissionMode
      : await withRl(async (rl) => {
          const opts = codexPermissionOptions();
          const v = await promptSelect(rl, {
            title:
              `${bold('LLM permissions')}\n` +
              `${dim('Choose how much autonomy the LLM should have while running commands to migrate + resolve conflicts.')}`,
            options: opts,
            defaultIndex: Math.max(0, opts.findIndex((o) => o.value === defaultPermissionMode)),
          });
          return String(v || defaultPermissionMode);
        });

  if (launchMode === 'copy') {
    return { ok: true, launched: false, mode: 'copy', tool: chosenTool.id, permissionMode, terminalSupport };
  }

  if (launchMode === 'here') {
    await runCodexExecHere({ cd, permissionMode, promptText: prompt, env });
    return { ok: true, launched: true, mode: 'here', tool: chosenTool.id, permissionMode, terminalSupport };
  }

  // new-terminal
  const script = buildCodexExecScript({ cd, permissionMode, promptText: prompt });
  const res = await launchScriptInNewTerminal({ scriptText: script, title: title || 'Happy Stacks migration (LLM)' });
  if (!res.ok) {
    return { ok: false, reason: res.reason || 'failed to launch terminal', terminalSupport };
  }
  return { ok: true, launched: true, mode: 'new-terminal', tool: chosenTool.id, permissionMode, terminalSupport };
}

export async function printAndMaybeCopyPrompt({ promptText, copy = false }) {
  const prompt = String(promptText ?? '').trimEnd();
  // eslint-disable-next-line no-console
  console.log(prompt);
  if (!copy) return { ok: true, copied: false };
  if (!(await clipboardAvailable())) return { ok: true, copied: false };
  const res = await copyTextToClipboard(prompt);
  return { ok: true, copied: Boolean(res.ok) };
}

export function renderLlmHelpBlock({ title, subtitle, promptText, detectedTools, terminalSupport }) {
  const tools = Array.isArray(detectedTools) ? detectedTools : [];
  const lines = [];
  lines.push('');
  lines.push(banner(title || 'LLM help', { subtitle: subtitle || 'Copy/paste this into your LLM to drive the migration.' }));
  lines.push(promptText);
  if (tools.length) {
    lines.push('');
    lines.push(sectionTitle('Detected LLM CLIs (auto-exec capable)'));
    lines.push(bullets(tools.map((t) => `- ${dim(t.id)}: ${t.label}${t.note ? ` ${dim(`— ${t.note}`)}` : ''}`)));
  } else {
    lines.push('');
    lines.push(dim('No auto-exec LLM CLI detected (codex). You can still paste the prompt into any LLM UI.'));
  }
  if (terminalSupport?.ok) {
    lines.push('');
    lines.push(dim(`Terminal launch: ${green('supported')}`));
  } else if (terminalSupport) {
    lines.push('');
    lines.push(dim(`Terminal launch: ${yellow('not available')} ${dim(`(${terminalSupport.reason || 'unknown'})`)}`));
  }
  lines.push('');
  return lines.join('\n');
}

