import { expect, it } from 'vitest';
import {
  INTELLIGENCE_KEY_MISSING_LABEL,
  setupStatus,
  type PlatformConfig,
} from '../src/server/platform-config.js';
const config: PlatformConfig = {
  intelligenceKey: 'fixture',
  apiKey: 'fixture',
  model: 'fixture',
  baseUrl: 'https://example.com',
  runtimeUrl: '',
  voiceName: 'marin',
  slackUsers: [],
};
it('never claims Slack online without a complete managed channel declaration', () => {
  expect(setupStatus(config, 'online').slack).toBe('not_configured');
  expect(
    setupStatus({ ...config, slackChannel: 'support' }, 'online').slack,
  ).toBe('setup_required');
  expect(
    setupStatus(
      {
        ...config,
        slackChannel: 'support',
        slackTeam: 'team',
        slackUsers: ['owner'],
      },
      'online',
    ).slack,
  ).toBe('online');
});
it('requires Intelligence and model setup and disables voice when either is absent', () => {
  expect(
    setupStatus({
      ...config,
      intelligenceKey: '',
      voiceKey: 'fixture',
      voiceModel: 'fixture',
    }),
  ).toMatchObject({
    missing: [INTELLIGENCE_KEY_MISSING_LABEL],
    voice: false,
  });
});
it('reports activation failure until the SDK recovers online', () => {
  const declared = {
    ...config,
    slackChannel: 'support',
    slackTeam: 'team',
    slackUsers: ['owner'],
  };
  expect(setupStatus(declared, 'offline', true).slack).toBe(
    'activation_failed',
  );
  expect(setupStatus(declared, 'online', true).slack).toBe('online');
});
