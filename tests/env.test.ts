import { describe, expect, it } from 'vitest';
import { browserEnvSchema } from '../src/config/env/browser.js';
import { computerEnvSchema } from '../src/config/env/computer.js';
import { coreEnvSchema, isLocalHost } from '../src/config/env/core.js';
import { parseServerEnv } from '../src/config/env.js';
import { parallelEnvSchema } from '../src/config/env/parallel.js';
import { slackEnvSchema } from '../src/config/env/slack.js';
import { voiceEnvSchema } from '../src/config/env/voice.js';

describe('core env schema', () => {
  it('applies the documented defaults', () => {
    const parsed = coreEnvSchema.parse({});
    expect(parsed.HOST).toBe('127.0.0.1');
    expect(parsed.PORT).toBe(4310);
    expect(parsed.DATABASE_PATH).toBe('data/opendots.sqlite');
    expect(parsed.OWNER_ID).toBe('opendots-owner');
    expect(parsed.OPENAI_BASE_URL).toBe('https://api.openai.com/v1');
    expect(parsed.NODE_ENV).toBe('production');
  });

  it('accepts any non-empty host (token is gated after parse)', () => {
    expect(coreEnvSchema.parse({ HOST: '0.0.0.0' }).HOST).toBe('0.0.0.0');
  });

  it('coerces PORT from string', () => {
    expect(coreEnvSchema.parse({ PORT: '5500' }).PORT).toBe(5500);
  });

  it('classifies the local-host set', () => {
    expect(isLocalHost('127.0.0.1')).toBe(true);
    expect(isLocalHost('::1')).toBe(true);
    expect(isLocalHost('localhost')).toBe(true);
    expect(isLocalHost('0.0.0.0')).toBe(false);
  });

  it('requires an OWNER_TOKEN when HOST is external', () => {
    expect(() => parseServerEnv({ HOST: '0.0.0.0' })).toThrow(
      /OWNER_TOKEN/,
    );
    const valid = parseServerEnv({
      HOST: '0.0.0.0',
      OWNER_TOKEN: 'x'.repeat(24),
    });
    expect(valid.OWNER_TOKEN).toHaveLength(24);
  });
});

describe('parallel env schema', () => {
  it('defaults to the Parallel provider', () => {
    expect(parallelEnvSchema.parse({}).WEB_SEARCH_PROVIDER).toBe('parallel');
  });

  it('rejects an unknown provider', () => {
    expect(() =>
      parallelEnvSchema.parse({ WEB_SEARCH_PROVIDER: 'other' }),
    ).toThrow();
  });
});

describe('browser env schema', () => {
  it('requires BROWSER_SECRET to be at least 24 characters', () => {
    expect(() => browserEnvSchema.parse({ BROWSER_SECRET: 'short' })).toThrow(
      /24 characters/,
    );
    expect(() => browserEnvSchema.parse({})).toThrow(/BROWSER_SECRET/);
  });

  it('accepts a valid secret and applies defaults', () => {
    const parsed = browserEnvSchema.parse({
      BROWSER_SECRET: 'x'.repeat(24),
    });
    expect(parsed.BROWSER_HOST).toBe('127.0.0.1');
    expect(parsed.BROWSER_PORT).toBe(4311);
  });
});

describe('voice env schema', () => {
  it('defaults VOICE_NAME to marin', () => {
    expect(voiceEnvSchema.parse({}).VOICE_NAME).toBe('marin');
  });
});

describe('slack env schema', () => {
  it('parses SLACK_USER_IDS into a trimmed list', () => {
    expect(
      slackEnvSchema.parse({ SLACK_USER_IDS: 'a, b ,,c' }).SLACK_USER_IDS,
    ).toEqual(['a', 'b', 'c']);
  });

  it('returns an empty list when unset', () => {
    expect(slackEnvSchema.parse({}).SLACK_USER_IDS).toEqual([]);
  });
});

describe('computer env schema', () => {
  it('defaults the namespace and keeps optional URLs out', () => {
    const parsed = computerEnvSchema.parse({});
    expect(parsed.COMPUTER_NAMESPACE).toBe('opendots');
    expect(parsed.COMPUTER_SUPERVISOR_URL).toBeUndefined();
  });

  it('rejects a non-URL supervisor', () => {
    expect(() =>
      computerEnvSchema.parse({ COMPUTER_SUPERVISOR_URL: 'not-a-url' }),
    ).toThrow();
  });
});