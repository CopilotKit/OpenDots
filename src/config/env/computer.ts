import { z } from 'zod';

export const computerEnvSchema = z.object({
  COMPUTER_SUPERVISOR_URL: z.string().url().optional(),
  COMPUTER_SUPERVISOR_TOKEN: z.string().optional(),
  COMPUTER_TOKEN: z.string().optional(),
  COMPUTER_NAMESPACE: z.string().min(1).default('opendots'),
  COMPUTER_MEMORY_BYTES: z.coerce.number().int().positive().optional(),
  COMPUTER_RUNTIME: z.string().optional(),
  ENGINE_SOCKET: z.string().optional(),
});

export type ComputerEnv = z.infer<typeof computerEnvSchema>;