import { safeValidateTypes } from './json';
import { z } from 'zod';
import {
  buildPageScript,
  type FillResult,
  type ProbeResult,
} from './fill-script';
import { parseSiteUrl, publicUrl, sameOrigin, siteHost } from './origin';

// A browser page ploop can drive. In the app this wraps an Electron window with
// its own cookie jar per login; tests pass a fake.
export type SitePage = {
  url(): string;
  title(): string;
  load(url: string): Promise<void>;
  run(script: string): Promise<unknown>;
  wait(ms: number): Promise<void>;
  // Bring the window to the front when a person needs to finish something.
  reveal(): void;
};

export type SignInStatus =
  | 'signed-in'
  | 'already-signed-in'
  | 'needs-attention'
  | 'failed';

export type SignInResult = {
  status: SignInStatus;
  url: string;
  title: string;
  note: string;
};

type Credentials = { url: string; username: string; password: string };

type Timing = { tries: number; intervalMs: number };
const DEFAULT_TIMING: Timing = { tries: 20, intervalMs: 500 };

const probeSchema = z.object({
  password: z.boolean(),
  username: z.boolean(),
  code: z.boolean(),
});
const fillSchema = z.object({
  stage: z.enum(['password-submitted', 'username-submitted', 'no-form']),
});

async function runChecked<T>(
  page: SitePage,
  script: string,
  schema: z.ZodType<T>,
): Promise<T | null> {
  try {
    const result = await safeValidateTypes({
      value: await page.run(script),
      schema,
    });
    return result.success ? result.value : null;
  } catch {
    // The page navigated while the script ran. The caller retries.
    return null;
  }
}

// Signs in the way a person would: opens the saved sign-in page, fills the
// form, submits, and reports what the page did. It only fills a form while
// the page is still on the saved site's origin, so a redirect to somewhere
// else never receives the password.
export async function signIn(
  page: SitePage,
  credentials: Credentials,
  timing: Timing = DEFAULT_TIMING,
): Promise<SignInResult> {
  const finish = (status: SignInStatus, note: string): SignInResult => {
    if (status === 'needs-attention') page.reveal();
    return { status, url: publicUrl(page.url()), title: page.title(), note };
  };
  const onSite = () => sameOrigin(page.url(), credentials.url);

  if (parseSiteUrl(credentials.url) == null) {
    return finish('failed', 'The saved address is not a valid sign-in page.');
  }

  try {
    await page.load(credentials.url);
  } catch (error) {
    return finish(
      'failed',
      `The page did not load: ${error instanceof Error ? error.message : 'unknown error'}.`,
    );
  }
  if (!onSite()) {
    return finish(
      'failed',
      'The site sent the browser somewhere else, so ploop did not fill anything.',
    );
  }

  const probe = () =>
    runChecked<ProbeResult>(
      page,
      buildPageScript({ mode: 'probe' }),
      probeSchema,
    );

  // Waits for a condition to hold, probing every interval. A probe that fails
  // because the page is mid-navigation counts as "not yet".
  const waitFor = async (condition: (state: ProbeResult) => boolean) => {
    for (let attempt = 0; attempt < timing.tries; attempt++) {
      const state = await probe();
      if (state != null && condition(state)) return state;
      await page.wait(timing.intervalMs);
    }
    return probe();
  };

  const first = await waitFor(
    state => state.password || state.username || state.code,
  );
  if (first == null || (!first.password && !first.username && !first.code)) {
    return finish(
      'already-signed-in',
      'No sign-in form was shown, so this session is already signed in.',
    );
  }

  // A form can take up to three rounds: username, then password, then done.
  for (let round = 0; round < 3; round++) {
    if (!onSite()) {
      return finish(
        'failed',
        'The site sent the browser somewhere else, so ploop stopped before filling anything more.',
      );
    }

    const state = await probe();
    if (state?.code) {
      return finish(
        'needs-attention',
        'The site is asking for a verification code. A person needs to finish signing in in the ploop window.',
      );
    }

    const filled = await runChecked<FillResult>(
      page,
      buildPageScript({
        mode: 'fill',
        username: credentials.username,
        password: credentials.password,
      }),
      fillSchema,
    );
    if (filled == null || filled.stage === 'no-form') break;
    if (filled.stage === 'password-submitted') break;

    // Username submitted: wait for the password step to appear.
    await waitFor(next => next.password || next.code);
  }

  // A signed-in page can still have text boxes, so a leftover username field
  // only counts as "still signing in" while the page is still the sign-in page.
  const stillSigningIn = (state: ProbeResult) =>
    state.password ||
    (state.username && publicUrl(page.url()) === publicUrl(credentials.url));

  const result = await waitFor(state => !stillSigningIn(state) && !state.code);
  // Signing in often hands you to another address of the same service, so
  // that alone is fine, but it is worth saying where the page ended up.
  const elsewhere = onSite()
    ? ''
    : ` The page is now on ${siteHost(page.url()) || 'another site'}, not the saved address.`;

  if (result?.code) {
    return finish(
      'needs-attention',
      `The site is asking for a verification code. A person needs to finish signing in in the ploop window.${elsewhere}`,
    );
  }
  if (result != null && stillSigningIn(result)) {
    return finish(
      'needs-attention',
      `The sign-in form is still showing. The password may be wrong, or the site wants a captcha or another check. A person needs to look at the ploop window.${elsewhere}`,
    );
  }
  return finish('signed-in', `Signed in.${elsewhere}`);
}
