import { z } from 'zod';

export const browserEnvSchema = z.object({
  BROWSER_SECRET: z
    .string()
    .min(24, 'BROWSER_SECRET must be at least 24 characters.'),
  BROWSER_HOST: z.string().min(1).default('127.0.0.1'),
  BROWSER_PORT: z.coerce.number().int().positive().max(65_535).default(4311),
  BROWSER_URL: z.string().url().optional(),
});

export type BrowserEnv = z.infer<typeof browserEnvSchema>;