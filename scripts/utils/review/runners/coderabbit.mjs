import { runCaptureResult } from '../../proc/proc.mjs';

export async function runCodeRabbitReview({ repoDir, baseRef, env }) {
  const args = [
    'review',
    '--plain',
    '--no-color',
    '--type',
    'all',
    '--cwd',
    repoDir,
  ];
  if (baseRef) {
    args.push('--base', baseRef);
  }
  const res = await runCaptureResult('coderabbit', args, { cwd: repoDir, env });
  return { ...res, stdout: res.out, stderr: res.err };
}

