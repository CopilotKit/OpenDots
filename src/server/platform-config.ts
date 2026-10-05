import type { WebConfig } from './parallel.js';
import type { SetupStatus } from '../shared/types.js';
import { resolveModel, type ModelProvider } from './models.js';

export interface PlatformConfig extends WebConfig {
  intelligenceKey?: string;
  intelligenceApiUrl?: string;
  intelligenceWsUrl?: string;
  // Legacy single-slot (kept for back-compat). New code should prefer
  // modelProvider + model below, resolved via src/server/models.ts.
  model?: string;
  apiKey?: string;
  baseUrl: string;
  // Multi-provider routing. All optional so existing
  // OPENAI_*-only deployments keep working.
  modelProvider?: ModelProvider;
  anthropicKey?: string;
  anthropicModel?: string;
  anthropicBaseUrl?: string;
  clineKey?: string;
  clineModel?: string;
  clineBaseUrl?: string;
  // Claude Code harness (subscription via `claude auth login`, T3-style).
  // Raw values are validated by the resolver. Subscription routes require host login.
  claudeAuthMode?: string;
  claudeModel?: string;
  claudeCwd?: string;
  claudePermissionMode?: string;
  // Codex harness (ChatGPT subscription via `codex login`, T3-style).
  codexAuthMode?: string;
  codexModel?: string;
  codexCwd?: string;
  modelFallbacks?: string[];
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
export function setupStatus(
  config: PlatformConfig,
  slack = 'not_configured',
  activationFailed = false,
): SetupStatus {
  let hasModel = false;
  let modelError: string | undefined;
  try {
    resolveModel({ ...config, provider: config.modelProvider });
    hasModel = true;
  } catch (error) {
    modelError =
      error instanceof Error
        ? error.message
        : 'Model configuration is invalid.';
  }
  const missing = [
    !config.intelligenceKey?.trim() && 'INTELLIGENCE_API_KEY',
    modelError,
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
    intelligence: !!config.intelligenceKey?.trim(),
    model: hasModel,
    browser: !!(config.browserUrl && config.browserSecret),
    voice: !!(config.voiceKey && config.voiceModel && !missing.length),
    slack,
    missing,
  };
}
