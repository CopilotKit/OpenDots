import { openaiCompatibleText } from '@tanstack/ai-openai/compatible';

export type DotModelApi = 'chat-completions' | 'responses';

export type DotReasoningEffort =
  'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type DotModelSettings = {
  dotModelApi?: DotModelApi;
  dotMaxOutputTokens?: number;
  dotReasoningEffort?: DotReasoningEffort;
};

export type ResolvedDotModelSettings = Required<
  Pick<DotModelSettings, 'dotModelApi' | 'dotMaxOutputTokens'>
> &
  Pick<DotModelSettings, 'dotReasoningEffort'>;

function validateModelApi(api: string): DotModelApi {
  if (api !== 'chat-completions' && api !== 'responses') {
    throw new Error('DOT_MODEL_API must be chat-completions or responses.');
  }
  return api;
}

function validateMaxOutputTokens(budget: number): number {
  if (!Number.isSafeInteger(budget) || budget <= 0) {
    throw new Error('DOT_MAX_OUTPUT_TOKENS must be a positive safe integer.');
  }
  return budget;
}

function validateReasoningEffort(effort: string): DotReasoningEffort {
  switch (effort) {
    case 'none':
    case 'minimal':
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
    case 'max':
      return effort;
    default:
      throw new Error(
        'DOT_REASONING_EFFORT must be none, minimal, low, medium, high, xhigh, or max.',
      );
  }
}

export function dotModelSettingsFromEnv(
  env: Record<string, string | undefined>,
): ResolvedDotModelSettings {
  const dotModelApi = validateModelApi(
    env.DOT_MODEL_API?.trim() || 'chat-completions',
  );
  const budget = env.DOT_MAX_OUTPUT_TOKENS?.trim() || '2200';
  if (!/^\d+$/.test(budget)) {
    throw new Error('DOT_MAX_OUTPUT_TOKENS must be a positive safe integer.');
  }
  const effort = env.DOT_REASONING_EFFORT?.trim();
  return {
    dotModelApi,
    dotMaxOutputTokens: validateMaxOutputTokens(Number(budget)),
    ...(effort ? { dotReasoningEffort: validateReasoningEffort(effort) } : {}),
  };
}

export function createDotModel(
  config: DotModelSettings & {
    model?: string;
    apiKey?: string;
    baseUrl: string;
  },
) {
  if (!config.model || !config.apiKey) {
    throw new Error('Model configuration is required.');
  }
  const api = validateModelApi(
    config.dotModelApi === undefined ? 'chat-completions' : config.dotModelApi,
  );
  const budget = validateMaxOutputTokens(
    config.dotMaxOutputTokens === undefined ? 2200 : config.dotMaxOutputTokens,
  );
  const effort =
    config.dotReasoningEffort === undefined
      ? undefined
      : validateReasoningEffort(config.dotReasoningEffort);
  const adapter = openaiCompatibleText(config.model, {
    apiKey: config.apiKey,
    baseURL: config.baseUrl ?? 'https://api.openai.com/v1',
    api,
    maxRetries: 1,
  });
  const modelOptions: Record<string, unknown> =
    api === 'responses'
      ? {
          max_output_tokens: budget,
          store: false,
          include: ['reasoning.encrypted_content'],
          ...(effort === undefined ? {} : { reasoning: { effort } }),
        }
      : {
          max_completion_tokens: budget,
          ...(effort === undefined ? {} : { reasoning_effort: effort }),
        };
  return { adapter, modelOptions };
}
