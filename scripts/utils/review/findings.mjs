function parseLineRange(raw) {
  const s = String(raw ?? '').trim();
  // Common CodeRabbit format: "17 to 31"
  const m = s.match(/^(\d+)\s+to\s+(\d+)$/i);
  if (m) return { start: Number(m[1]), end: Number(m[2]) };
  const n = s.match(/^(\d+)$/);
  if (n) {
    const v = Number(n[1]);
    return { start: v, end: v };
  }
  return null;
}

export function parseCodeRabbitPlainOutput(text) {
  const lines = String(text ?? '').split('\n');
  const findings = [];

  let current = null;
  let mode = null; // 'comment' | 'prompt' | null

  function flush() {
    if (!current) return;
    const comment = (current._commentLines ?? []).join('\n').trim();
    const prompt = (current._promptLines ?? []).join('\n').trim();
    const title =
      current.title ??
      comment
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)[0] ??
      '';

    findings.push({
      reviewer: 'coderabbit',
      file: current.file ?? '',
      lines: current.lines ?? null,
      type: current.type ?? '',
      title,
      comment,
      prompt: prompt || null,
    });
    current = null;
    mode = null;
  }

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trimEnd();

    if (trimmed.startsWith('============================================================================')) {
      flush();
      continue;
    }
    if (trimmed.startsWith('File: ')) {
      flush();
      current = { _commentLines: [], _promptLines: [] };
      current.file = trimmed.slice('File: '.length).trim();
      continue;
    }
    if (!current) continue;

    if (trimmed.startsWith('Line: ')) {
      const range = parseLineRange(trimmed.slice('Line: '.length).trim());
      current.lines = range;
      continue;
    }
    if (trimmed.startsWith('Type: ')) {
      current.type = trimmed.slice('Type: '.length).trim();
      continue;
    }
    if (trimmed === 'Comment:') {
      mode = 'comment';
      continue;
    }
    if (trimmed === 'Prompt for AI Agent:') {
      mode = 'prompt';
      continue;
    }

    if (mode === 'comment') {
      // Title is first non-empty comment line.
      if (!current.title && trimmed.trim()) current.title = trimmed.trim();
      current._commentLines.push(trimmed);
    } else if (mode === 'prompt') {
      current._promptLines.push(trimmed);
    }
  }

  flush();
  // Drop empty placeholders
  return findings.filter((f) => f.file && f.title);
}

export function parseCodexReviewText(reviewText) {
  const s = String(reviewText ?? '');
  const marker = '===FINDINGS_JSON===';
  const idx = s.indexOf(marker);
  if (idx < 0) return [];
  const jsonText = s.slice(idx + marker.length).trim();
  if (!jsonText) return [];

  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((x) => ({
      reviewer: 'codex',
      severity: x?.severity ?? null,
      file: x?.file ?? null,
      title: x?.title ?? null,
      recommendation: x?.recommendation ?? null,
      needsDiscussion: Boolean(x?.needsDiscussion),
    }))
    .filter((x) => x.file && x.title);
}

export function formatTriageMarkdown({ runLabel, baseRef, findings }) {
  const items = Array.isArray(findings) ? findings : [];
  const header = [
    `# Review triage: ${runLabel}`,
    '',
    `- Base ref: ${baseRef ?? ''}`,
    `- Findings: ${items.length}`,
    '',
    '## Mandatory workflow',
    '',
    'For each finding below:',
    '1) Open the referenced file/lines in the *validation worktree* (committed-only).',
    '2) Decide if it is a real bug/risk/correctness gap, already fixed, expected behavior, or style preference.',
    '3) Record a final decision + rationale here (`apply` / `adjust` / `defer`).',
    '4) If `apply/adjust`: implement in the main worktree as a clean commit (no unrelated changes), then sync that commit to validation.',
    '',
    'Notes:',
    '- Treat reviewer output as suggestions; verify against best practices and codebase invariants before applying.',
    '- Avoid brittle tests that assert on wording/phrasing/config; test observable behavior.',
    '',
  ].join('\n');

  const body = items
    .map((f) => {
      const lines = f.lines?.start ? `${f.lines.start}-${f.lines.end ?? f.lines.start}` : '';
      const meta = [
        `- [ ] \`${f.id ?? ''}\` reviewer=\`${f.reviewer ?? ''}\`${f.severity ? ` severity=\`${f.severity}\`` : ''}${
          f.type ? ` type=\`${f.type}\`` : ''
        } \`${f.file ?? ''}\`${lines ? ` (lines ${lines})` : ''}: ${f.title ?? ''}`,
        f.sourceLog ? `  - Source log: \`${f.sourceLog}\`` : null,
        '  - Final decision: **TBD** (apply|adjust|defer)',
        '  - Verified in validation worktree: **TBD**',
        '  - Rationale: **TBD**',
        '  - Action taken: **TBD**',
        '  - Commit: **TBD**',
        '  - Needs discussion: **TBD**',
      ];
      if (f.comment) meta.push(`  - Reviewer detail: ${String(f.comment).split('\n')[0].trim()}`);
      if (f.recommendation) meta.push(`  - Reviewer suggested fix: ${String(f.recommendation).split('\n')[0].trim()}`);
      return meta.filter(Boolean).join('\n');
    })
    .join('\n\n');

  return `${header}${body ? `${body}\n` : ''}`;
}
