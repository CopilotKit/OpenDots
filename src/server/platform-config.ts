import type { WebConfig } from './parallel.js';
import type { ModelProvider, SetupStatus } from '../shared/types.js';

// `copilotkit project select` writes the CLI name and deletes the template name.
const INTELLIGENCE_API_KEY_ENV_NAMES = [
  'CPK_INTELLIGENCE_API_KEY',
  'INTELLIGENCE_API_KEY',
] as const;
export const INTELLIGENCE_KEY_MISSING_LABEL = `${INTELLIGENCE_API_KEY_ENV_NAMES[1]} (or ${INTELLIGENCE_API_KEY_ENV_NAMES[0]})`;
export const DEFAULT_AGENT_RUN_TIMEOUT_MS = 90_000;
export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
export const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434/v1';
// Ollama ignores the bearer token, but OpenAI-compatible clients require one.
export const OLLAMA_PLACEHOLDER_API_KEY = 'ollama';
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export function intelligenceApiKeyFromEnv(
  env: Record<string, string | undefined>,
): string | undefined {
  return firstNonEmptyEnvValue(env, INTELLIGENCE_API_KEY_ENV_NAMES);
}

export function intelligenceWsUrlFromEnv(
  env: Record<string, string | undefined>,
): string | undefined {
  return firstNonEmptyEnvValue(env, [
    'INTELLIGENCE_GATEWAY_WS_URL',
    'INTELLIGENCE_WS_URL',
  ]);
}

export function agentRunTimeoutMsFromEnv(
  env: Record<string, string | undefined>,
): number {
  const raw = env.AGENT_RUN_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_AGENT_RUN_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_TIMER_DELAY_MS)
    throw new Error(
      `AGENT_RUN_TIMEOUT_MS must be an integer between 1 and ${MAX_TIMER_DELAY_MS}.`,
    );
  return value;
}

export interface ModelConfig {
  modelProvider: ModelProvider;
  apiKey?: string;
  model?: string;
  baseUrl: string;
}

export function modelConfigFromEnv(
  env: Record<string, string | undefined>,
): ModelConfig {
  const provider = env.MODEL_PROVIDER?.trim().toLowerCase() || 'openai';
  if (provider === 'openai')
    return {
      modelProvider: 'openai',
      apiKey: env.OPENAI_API_KEY,
      model: env.OPENAI_MODEL,
      baseUrl: env.OPENAI_BASE_URL ?? DEFAULT_OPENAI_BASE_URL,
    };
  if (provider === 'ollama')
    return {
      modelProvider: 'ollama',
      apiKey: OLLAMA_PLACEHOLDER_API_KEY,
      model: env.OLLAMA_MODEL?.trim() || undefined,
      baseUrl: ollamaBaseUrl(env.OLLAMA_BASE_URL),
    };
  throw new Error('MODEL_PROVIDER must be "openai" or "ollama".');
}

function ollamaBaseUrl(value: string | undefined): string {
  const raw = value?.trim() || DEFAULT_OLLAMA_BASE_URL;
  const url = URL.canParse(raw) ? new URL(raw) : undefined;
  if (
    !url ||
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      `OLLAMA_BASE_URL must be an http(s) URL without credentials, such as ${DEFAULT_OLLAMA_BASE_URL}.`,
    );
  // OLLAMA_HOST-style values omit the OpenAI-compatible /v1 path.
  if (url.pathname === '/') url.pathname = '/v1';
  return url.href.replace(/\/+$/, '');
}

function firstNonEmptyEnvValue(
  env: Record<string, string | undefined>,
  names: readonly string[],
): string | undefined {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

export interface PlatformConfig extends WebConfig {
  intelligenceKey?: string;
  intelligenceApiUrl?: string;
  intelligenceWsUrl?: string;
  /** Defaults to OpenAI when omitted. */
  modelProvider?: ModelProvider;
  model?: string;
  apiKey?: string;
  baseUrl: string;
  agentRunTimeoutMs?: number;
  computerSupervisorUrl?: string;
  computerSupervisorToken?: string;
  computerToken?: string;
  computerNamespace?: string;
  browserUrl?: string;
  browserSecret?: string;
  composioApiKey?: string;
  voiceKey?: string;
  voiceModel?: string;
  voiceName: string;
  slackChannel?: string;
  slackTeam?: string;
  slackUsers: string[];
  slackDotId?: string;
  runtimeUrl: string;
  ownerToken?: string;
}
export function setupStatus(
  config: PlatformConfig,
  slack = 'not_configured',
  activationFailed = false,
): SetupStatus {
  const ollama = config.modelProvider === 'ollama';
  const missing = [
    !config.intelligenceKey && INTELLIGENCE_KEY_MISSING_LABEL,
    !ollama && !config.apiKey && 'OPENAI_API_KEY',
    !config.model && (ollama ? 'OLLAMA_MODEL' : 'OPENAI_MODEL'),
  ].filter((item): item is string => !!item);
  const declaredSlack = !!(
    config.slackChannel &&
    config.slackTeam &&
    config.slackUsers.length
  );
  slack = declaredSlack
    ? activationFailed && slack !== 'online'
      ? 'activation_failed'
      : slack
    : config.slackChannel || config.slackTeam || config.slackUsers.length
      ? 'setup_required'
      : 'not_configured';
  return {
    intelligence: !!config.intelligenceKey,
    model: !!((ollama || config.apiKey) && config.model),
    modelProvider: ollama ? 'ollama' : 'openai',
    // Show the Ollama endpoint for setup; OPENAI_BASE_URL may name a private proxy.
    ...(ollama ? { modelBaseUrl: config.baseUrl } : {}),
    browser: !!(config.browserUrl && config.browserSecret),
    voice: !!(config.voiceKey && config.voiceModel && !missing.length),
    composio: !!config.composioApiKey,
    slack,
    missing,
  };
}
