import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  changedFiles,
  noteName,
  recordDeveloperChange,
} from '../src/server/dev-changelog.js';
import type { DevReview } from '../src/server/dev-workspace.js';

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));

const review: DevReview = {
  id: 'abc12345-0000',
  branch: 'developer/settle-fix',
  title: 'Fix the NBA settle job: retry on timeout',
  summary:
    'The settle job gave up after one ESPN timeout; it now retries twice.',
  diff: ' localtools/nba_totals.py | 12 ++++++++----\n tests/x.test.ts | 4 ++++\n 2 files changed\n\ndiff --git a/localtools/nba_totals.py b/localtools/nba_totals.py\n@@ -1 +1 @@\n-a | 3\n+b\n',
  checks: 'all passed',
  passed: true,
  status: 'pending',
  createdAt: Date.UTC(2026, 9, 24, 15, 0),
};

it('lists the files a change touched from its diff stat, not from the patch', () => {
  expect(changedFiles(review.diff)).toEqual([
    'localtools/nba_totals.py (12)',
    'tests/x.test.ts (4)',
  ]);
});

it('records a change when submitted and its outcome when applied, in the Developer section', () => {
  const vault = mkdtempSync(join(tmpdir(), 'vault-'));
  cleanup.push(() => rmSync(vault, { recursive: true, force: true }));
  const note = recordDeveloperChange(vault, review, 'submitted');
  expect(noteName(review)).toBe(
    '2026-10-24 Fix the NBA settle job retry on timeout',
  );
  let text = readFileSync(note, 'utf8');
  expect(text).toContain('**Status:** waiting for review');
  expect(text).toContain('retries twice');
  expect(text).toContain('`localtools/nba_totals.py (12)`');
  recordDeveloperChange(vault, { ...review, status: 'applied' }, 'applied');
  text = readFileSync(note, 'utf8');
  expect(text).toContain('**Status:** applied');
  expect(text).toMatch(/: submitted\n- .*: applied\n$/);
  const log = readFileSync(join(vault, 'Developer', 'Change Log.md'), 'utf8');
  expect(log.match(/^- /gm)).toHaveLength(2);
  expect(log).toContain(
    'applied [[Developer/Changes/2026-10-24 Fix the NBA settle job retry on timeout|',
  );
  expect(
    readFileSync(join(vault, 'Developer', 'Developer.md'), 'utf8'),
  ).toContain('# Developer');
});
