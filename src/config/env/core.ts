import { z } from 'zod';

const LOCAL_HOSTS = ['127.0.0.1', '::1', 'localhost'] as const;
export const isLocalHost = (host: string): boolean =>
  (LOCAL_HOSTS as readonly string[]).includes(host);

const blankToUndefined = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
};

const optionalUrl = z
  .string()
  .optional()
  .transform((value, ctx) => {
    const normalized = blankToUndefined(value);
    if (normalized === undefined) return undefined;
    try {
      return new URL(normalized).toString();
    } catch {
      ctx.addIssue({ code: 'custom', message: 'Invalid URL' });
      return z.NEVER;
    }
  });

const optionalString = z
  .string()
  .optional()
  .transform((value) => blankToUndefined(value))
  .refine((value) => value === undefined || value.length >= 1, {
    message: 'must not be empty',
  });

export const coreEnvSchema = z.object({
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().positive().max(65_535).default(4310),
  DATABASE_PATH: z.string().min(1).default('data/opendots.sqlite'),
  OWNER_ID: z.string().min(1).default('opendots-owner'),
  OWNER_TOKEN: z
    .string()
    .optional()
    .transform((value) => value?.trim())
    .refine((value) => value === undefined || value.length >= 24, {
      message: 'OWNER_TOKEN must be at least 24 characters',
    }),
  INTELLIGENCE_API_URL: optionalUrl,
  INTELLIGENCE_WS_URL: optionalUrl,
  OPENAI_API_KEY: optionalString,
  OPENAI_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
  OPENAI_MODEL: optionalString,
  APP_ORIGIN: optionalString,
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('production'),
});

export type CoreEnv = z.infer<typeof coreEnvSchema>;

export const EXTERNAL_OWNER_TOKEN_ERROR =
  'External binding requires an OWNER_TOKEN of at least 24 characters.';

/**
 * `copilotkit project select` writes the CLI name and deletes the template name.
 */
export const INTELLIGENCE_API_KEY_ENV_NAMES = [
  'CPK_INTELLIGENCE_API_KEY',
  'INTELLIGENCE_API_KEY',
] as const;
export const INTELLIGENCE_WS_URL_ENV_NAMES = [
  'INTELLIGENCE_GATEWAY_WS_URL',
  'INTELLIGENCE_WS_URL',
] as const;

const firstNonBlank = (
  env: NodeJS.ProcessEnv,
  names: readonly string[],
): string | undefined => {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
};

export const intelligenceApiKeyFromEnv = (
  env: NodeJS.ProcessEnv = process.env,
): string | undefined => firstNonBlank(env, INTELLIGENCE_API_KEY_ENV_NAMES);

export const intelligenceWsUrlFromEnv = (
  env: NodeJS.ProcessEnv = process.env,
): string | undefined => firstNonBlank(env, INTELLIGENCE_WS_URL_ENV_NAMES);

export const DEFAULT_DEV_APP_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
] as const;

export function resolveAppOrigins(
  appOrigin: string | undefined,
  nodeEnv: string | undefined,
): string[] | undefined {
  if (appOrigin)
    return appOrigin
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
  return nodeEnv === 'development' ? [...DEFAULT_DEV_APP_ORIGINS] : undefined;
}