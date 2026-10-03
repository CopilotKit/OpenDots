import { z } from 'zod';

export const slackEnvSchema = z.object({
  SLACK_CHANNEL_NAME: z.string().optional(),
  SLACK_TEAM_ID: z.string().optional(),
  SLACK_USER_IDS: z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  SLACK_DOT_ID: z.string().optional(),
});

export type SlackEnv = z.infer<typeof slackEnvSchema>;