import { describe, expect, it } from 'vitest';
import { resolveLogin } from './resolve';

const logins = [
  {
    label: 'GitHub',
    url: 'https://github.com/login',
    username: 'ephraim',
    agentAccess: true,
  },
  {
    label: 'GitHub (work)',
    url: 'https://github.com/login',
    username: 'ephraim-work',
    agentAccess: true,
  },
  {
    label: 'Bank',
    url: 'https://www.mybank.example/signin',
    username: 'e.lober',
    agentAccess: false,
  },
];

describe('resolveLogin', () => {
  it('finds a login by host, label or full address', () => {
    for (const site of ['github.com', 'GitHub', 'https://github.com/foo']) {
      const result = resolveLogin(logins, site, 'ephraim');
      expect(result.ok && result.login.username).toBe('ephraim');
    }
  });

  it('ignores a leading www and never treats a bare word as a whole domain', () => {
    expect(resolveLogin(logins, 'mybank.example', 'e.lober')).toMatchObject({
      ok: false,
      reason: 'no-agent-access',
    });
    expect(resolveLogin(logins, 'example', 'e.lober').ok).toBe(false);
  });

  it('does not pick an account for the agent', () => {
    expect(resolveLogin(logins, 'github.com', 'someone')).toMatchObject({
      ok: false,
      reason: 'not-found',
    });
  });

  it('reports two logins that match instead of guessing', () => {
    const twins = [logins[0], { ...logins[0], label: 'GitHub again' }];
    expect(resolveLogin(twins, 'github.com', 'ephraim')).toMatchObject({
      ok: false,
      reason: 'ambiguous',
    });
  });

  it('does not match a site that merely ends with the same letters', () => {
    expect(resolveLogin(logins, 'hub.com', 'ephraim').ok).toBe(false);
  });

  it('refuses logins the user kept to themselves', () => {
    const result = resolveLogin(logins, 'mybank.example', 'e.lober');
    expect(result).toMatchObject({ ok: false, reason: 'no-agent-access' });
    expect(!result.ok && result.message).toMatch(/Agent access/);
  });
});
