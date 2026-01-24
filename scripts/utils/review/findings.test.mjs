import test from 'node:test';
import assert from 'node:assert/strict';

import { formatTriageMarkdown, parseCodeRabbitPlainOutput, parseCodexReviewText } from './findings.mjs';

test('parseCodeRabbitPlainOutput parses CodeRabbit plain blocks', () => {
  const out = [
    '============================================================================',
    'File: cli/src/utils/spawnHappyCLI.invocation.test.ts',
    'Line: 17 to 31',
    'Type: potential_issue',
    '',
    'Comment:',
    'Dynamic imports may be cached, causing test isolation issues.',
    '',
    'Some more details.',
    '',
    'Prompt for AI Agent:',
    'Do the thing.',
    '',
    '============================================================================',
    'File: expo-app/sources/app/(app)/_layout.tsx',
    'Line: 29 to 35',
    'Type: potential_issue',
    '',
    'Comment:',
    "Hooks order violation: useUnistyles() called after conditional return.",
    '',
    'More details.',
  ].join('\n');

  const findings = parseCodeRabbitPlainOutput(out);
  assert.equal(findings.length, 2);
  assert.equal(findings[0].file, 'cli/src/utils/spawnHappyCLI.invocation.test.ts');
  assert.deepEqual(findings[0].lines, { start: 17, end: 31 });
  assert.equal(findings[0].type, 'potential_issue');
  assert.equal(findings[0].title, 'Dynamic imports may be cached, causing test isolation issues.');
  assert.match(findings[0].comment, /Some more details/);
  assert.match(findings[0].prompt, /Do the thing/);
});

test('parseCodexReviewText extracts findings JSON trailer', () => {
  const review = [
    'Overall verdict: looks good.',
    '',
    '===FINDINGS_JSON===',
    JSON.stringify(
      [
        {
          severity: 'major',
          file: 'server/sources/main.light.ts',
          title: 'Do not exit after startup',
          recommendation: 'Remove process.exit(0) on success.',
        },
      ],
      null,
      2
    ),
  ].join('\n');

  const findings = parseCodexReviewText(review);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].file, 'server/sources/main.light.ts');
  assert.equal(findings[0].severity, 'major');
});

test('formatTriageMarkdown includes required workflow fields', () => {
  const md = formatTriageMarkdown({
    runLabel: 'review-123',
    baseRef: 'upstream/main',
    findings: [
      {
        reviewer: 'coderabbit',
        id: 'CR-001',
        file: 'cli/src/x.ts',
        title: 'Thing',
        type: 'potential_issue',
      },
    ],
  });
  assert.match(md, /Final decision: \*\*TBD\*\*/);
  assert.match(md, /Verified in validation worktree:/);
  assert.match(md, /Commit:/);
});

