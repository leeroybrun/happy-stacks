import { commandExists } from '../proc/commands.mjs';

const KNOWN_LLM_TOOLS = [
  { id: 'codex', cmd: 'codex', label: 'Codex CLI', note: 'Can run structured workflows locally.' },
  { id: 'claude', cmd: 'claude', label: 'Claude CLI', note: 'Can run interactive assistant sessions.' },
  { id: 'opencode', cmd: 'opencode', label: 'OpenCode', note: 'Local coding agent CLI (if installed).' },
  { id: 'aider', cmd: 'aider', label: 'Aider', note: 'Repo-aware coding assistant (if installed).' },
];

export async function detectInstalledLlmTools() {
  const installed = [];
  for (const t of KNOWN_LLM_TOOLS) {
    // eslint-disable-next-line no-await-in-loop
    const ok = await commandExists(t.cmd);
    if (ok) installed.push(t);
  }
  return installed;
}

