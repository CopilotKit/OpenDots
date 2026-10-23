import { describe, expect, it } from 'vitest';
import { LoginService, LoginServiceError } from './login-service';
import type { SitePage } from './sign-in';
import type { Login } from './vault';

const login = (overrides: Partial<Login> = {}): Login => ({
  id: 'login_1',
  label: 'GitHub',
  url: 'https://github.com/login',
  username: 'ephraim',
  password: 'hunter2-hunter2',
  notes: 'personal',
  agentAccess: true,
  createdAt: '2026-10-12T00:00:00.000Z',
  updatedAt: '2026-10-12T00:00:00.000Z',
  ...overrides,
});

function summarize({ password: _password, ...rest }: Login) {
  return rest;
}

function setup(logins: Login[], page: Partial<SitePage> = {}) {
  const opened: string[] = [];
  const service = new LoginService({
    vault: {
      list: async () => logins.map(summarize),
      get: async id => logins.find(entry => entry.id === id),
    },
    openPage: entry => {
      opened.push(entry.id);
      return {
        url: () => 'https://github.com/dashboard?token=abc',
        title: () => 'Dashboard',
        load: async () => {},
        run: async (script: string) =>
          script.includes('innerText') ? 'Hello Ephraim' : { password: false },
        wait: async () => {},
        reveal: () => {},
        ...page,
      };
    },
  });
  return { service, opened };
}

describe('LoginService.listForAgent', () => {
  it('shows the agent sites and usernames only, and skips logins kept private', async () => {
    const { service } = setup([
      login(),
      login({
        id: 'login_2',
        label: 'Bank',
        url: 'https://bank.example',
        agentAccess: false,
      }),
    ]);

    const list = await service.listForAgent();
    expect(list).toEqual([
      { label: 'GitHub', site: 'github.com', username: 'ephraim' },
    ]);
    expect(JSON.stringify(list)).not.toMatch(/hunter2|login_1|personal/);
  });
});

describe('LoginService.readPageForAgent', () => {
  it('reads a page on the signed-in site and hides the query string', async () => {
    const { service } = setup([login()]);
    const reading = await service.readPageForAgent(
      'github.com',
      'ephraim',
      'https://github.com/settings',
    );
    expect(reading).toEqual({
      url: 'https://github.com/dashboard',
      title: 'Dashboard',
      text: 'Hello Ephraim',
    });
  });

  it('refuses addresses on other sites, before opening anything', async () => {
    const { service, opened } = setup([login()]);
    for (const url of [
      'https://evil.example/steal',
      'https://github.com.evil.example/',
      'http://github.com/',
      'file:///etc/hosts',
    ]) {
      await expect(
        service.readPageForAgent('github.com', 'ephraim', url),
      ).rejects.toBeInstanceOf(LoginServiceError);
    }
    expect(opened).toEqual([]);
  });

  it('refuses when the site redirects somewhere else', async () => {
    const { service } = setup([login()], {
      url: () => 'https://evil.example/',
    });
    await expect(
      service.readPageForAgent('github.com', 'ephraim', 'https://github.com/x'),
    ).rejects.toThrow(/different address/);
  });

  it('tells the agent to sign in first when the page shows a sign-in form', async () => {
    const { service } = setup([login()], {
      run: async () => ({ password: true }),
    });
    await expect(
      service.readPageForAgent('github.com', 'ephraim', 'https://github.com/x'),
    ).rejects.toThrow(/sign_in_to_site/);
  });

  it('refuses a login the user kept private', async () => {
    const { service } = setup([login({ agentAccess: false })]);
    await expect(
      service.readPageForAgent('github.com', 'ephraim', 'https://github.com/x'),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe('LoginService.signInForAgent', () => {
  it('does not open a window for an unknown or private login', async () => {
    const { service, opened } = setup([login({ agentAccess: false })]);
    await expect(
      service.signInForAgent('github.com', 'ephraim'),
    ).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      service.signInForAgent('gitlab.com', 'ephraim'),
    ).rejects.toMatchObject({
      status: 404,
    });
    expect(opened).toEqual([]);
  });
});
