import type { z } from 'zod';

type Parsed<T> = { success: true; value: T } | { success: false };

// Parses JSON text and checks it against a schema, without throwing.
export async function safeParseJSON<T>({
  text,
  schema,
}: {
  text: string;
  schema: z.ZodType<T>;
}): Promise<Parsed<T>> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { success: false };
  }
  return safeValidateTypes({ value: raw, schema });
}

export async function safeValidateTypes<T>({
  value,
  schema,
}: {
  value: unknown;
  schema: z.ZodType<T>;
}): Promise<Parsed<T>> {
  const result = schema.safeParse(value);
  return result.success
    ? { success: true, value: result.data }
    : { success: false };
}
