import { expect, it } from 'vitest';
import {
  setupStatus,
  type PlatformConfig,
} from '../src/server/platform-config.js';
const config: PlatformConfig = {
  model: 'fixture',
  baseUrl: 'http://127.0.0.1:11434/v1',
  runtimeUrl: '',
  voiceName: 'marin',
  slackUsers: [],
};
it('needs only a model for local conversations; no API key or cloud service', () => {
  expect(setupStatus(config)).toMatchObject({
    missing: [],
    model: true,
    intelligence: false,
  });
  expect(setupStatus({ ...config, model: '' }).missing).toEqual([
    'OPENAI_MODEL',
  ]);
});
it('keeps Slack disabled in local-only mode', () => {
  expect(
    setupStatus({
      ...config,
      slackChannel: 'support',
      slackTeam: 'team',
      slackUsers: ['owner'],
    }).slack,
  ).toBe('not_configured');
});
it('disables voice when the model is absent', () => {
  expect(
    setupStatus({
      ...config,
      model: '',
      voiceKey: 'fixture',
      voiceModel: 'fixture',
    }).voice,
  ).toBe(false);
});
