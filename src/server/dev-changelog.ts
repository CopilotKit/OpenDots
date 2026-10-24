import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { DevReview } from './dev-workspace.js';

/**
 * The Developer Dot's own section of the owner's Obsidian vault: every change it
 * submits, and whether the owner applied or rejected it, whoever asked for it
 * (the owner in chat, or AJ by voice). Written by code when the review changes,
 * so the record cannot be skipped or embellished by the model.
 *
 *   Developer/Developer.md      what the section is (created once)
 *   Developer/Change Log.md     one line per event, newest last
 *   Developer/Changes/<day> <title>.md   one note per change
 */
export type DevEvent = 'submitted' | 'applied' | 'rejected';

const INDEX = `# Developer

The OpenDots Developer Dot's record. It edits OpenDots' own code on its own branch, runs
the checks, and submits each change for review. Nothing reaches the running app until the
owner applies it (in OpenDots, or by voice through AJ), and OpenDots is restarted.

- [[Developer/Change Log|Change Log]]: every change, submitted, applied or rejected.
- Changes/: one note per change, with its summary, its checks and the files it touched.

Written by OpenDots itself (src/server/dev-changelog.ts) whenever a review changes, so it
is complete whoever asked for the change.
`;

/** Files a change touched, from the "--stat" part of its diff. */
export function changedFiles(diff: string): string[] {
  const head = diff.split(/^diff --git /m)[0] ?? '';
  return head
    .split('\n')
    .map((line) => /^\s*(\S.*?)\s+\|\s+(\d+|Bin)/.exec(line))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => `${m[1]} (${m[2]})`);
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const stamp = (ms: number) =>
  new Date(ms).toLocaleString('en-CA', { hour12: false }).slice(0, 17);
const safe = (title: string) =>
  title
    .replace(/[\\/:*?"<>|#^[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);

export function noteName(review: DevReview): string {
  return `${day(review.createdAt)} ${safe(review.title) || review.id.slice(0, 8)}`;
}

export function recordDeveloperChange(
  vault: string,
  review: DevReview,
  event: DevEvent,
  now = Date.now(),
): string {
  const root = join(vault, 'Developer');
  mkdirSync(join(root, 'Changes'), { recursive: true });
  if (!existsSync(join(root, 'Developer.md')))
    writeFileSync(join(root, 'Developer.md'), INDEX);
  const log = join(root, 'Change Log.md');
  if (!existsSync(log))
    writeFileSync(
      log,
      '# Change Log\n\nBack to [[Developer/Developer|Developer]]. Newest last.\n\n',
    );
  const name = noteName(review);
  const note = join(root, 'Changes', `${name}.md`);
  if (event === 'submitted' || !existsSync(note)) {
    const files = changedFiles(review.diff);
    writeFileSync(
      note,
      [
        `# ${review.title}`,
        '',
        `Back to [[Developer/Change Log|Change Log]].`,
        '',
        `- **Status:** waiting for review`,
        `- **Submitted:** ${stamp(review.createdAt)}`,
        `- **Checks:** ${review.passed ? 'passed' : 'failed'}`,
        `- **Branch:** \`${review.branch}\``,
        `- **Review id:** \`${review.id}\``,
        '',
        '## What it does',
        '',
        review.summary.trim() || '(no summary given)',
        '',
        `## Files changed (${files.length})`,
        '',
        ...(files.length
          ? files.map((f) => `- \`${f}\``)
          : ['- (none listed)']),
        '',
        '## History',
        '',
        `- ${stamp(review.createdAt)}: submitted`,
        '',
      ].join('\n'),
    );
  }
  if (event !== 'submitted') {
    const text = readFileSync(note, 'utf8').replace(
      /- \*\*Status:\*\* .*/,
      `- **Status:** ${event}`,
    );
    writeFileSync(note, `${text.trimEnd()}\n- ${stamp(now)}: ${event}\n`);
  }
  appendFileSync(
    log,
    `- ${stamp(now)}: ${event} [[Developer/Changes/${name}|${review.title}]]\n`,
  );
  return note;
}
