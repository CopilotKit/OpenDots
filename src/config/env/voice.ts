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

export const voiceEnvSchema = z.object({
  VOICE_API_KEY: optionalString,
  VOICE_MODEL: optionalString,
  VOICE_NAME: z.string().min(1).default('marin'),
});

export type VoiceEnv = z.infer<typeof voiceEnvSchema>;