import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

export const confirmationSchema = z
  .object({ mode: z.enum(['confirm', 'unattended']) })
  .strict();
export function readConfirmationPolicy(path: string, defaultConfirm = true) {
  if (!existsSync(path))
    return {
      mode: defaultConfirm ? ('confirm' as const) : ('unattended' as const),
    };
  try {
    return confirmationSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return { mode: 'confirm' as const };
  }
}
export function writeConfirmationPolicy(path: string, input: unknown) {
  const policy = confirmationSchema.parse(input);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(policy), 'utf8');
  renameSync(temporary, path);
  return policy;
}
