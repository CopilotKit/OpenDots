import type { SetupStatus } from '../shared/types.js';
import type { ChatGPTAuth } from './chatgpt-auth.js';
export type ModelProvider = 'openai-compatible' | 'chatgpt-plan';
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
  runtimeUrl: string;
  ownerToken?: string;
  chatgptAuth?: ChatGPTAuth;
  modelProvider?: ModelProvider;
}
export function setupStatus(
  config: PlatformConfig,
  slack = 'not_configured',
  activationFailed = false,
): SetupStatus {
  const modelProvider =
    config.chatgptAuth?.provider() ??
    config.modelProvider ??
    'openai-compatible';
  const missing = [
    !config.intelligenceKey && 'INTELLIGENCE_API_KEY',
    modelProvider === 'chatgpt-plan'
      ? (!config.chatgptAuth?.status().connected ||
          !config.chatgptAuth?.status().model) &&
        'ChatGPT plan connection/model'
      : (!config.apiKey && 'OPENAI_API_KEY') ||
        (!config.model && 'OPENAI_MODEL'),
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
    model:
      modelProvider === 'chatgpt-plan'
        ? !!config.chatgptAuth?.status().connected
        : !!(config.apiKey && config.model),
    modelProvider,
    chatgpt: config.chatgptAuth?.status() ?? { connected: false },
    apiProviderAvailable: !!(config.apiKey && config.model),
    browser: !!(config.browserUrl && config.browserSecret),
    voice: !!(config.voiceKey && config.voiceModel && !missing.length),
    slack,
    missing,
  };
}
