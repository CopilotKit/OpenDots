import { z } from 'zod';

export const learningContainerIdSchema = z
  .string()
  .max(64)
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    'Use 1–64 lowercase letters, numbers, and single hyphens.',
  )
  .nullable();

export function validateLearningSettings(
  containerId: string | null,
  delivery: boolean,
) {
  if (!learningContainerIdSchema.safeParse(containerId).success)
    throw new Error(
      'Dot Learning container ID must use 1–64 lowercase letters, numbers, and single hyphens.',
    );
  if (delivery && !containerId)
    throw new Error('Dot skill delivery requires a Learning container.');
}
