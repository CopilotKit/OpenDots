import { z } from 'zod';
import {
  browserEnvSchema,
  type BrowserEnv,
} from './browser.js';
import {
  computerEnvSchema,
  type ComputerEnv,
} from './computer.js';
import {
  coreEnvSchema,
  EXTERNAL_OWNER_TOKEN_ERROR,
  isLocalHost,
  type CoreEnv,
} from './core.js';
import {
  parallelEnvSchema,
  type ParallelEnv,
} from './parallel.js';
import { slackEnvSchema, type SlackEnv } from './slack.js';
import { voiceEnvSchema, type VoiceEnv } from './voice.js';

export const serverBrowserFieldsSchema = z.object({
  BROWSER_URL: z.string().url().optional(),
  BROWSER_SECRET: z.string().optional(),
});

export const serverEnvSchema = z.object({
  ...coreEnvSchema.shape,
  ...parallelEnvSchema.shape,
  ...slackEnvSchema.shape,
  ...voiceEnvSchema.shape,
  ...computerEnvSchema.shape,
  ...serverBrowserFieldsSchema.shape,
});

export type ServerEnv = CoreEnv &
  ParallelEnv &
  SlackEnv &
  VoiceEnv &
  ComputerEnv & {
    BROWSER_URL?: string;
    BROWSER_SECRET?: string;
  };

const formatIssues = (issues: z.ZodIssue[]): string =>
  issues
    .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
    .join('; ');

export function parseServerEnv(input: NodeJS.ProcessEnv = process.env): ServerEnv {
  const parsed = serverEnvSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(`Invalid server environment: ${formatIssues(parsed.error.issues)}`);
  }
  const env = parsed.data;
  if (!isLocalHost(env.HOST) && !env.OWNER_TOKEN) {
    throw new Error(EXTERNAL_OWNER_TOKEN_ERROR);
  }
  return env;
}

export function parseBrowserEnv(
  input: NodeJS.ProcessEnv = process.env,
): BrowserEnv {
  const parsed = browserEnvSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(`Invalid browser environment: ${formatIssues(parsed.error.issues)}`);
  }
  return parsed.data;
}