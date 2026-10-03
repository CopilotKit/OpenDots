import { z } from 'zod';

const LOCAL_HOSTS = ['127.0.0.1', '::1', 'localhost'] as const;
export const isLocalHost = (host: string): boolean =>
  (LOCAL_HOSTS as readonly string[]).includes(host);

export const coreEnvSchema = z.object({
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().positive().max(65_535).default(4310),
  DATABASE_PATH: z.string().min(1).default('data/opendots.sqlite'),
  OWNER_ID: z.string().min(1).default('opendots-owner'),
  OWNER_TOKEN: z.string().min(24).optional(),
  INTELLIGENCE_API_KEY: z.string().optional(),
  INTELLIGENCE_API_URL: z.string().url().optional(),
  INTELLIGENCE_WS_URL: z.string().url().optional(),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
  OPENAI_MODEL: z.string().optional(),
  APP_ORIGIN: z.string().url().optional(),
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('production'),
});

export type CoreEnv = z.infer<typeof coreEnvSchema>;

export const EXTERNAL_OWNER_TOKEN_ERROR =
  'External binding requires an OWNER_TOKEN of at least 24 characters.';