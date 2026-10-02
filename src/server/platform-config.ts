import type { SetupStatus } from '../shared/types.js';
export interface PlatformConfig {
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
  telegramBotToken?: string;
  telegramChannel?: string;
  telegramUsers: string[];
  telegramDotId?: string;
  telegramMode?: 'polling' | 'webhook' | 'auto';
  telegramWebhookDomain?: string;
  telegramWebhookPath?: string;
  telegramWebhookPort?: number;
  telegramWebhookSecret?: string;
  runtimeUrl: string;
  ownerToken?: string;
}
export function setupStatus(
  config: PlatformConfig,
  slack = 'not_configured',
  activationFailed = false,
  telegram = 'not_configured',
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
  const declaredTelegram = !!(
    config.telegramBotToken &&
    config.telegramChannel &&
    config.telegramUsers.length
  );
  slack = declaredSlack
    ? activationFailed && slack !== 'online'
      ? 'activation_failed'
      : slack
    : config.slackChannel || config.slackTeam || config.slackUsers.length
      ? 'setup_required'
      : 'not_configured';
  telegram = declaredTelegram
    ? activationFailed && telegram !== 'online'
      ? 'activation_failed'
      : telegram
    : config.telegramBotToken ||
        config.telegramChannel ||
        config.telegramUsers.length
      ? 'setup_required'
      : 'not_configured';
  return {
    intelligence: !!config.intelligenceKey,
    model: !!(config.apiKey && config.model),
    browser: !!(config.browserUrl && config.browserSecret),
    voice: !!(config.voiceKey && config.voiceModel && !missing.length),
    slack,
    telegram,
    missing,
  };
}
