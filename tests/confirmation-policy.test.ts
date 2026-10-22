import { expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readConfirmationPolicy,
  writeConfirmationPolicy,
} from '../src/server/confirmation-policy.js';

it('defaults to confirmations, persists owner changes and falls back to confirmations on invalid policy', () => {
  const directory = mkdtempSync(join(tmpdir(), 'confirmation-policy-'));
  try {
    const path = join(directory, 'policy.json');
    expect(readConfirmationPolicy(path).mode).toBe('confirm');
    writeConfirmationPolicy(path, { mode: 'unattended' });
    expect(readConfirmationPolicy(path).mode).toBe('unattended');
    writeConfirmationPolicy(path, { mode: 'confirm' });
    expect(readConfirmationPolicy(path).mode).toBe('confirm');
    expect(() => writeConfirmationPolicy(path, { mode: 'oops' })).toThrow();
    writeFileSync(path, '{invalid');
    expect(readConfirmationPolicy(path).mode).toBe('confirm');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
