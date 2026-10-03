import { z } from 'zod';

export const WEB_SEARCH_PROVIDERS = ['parallel', 'browser', 'disabled'] as const;
export type WebSearchProvider = (typeof WEB_SEARCH_PROVIDERS)[number];

export const parallelEnvSchema = z.object({
  WEB_SEARCH_PROVIDER: z.enum(WEB_SEARCH_PROVIDERS).default('parallel'),
  PARALLEL_API_KEY: z.string().optional(),
});

export type ParallelEnv = z.infer<typeof parallelEnvSchema>;