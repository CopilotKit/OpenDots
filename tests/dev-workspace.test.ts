import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DevWorkspace } from '../src/server/dev-workspace.js';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' });

it('edits on a branch, refuses protected files, and only merges on apply', async () => {
  const root = mkdtempSync(join(tmpdir(), 'opendots-dev-'));
  const repo = join(root, 'app');
  mkdirSync(join(repo, 'src', 'shared'), { recursive: true });
  mkdirSync(join(repo, 'node_modules'));
  // A package file that must survive the dev workspace being removed.
  writeFileSync(join(repo, 'node_modules', 'keep.txt'), 'installed');
  writeFileSync(
    join(repo, 'src', 'math.ts'),
    'export const add = (a: number, b: number) => a - b;\n',
  );
  writeFileSync(
    join(repo, 'src', 'shared', 'capabilities.ts'),
    'export const groups = [];\n',
  );
  writeFileSync(join(repo, '.gitignore'), 'node_modules\n');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A');
  git(
    repo,
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@t',
    'commit',
    '-q',
    '-m',
    'init',
  );
  let dev = new DevWorkspace(
    repo,
    join(root, 'reviews.sqlite'),
    join(root, 'app-dev'),
  );
  try {
    // Checks are the real project's job; stub them for this throwaway repo.
    dev.checks = async () => ({ text: '## Tests: PASS', passed: true });
    writeFileSync(join(repo, 'uncommitted.txt'), 'owner work');
    await expect(dev.start('stale baseline')).rejects.toThrow(/uncommitted/);
    rmSync(join(repo, 'uncommitted.txt'));
    await dev.withSession('owner-thread', () => dev.start('fix add'));
    await expect(
      dev.withSession('other-thread', () => dev.discard()),
    ).rejects.toThrow(/Another conversation/);
    await expect(
      dev.withSession('owner-thread', () => dev.start('replacement')),
    ).rejects.toThrow(/unfinished/);
    expect(() => dev.write('src/shared/capabilities.ts', 'hacked')).toThrow(
      /protected/,
    );
    expect(() => dev.read('../secret.txt')).toThrow(/outside/);
    expect(() => dev.write('SRC/SHARED/CAPABILITIES.TS', 'bypass')).toThrow(
      /protected/,
    );
    expect(() => dev.write(join(root, 'escape.ts'), 'bypass')).toThrow(
      /outside/,
    );
    dev.edit('src/math.ts', 'a - b', 'a + b');
    // The live checkout is untouched until apply.
    expect(readFileSync(join(repo, 'src', 'math.ts'), 'utf8')).toContain(
      'a - b',
    );
    dev.checks = async () => ({ text: '## Tests: FAIL', passed: false });
    await expect(dev.submit('Broken', 'Do not publish')).rejects.toThrow(
      /Checks failed/,
    );
    expect(dev.reviews()).toHaveLength(0);
    dev.close();
    dev = new DevWorkspace(
      repo,
      join(root, 'reviews.sqlite'),
      join(root, 'app-dev'),
    );
    expect(dev.status()).toMatchObject({
      active: true,
      sourceThreadId: 'owner-thread',
    });
    await expect(
      dev.withSession('other-thread', () => dev.discard()),
    ).rejects.toThrow(/Another conversation/);
    dev.checks = async () => ({ text: '## Tests: PASS', passed: true });
    const review = await dev.withSession('owner-thread', () =>
      dev.submit('Fix add', 'add() subtracted instead of adding.'),
    );
    expect(review.sourceThreadId).toBe('owner-thread');
    expect(review).toMatchObject({ passed: true, status: 'pending' });
    expect(review.diff).toContain(
      '+export const add = (a: number, b: number) => a + b;',
    );
    writeFileSync(join(repo, 'uncommitted.txt'), 'owner work');
    await expect(dev.apply(review.id)).rejects.toThrow(/local changes/);
    rmSync(join(repo, 'uncommitted.txt'));
    await dev.apply(review.id);
    expect(readFileSync(join(repo, 'src', 'math.ts'), 'utf8')).toContain(
      'a + b',
    );
    expect(dev.reviews()[0].status).toBe('applied');
    expect(git(repo, 'branch', '--list', 'dev/*').trim()).toBe('');
    // Discarding a workspace must never delete the shared packages.
    await dev.start('second change');
    await dev.discard();
    expect(readFileSync(join(repo, 'node_modules', 'keep.txt'), 'utf8')).toBe(
      'installed',
    );
  } finally {
    dev.close();
    rmSync(root, { recursive: true, force: true });
  }
});
