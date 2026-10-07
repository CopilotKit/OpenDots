import type { ServerEnv } from '../config/env.js';
import {
  intelligenceApiKeyFromEnv,
  intelligenceWsUrlFromEnv,
} from '../config/env.js';
import type { WebConfig } from './parallel.js';
import type { SetupStatus } from '../shared/types.js';

const INTELLIGENCE_API_KEY_ENV_NAMES = [
  'CPK_INTELLIGENCE_API_KEY',
  'INTELLIGENCE_API_KEY',
] as const;
export const INTELLIGENCE_KEY_MISSING_LABEL = `${INTELLIGENCE_API_KEY_ENV_NAMES[1]} (or ${INTELLIGENCE_API_KEY_ENV_NAMES[0]})`;

// Re-export the alias-aware helpers so existing callers continue to work.
export { intelligenceApiKeyFromEnv, intelligenceWsUrlFromEnv };

export interface PlatformConfig extends WebConfig {
  intelligenceKey?: string;
  intelligenceApiUrl?: string;
  intelligenceWsUrl?: string;
  model?: string;
  apiKey?: string;
  baseUrl: string;
  computerSupervisorUrl?: string;
  computerSupervisorToken?: string;
  computerToken?: string;
  computerNamespace?: string;
  browserUrl?: string;
  browserSecret?: string;
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

export function platformConfigFromEnv(
  env: ServerEnv,
  source: NodeJS.ProcessEnv,
  overrides: { runtimeUrl: string; ownerToken?: string },
): PlatformConfig {
  return {
    webSearchProvider: env.WEB_SEARCH_PROVIDER,
    parallelApiKey: env.PARALLEL_API_KEY,
    intelligenceKey: intelligenceApiKeyFromEnv(source),
    intelligenceApiUrl: env.INTELLIGENCE_API_URL,
    intelligenceWsUrl: intelligenceWsUrlFromEnv(source),
    apiKey: env.OPENAI_API_KEY,
    model: env.OPENAI_MODEL,
    baseUrl: env.OPENAI_BASE_URL,
    computerSupervisorUrl: env.COMPUTER_SUPERVISOR_URL,
    computerSupervisorToken: env.COMPUTER_SUPERVISOR_TOKEN,
    computerToken: env.COMPUTER_TOKEN,
    computerNamespace: env.COMPUTER_NAMESPACE,
    browserUrl: env.BROWSER_URL,
    browserSecret: env.BROWSER_SECRET,
    voiceKey: env.VOICE_API_KEY,
    voiceModel: env.VOICE_MODEL,
    voiceName: env.VOICE_NAME,
    slackChannel: env.SLACK_CHANNEL_NAME,
    slackTeam: env.SLACK_TEAM_ID,
    slackUsers: env.SLACK_USER_IDS,
    slackDotId: env.SLACK_DOT_ID,
    runtimeUrl: overrides.runtimeUrl,
    ownerToken: overrides.ownerToken,
  };
}

export function setupStatus(
  config: PlatformConfig,
  slack = 'not_configured',
  activationFailed = false,
): SetupStatus {
  const missing = [
    !config.intelligenceKey && INTELLIGENCE_KEY_MISSING_LABEL,
    !config.apiKey && 'OPENAI_API_KEY',
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
    slack,
    missing,
  };
}
