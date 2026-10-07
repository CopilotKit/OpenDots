import { z } from 'zod';

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

export const slackEnvSchema = z.object({
  SLACK_CHANNEL_NAME: optionalString,
  SLACK_TEAM_ID: optionalString,
  SLACK_USER_IDS: z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  SLACK_DOT_ID: optionalString,
});

export type SlackEnv = z.infer<typeof slackEnvSchema>;