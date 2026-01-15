import { getStackName } from './paths.mjs';
import { sanitizeDnsLabel } from '../net/dns.mjs';

export function resolveLocalhostHost({ stackMode, stackName = getStackName() } = {}) {
  if (!stackMode) return 'localhost';
  if (!stackName || stackName === 'main') return 'localhost';
  return `happy-${sanitizeDnsLabel(stackName)}.localhost`;
}

