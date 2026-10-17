import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { signIn, type SitePage } from './sign-in';

type Site = {
  // The page shown at each address, as HTML.
  pages: Record<string, string>;
  // Called when a form is submitted; returns the address to move to.
  onSubmit(values: Record<string, string>, current: string): string;
};

// A browser page backed by jsdom, so the real fill script runs against real
// forms. It records every value typed so tests can check where it went.
class FakePage implements SitePage {
  typed: Array<{ field: string; value: string }> = [];
  revealed = false;
  private current = 'about:blank';
  private dom = new JSDOM('');

  constructor(private readonly site: Site) {}

  url() {
    return this.current;
  }

  title() {
    return 'Fake site';
  }

  async load(url: string) {
    this.show(url);
  }

  async run(script: string) {
    return this.dom.window.eval(script);
  }

  async wait() {}

  reveal() {
    this.revealed = true;
  }

  private show(url: string) {
    const html = this.site.pages[url];
    if (html == null) throw new Error(`no page at ${url}`);
    this.current = url;
    this.dom = new JSDOM(html, { url, runScripts: 'outside-only' });
    const { window } = this.dom;

    // jsdom does no layout, so say every element has a size.
    window.HTMLElement.prototype.getBoundingClientRect = () =>
      ({
        width: 120,
        height: 30,
        top: 0,
        left: 0,
        right: 120,
        bottom: 30,
      }) as DOMRect;

    for (const input of window.document.querySelectorAll('input')) {
      input.addEventListener('input', () =>
        this.typed.push({ field: input.name, value: input.value }),
      );
    }
    for (const form of window.document.querySelectorAll('form')) {
      form.addEventListener('submit', event => {
        event.preventDefault();
        const values: Record<string, string> = {};
        for (const input of form.querySelectorAll('input')) {
          values[input.name] = input.value;
        }
        this.show(this.site.onSubmit(values, this.current));
      });
    }
  }
}

const FAST = { tries: 3, intervalMs: 0 };
const credentials = {
  url: 'https://example.com/login',
  username: 'ephraim@example.com',
  password: 's3cret-pass',
};

const loginForm = `
  <form>
    <input name="search" type="search" placeholder="Search">
    <input name="email" type="email" autocomplete="username">
    <input name="password" type="password">
    <button type="submit">Sign in</button>
  </form>`;

const home =
  '<h1>Welcome back</h1><input name="note" type="text" placeholder="Write a note">';

describe('signIn', () => {
  it('fills a one-page form and reports success without echoing the password', async () => {
    const page = new FakePage({
      pages: {
        'https://example.com/login': loginForm,
        'https://example.com/home': home,
      },
      onSubmit: values =>
        values.email === credentials.username &&
        values.password === credentials.password
          ? 'https://example.com/home'
          : 'https://example.com/login',
    });

    const result = await signIn(page, credentials, FAST);

    expect(result.status).toBe('signed-in');
    expect(result.url).toBe('https://example.com/home');
    expect(JSON.stringify(result)).not.toContain(credentials.password);
    expect(page.typed).toEqual([
      { field: 'email', value: credentials.username },
      { field: 'password', value: credentials.password },
    ]);
  });

  it('handles a form that asks for the username first, then the password', async () => {
    const page = new FakePage({
      pages: {
        'https://example.com/login': `
          <form><input name="identifier" type="text" autocomplete="username">
          <button type="submit">Next</button></form>`,
        'https://example.com/password': `
          <form><input name="password" type="password">
          <button type="submit">Sign in</button></form>`,
        'https://example.com/home': home,
      },
      onSubmit: (values, current) =>
        current.endsWith('/login')
          ? 'https://example.com/password'
          : 'https://example.com/home',
    });

    const result = await signIn(page, credentials, FAST);
    expect(result.status).toBe('signed-in');
    expect(page.typed.map(entry => entry.field)).toEqual([
      'identifier',
      'password',
    ]);
  });

  it('says so when the session is already signed in, and types nothing', async () => {
    const page = new FakePage({
      pages: { 'https://example.com/login': home },
      onSubmit: () => 'https://example.com/login',
    });

    const result = await signIn(page, credentials, FAST);
    expect(result.status).toBe('already-signed-in');
    expect(page.typed).toEqual([]);
  });

  it('asks a person to step in when the password is rejected', async () => {
    const page = new FakePage({
      pages: { 'https://example.com/login': loginForm },
      onSubmit: () => 'https://example.com/login',
    });

    const result = await signIn(page, credentials, FAST);
    expect(result.status).toBe('needs-attention');
    expect(page.revealed).toBe(true);
  });

  it('asks a person to step in for a verification code', async () => {
    const page = new FakePage({
      pages: {
        'https://example.com/login': loginForm,
        'https://example.com/verify': `
          <form><input name="otp" type="text" autocomplete="one-time-code">
          <button type="submit">Verify</button></form>`,
      },
      onSubmit: (values, current) =>
        current.endsWith('/login') ? 'https://example.com/verify' : current,
    });

    const result = await signIn(page, credentials, FAST);
    expect(result.status).toBe('needs-attention');
    expect(result.note).toMatch(/verification code/);
    expect(page.revealed).toBe(true);
    expect(page.typed.map(entry => entry.value)).not.toContain('');
  });

  it('never types into a page on a different site', async () => {
    const page = new FakePage({
      pages: {
        'https://example.com/login': loginForm,
        'https://evil.example/login': loginForm,
      },
      onSubmit: () => 'https://evil.example/login',
    });

    const result = await signIn(page, credentials, FAST);
    expect(result.status).toBe('needs-attention');
    expect(result.note).toMatch(/evil\.example/);
    // Only the first, genuine form was filled; the lookalike got nothing.
    expect(page.typed).toEqual([
      { field: 'email', value: credentials.username },
      { field: 'password', value: credentials.password },
    ]);
  });

  it('does not sign in when the saved address redirects off-site', async () => {
    class Redirecting extends FakePage {
      override async load() {
        await super.load('https://evil.example/login');
      }
    }
    const page = new Redirecting({
      pages: { 'https://evil.example/login': loginForm },
      onSubmit: () => 'https://evil.example/login',
    });

    const result = await signIn(page, credentials, FAST);
    expect(result.status).toBe('failed');
    expect(page.typed).toEqual([]);
  });

  it('reports a page that fails to load', async () => {
    const page = new FakePage({ pages: {}, onSubmit: () => '' });
    const result = await signIn(page, credentials, FAST);
    expect(result.status).toBe('failed');
  });

  it('refuses a saved address that is not https', async () => {
    const page = new FakePage({ pages: {}, onSubmit: () => '' });
    const result = await signIn(
      page,
      { ...credentials, url: 'http://example.com/login' },
      FAST,
    );
    expect(result.status).toBe('failed');
  });
});
