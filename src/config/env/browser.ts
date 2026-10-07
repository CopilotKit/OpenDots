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

export const browserEnvSchema = z.object({
  BROWSER_SECRET: z
    .string()
    .min(24, 'BROWSER_SECRET must be at least 24 characters.'),
  BROWSER_HOST: z.string().min(1).default('127.0.0.1'),
  BROWSER_PORT: z.coerce.number().int().positive().max(65_535).default(4311),
  BROWSER_URL: optionalUrl,
});

export type BrowserEnv = z.infer<typeof browserEnvSchema>;