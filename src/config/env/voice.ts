import { z } from 'zod';

export const voiceEnvSchema = z.object({
  VOICE_API_KEY: z.string().optional(),
  VOICE_MODEL: z.string().optional(),
  VOICE_NAME: z.string().min(1).default('marin'),
});

export type VoiceEnv = z.infer<typeof voiceEnvSchema>;