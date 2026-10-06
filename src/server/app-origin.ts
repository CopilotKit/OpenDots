export function resolveAppOrigins(
  appOrigin: string | undefined,
  nodeEnv: string | undefined,
): string[] | undefined {
  if (appOrigin)
    return appOrigin
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
  return nodeEnv === 'development'
    ? ['http://localhost:5173', 'http://127.0.0.1:5173']
    : undefined;
}
