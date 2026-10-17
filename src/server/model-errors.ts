// Turns a model provider failure into a sentence the owner can act on. The
// text reaches the chat window, so it never includes the key or the raw
// provider response body.
export function providerName(baseUrl: string | undefined): string {
  try {
    const host = new URL(baseUrl ?? '').hostname;
    if (host === 'openrouter.ai' || host.endsWith('.openrouter.ai'))
      return 'OpenRouter';
    if (host === 'api.openai.com') return 'OpenAI';
  } catch {
    // Fall through to the generic name.
  }
  return 'The model provider';
}

function statusOf(error: unknown): number | undefined {
  if (error && typeof error === 'object') {
    for (const key of ['status', 'statusCode'] as const) {
      const value = (error as Record<string, unknown>)[key];
      if (typeof value === 'number') return value;
    }
  }
  // OpenAI-compatible SDKs start their messages with the HTTP status.
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : '';
  const match = /^([45]\d\d)\b/.exec(message.trim());
  return match ? Number(match[1]) : undefined;
}

export function describeModelError(
  error: unknown,
  baseUrl: string | undefined,
): string | undefined {
  const provider = providerName(baseUrl);
  const status = statusOf(error);
  if (status === 401 || status === 403)
    return `${provider} didn’t accept the API key. Check the key in the server settings.`;
  if (status === 402)
    return `${provider} says the account is out of credits. Add credits, or pick a free model.`;
  if (status === 404)
    return `${provider} doesn’t have that model, or it isn’t available to your account.`;
  if (status === 429)
    return `${provider} is rate limiting this key. Wait a moment and try again.`;
  if (status != null && status >= 500)
    return `${provider} had a problem on its side. Try again in a moment.`;
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|fetch failed/i.test(message))
    return `ploop couldn’t reach ${provider === 'The model provider' ? 'the model provider' : provider}. Check the internet connection.`;
  return undefined;
}
