import { parseSiteUrl, publicUrl, sameOrigin, siteHost } from './origin';
import { resolveLogin } from './resolve';
import { signIn, type SignInResult, type SitePage } from './sign-in';
import { buildPageScript } from './fill-script';
import { type Login, type LoginSummary, type Vault } from './vault';

// What the agent is allowed to know about a saved login. No password, no id.
export type AgentLogin = { label: string; site: string; username: string };

export type PageReading = { url: string; title: string; text: string };

const MAX_PAGE_CHARS = 8_000;

export class LoginServiceError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'LoginServiceError';
  }
}

export type LoginServiceOptions = {
  vault: Pick<Vault, 'list' | 'get'>;
  // Opens (or reuses) the browser window that holds this login's session.
  openPage: (login: Login) => SitePage;
};

// The only things that can reach a saved password: the person using the app
// (through the window) and these methods, which fill it into the right site
// and report back without ever returning it.
export class LoginService {
  constructor(private readonly options: LoginServiceOptions) {}

  async listForAgent(): Promise<AgentLogin[]> {
    const logins = await this.options.vault.list();
    return logins
      .filter(login => login.agentAccess)
      .map(login => ({
        label: login.label,
        site: siteHost(login.url),
        username: login.username,
      }));
  }

  async signInForAgent(site: string, username: string): Promise<SignInResult> {
    const login = await this.resolveForAgent(site, username);
    return this.signInWith(login);
  }

  // Sign in from the window, for the person who owns the vault.
  async signInById(id: string): Promise<SignInResult> {
    const login = await this.options.vault.get(id);
    if (login == null) {
      throw new LoginServiceError('That login no longer exists.', 404);
    }
    return this.signInWith(login);
  }

  async readPageForAgent(
    site: string,
    username: string,
    url: string,
  ): Promise<PageReading> {
    const login = await this.resolveForAgent(site, username);

    const target = parseSiteUrl(url);
    if (target == null || !sameOrigin(target.toString(), login.url)) {
      throw new LoginServiceError(
        `That address is not on ${siteHost(login.url)}. ploop can only read pages on the site it signed in to.`,
        400,
      );
    }

    const page = this.options.openPage(login);
    await page.load(target.toString());
    if (!sameOrigin(page.url(), login.url)) {
      throw new LoginServiceError(
        'The site sent the browser to a different address, so ploop did not read it.',
        502,
      );
    }

    const state = await page.run(buildPageScript({ mode: 'probe' }));
    if (isShowingSignIn(state)) {
      throw new LoginServiceError(
        `Not signed in to ${siteHost(login.url)} yet. Call sign_in_to_site first.`,
        409,
      );
    }

    const text = await page.run('document.body ? document.body.innerText : ""');
    const body = typeof text === 'string' ? text : '';
    return {
      url: publicUrl(page.url()),
      title: page.title(),
      text:
        body.length > MAX_PAGE_CHARS
          ? `${body.slice(0, MAX_PAGE_CHARS)}\n[truncated ${body.length - MAX_PAGE_CHARS} characters]`
          : body,
    };
  }

  private async resolveForAgent(
    site: string,
    username: string,
  ): Promise<Login> {
    const summaries: LoginSummary[] = await this.options.vault.list();
    const resolution = resolveLogin(summaries, site, username);
    if (!resolution.ok) {
      throw new LoginServiceError(
        resolution.message,
        resolution.reason === 'no-agent-access' ? 403 : 404,
      );
    }

    const login = await this.options.vault.get(resolution.login.id);
    if (login == null) {
      throw new LoginServiceError('That login no longer exists.', 404);
    }
    return login;
  }

  private signInWith(login: Login): Promise<SignInResult> {
    return signIn(this.options.openPage(login), {
      url: login.url,
      username: login.username,
      password: login.password,
    });
  }
}

function isShowingSignIn(state: unknown) {
  return (
    typeof state === 'object' &&
    state != null &&
    'password' in state &&
    state.password === true
  );
}
