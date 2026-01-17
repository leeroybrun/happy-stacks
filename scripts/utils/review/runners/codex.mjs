import { runCaptureResult } from '../../proc/proc.mjs';

export function extractCodexReviewFromJsonl(jsonlText) {
  const lines = String(jsonlText ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  // JSONL events typically look like: { "type": "...", "payload": {...} } or similar.
  // We keep this resilient by searching for keys matching the exec output format.
  for (const line of lines) {
    let obj = null;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const msg = obj?.msg ?? obj?.payload ?? obj;
    // We’ve observed EventMsg names like "ExitedReviewMode" in Codex protocol events.
    // Accept several shapes:
    // - { msg: { ExitedReviewMode: { review_output: {...} } } }
    // - { type: "ExitedReviewMode", review_output: {...} }
    const exited =
      msg?.ExitedReviewMode ??
      (obj?.type === 'ExitedReviewMode' ? obj : null) ??
      (msg?.type === 'ExitedReviewMode' ? msg : null);

    const reviewOutput = exited?.review_output ?? exited?.reviewOutput ?? null;
    if (reviewOutput) return reviewOutput;
  }
  return null;
}

export async function runCodexReview({ repoDir, baseRef, env, jsonMode }) {
  const args = ['review', '--cd', repoDir, '--color=never'];

  if (baseRef) {
    args.push('--base', baseRef);
  } else {
    // Codex requires one of --uncommitted/--base/--commit/prompt; baseRef should exist in our flow.
    args.push('--uncommitted');
  }

  if (jsonMode) {
    args.push('--json');
  }

  const res = await runCaptureResult('codex', args, { cwd: repoDir, env });
  return { ...res, stdout: res.out, stderr: res.err };
}

