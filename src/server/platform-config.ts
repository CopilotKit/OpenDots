import type { WebConfig } from './parallel.js';
import type { SshTarget } from './ssh-computer.js';
import type { DesktopBridge } from './desktop-bridge.js';
import type { SetupStatus } from '../shared/types.js';

// `copilotkit project select` writes the CLI name and deletes the template name.
const INTELLIGENCE_API_KEY_ENV_NAMES = [
  'CPK_INTELLIGENCE_API_KEY',
  'INTELLIGENCE_API_KEY',
] as const;
export const INTELLIGENCE_KEY_MISSING_LABEL = `${INTELLIGENCE_API_KEY_ENV_NAMES[1]} (or ${INTELLIGENCE_API_KEY_ENV_NAMES[0]})`;
export const DEFAULT_AGENT_RUN_TIMEOUT_MS = 90_000;
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

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
export const DEFAULT_OPENROUTER_MODEL = 'anthropic/claude-opus-4';

// ploop talks to OpenRouter by default: OPENROUTER_API_KEY alone is enough.
// OPENAI_API_KEY keeps the template's original OpenAI-compatible setup and
// wins when both are set, so an existing deployment does not switch provider.
export function modelConfigFromEnv(env: Record<string, string | undefined>): {
  apiKey?: string;
  model?: string;
  baseUrl: string;
} {
  const openaiKey = env.OPENAI_API_KEY?.trim();
  const openrouterKey = env.OPENROUTER_API_KEY?.trim();
  if (!openaiKey && openrouterKey)
    return {
      apiKey: openrouterKey,
      model:
        firstNonEmptyEnvValue(env, ['PLOOP_MODEL', 'OPENAI_MODEL']) ??
        DEFAULT_OPENROUTER_MODEL,
      baseUrl: env.OPENROUTER_BASE_URL?.trim() || OPENROUTER_BASE_URL,
    };
  return {
    apiKey: openaiKey || undefined,
    model: env.OPENAI_MODEL?.trim() || undefined,
    baseUrl: env.OPENAI_BASE_URL?.trim() || 'https://api.openai.com/v1',
  };
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
  model?: string;
  apiKey?: string;
  baseUrl: string;
  agentRunTimeoutMs?: number;
  computerSupervisorUrl?: string;
  computerSupervisorToken?: string;
  computerToken?: string;
  computerNamespace?: string;
  sshComputer?: SshTarget;
  desktopBridge?: DesktopBridge;
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
  const missing = [
    !config.intelligenceKey && INTELLIGENCE_KEY_MISSING_LABEL,
    !config.apiKey && 'OPENROUTER_API_KEY (or OPENAI_API_KEY)',
    !config.model && 'OPENAI_MODEL',
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
    model: !!(config.apiKey && config.model),
    browser: !!(config.browserUrl && config.browserSecret),
    voice: !!(config.voiceKey && config.voiceModel && !missing.length),
    composio: !!config.composioApiKey,
    slack,
    missing,
  };
}
