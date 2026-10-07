import { z } from 'zod';

const optionalUrl = z
  .string()
  .optional()
  .transform((value, ctx) => {
    const trimmed = value?.trim();
    if (!trimmed) return undefined;
    try {
      return new URL(trimmed).toString();
    } catch {
      ctx.addIssue({ code: 'custom', message: 'Invalid URL' });
      return z.NEVER;
    }
  });

const optionalString = z
  .string()
  .optional()
  .transform((value) => {
    if (value === undefined) return undefined;
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
  })
  .refine((value) => value === undefined || value.length >= 1, {
    message: 'must not be empty',
  });

export const computerEnvSchema = z.object({
  COMPUTER_SUPERVISOR_URL: optionalUrl,
  COMPUTER_SUPERVISOR_TOKEN: optionalString,
  COMPUTER_TOKEN: optionalString,
  COMPUTER_NAMESPACE: z.string().min(1).default('opendots'),
  COMPUTER_MEMORY_BYTES: z.coerce.number().int().positive().optional(),
  COMPUTER_RUNTIME: optionalString,
  ENGINE_SOCKET: optionalString,
});

export type ComputerEnv = z.infer<typeof computerEnvSchema>;