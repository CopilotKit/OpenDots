import type { WebConfig } from './parallel.js';
import type { SetupStatus } from '../shared/types.js';
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
  imessageHandles?: string[];
  imessageDotId?: string;
  imessageDbPath?: string;
  runtimeUrl: string;
  ownerToken?: string;
}
export function setupStatus(
  config: PlatformConfig,
  slack = 'not_configured',
  activationFailed = false,
): SetupStatus {
  const missing = [
    !config.intelligenceKey && 'INTELLIGENCE_API_KEY',
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
