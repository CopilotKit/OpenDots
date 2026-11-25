import { z } from 'zod';
import type { ModelCheck } from '../shared/types.js';
import type { ModelConfig } from './platform-config.js';

const MAX_LISTED_MODELS = 50;
const modelList = z.object({
  data: z.array(z.object({ id: z.string().min(1).max(200) })),
});

// Ollama lists `llama3.2:latest` but also accepts the untagged name.
function sameModel(configured: string, listed: string) {
  const tagged = (name: string) =>
    name.includes(':') ? name : `${name}:latest`;
  return tagged(configured) === tagged(listed);
}

/**
 * Asks the configured OpenAI-compatible endpoint for its model list. Messages
 * name settings and endpoints, never credentials or provider response bodies.
 */
export async function checkModelEndpoint(
  config: ModelConfig,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 5000,
): Promise<ModelCheck> {
  const ollama = config.modelProvider === 'ollama';
  const provider = config.modelProvider;
  const fail = (
    message: string,
    hint?: string,
    models: string[] = [],
  ): ModelCheck => ({
    ok: false,
    provider,
    models,
    message,
    ...(hint ? { hint } : {}),
  });
  const endpointHint = "Point `OLLAMA_BASE_URL` at Ollama's `/v1` endpoint.";
  if (!ollama && !config.apiKey)
    return fail(
      "OPENAI_API_KEY isn't set.",
      'Add it to the server environment, then restart.',
    );
  let response: Response;
  try {
    response = await fetchImpl(`${config.baseUrl.replace(/\/+$/, '')}/models`, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return ollama
      ? fail(
          `Ollama isn't running at ${config.baseUrl}.`,
          'Start it (open the Ollama app or run `ollama serve`), then check again.',
        )
      : fail(
          "The model API isn't reachable.",
          'Check `OPENAI_BASE_URL` and your network.',
        );
  }
  if (!response.ok)
    return ollama
      ? fail(
          `Ollama at ${config.baseUrl} answered HTTP ${response.status}.`,
          endpointHint,
        )
      : response.status === 401 || response.status === 403
        ? fail(
            'The model API rejected the API key.',
            'Check `OPENAI_API_KEY`, then restart.',
          )
        : fail(
            `The model API answered HTTP ${response.status}.`,
            'Check `OPENAI_BASE_URL`.',
          );
  const parsed = modelList.safeParse(await response.json().catch(() => null));
  if (!parsed.success)
    return ollama
      ? fail(`${config.baseUrl} didn't return a model list.`, endpointHint)
      : fail(
          "The model API didn't return a model list.",
          'Check `OPENAI_BASE_URL`.',
        );
  const ids = [...new Set(parsed.data.data.map((model) => model.id))].sort();
  const variable = ollama ? 'OLLAMA_MODEL' : 'OPENAI_MODEL';
  if (ollama && !ids.length)
    return fail(
      'Ollama has no models yet.',
      'Run `ollama pull llama3.2`, then set `OLLAMA_MODEL` and restart.',
    );
  const listed = ids.slice(0, MAX_LISTED_MODELS);
  if (!config.model)
    return fail(
      `${variable} isn't set.`,
      'Set it to an available model, then restart.',
      listed,
    );
  const match = ids.find((id) => sameModel(config.model!, id));
  if (!match)
    return ollama
      ? fail(
          `Ollama doesn't have ${config.model} yet.`,
          `Run \`ollama pull ${config.model}\`, then check again.`,
          listed,
        )
      : fail(
          `The model API doesn't list ${config.model}.`,
          'Check `OPENAI_MODEL`.',
          listed,
        );
  return {
    ok: true,
    provider,
    // On success, offer only the other models.
    models: ids.filter((id) => id !== match).slice(0, MAX_LISTED_MODELS),
    message: `${ollama ? 'Ollama is running' : 'The model API is reachable'} and has ${config.model}.`,
  };
}
