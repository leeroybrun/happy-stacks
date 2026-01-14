import { getStackName } from './paths.mjs';

function sanitizeDnsLabel(raw, { fallback = 'stack' } = {}) {
  const s = String(raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
  return s || fallback;
}

export function resolveLocalhostHost({ stackMode, stackName = getStackName() } = {}) {
  if (!stackMode) return 'localhost';
  if (!stackName || stackName === 'main') return 'localhost';
  return `happy-${sanitizeDnsLabel(stackName)}.localhost`;
}
