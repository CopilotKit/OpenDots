// The code ploop runs inside a site's page to look at its sign-in form and fill
// it. It runs in an isolated JavaScript world, so the page's own scripts can't
// replace its helpers, and it never returns the username or password: the
// answer is only which stage of the form it found.

export type ProbeResult = {
  password: boolean;
  username: boolean;
  code: boolean;
};

export type FillResult = {
  stage: 'password-submitted' | 'username-submitted' | 'no-form';
};

type ScriptArgs =
  | { mode: 'probe'; assumeVisible?: boolean }
  | {
      mode: 'fill';
      username: string;
      password: string;
      assumeVisible?: boolean;
    };

const PAGE_SCRIPT = String.raw`async (args) => {
  const assumeVisible = args.assumeVisible === true;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const isVisible = (el) => {
    if (el.disabled || el.type === 'hidden') return false;
    if (assumeVisible) return true;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    const style = getComputedStyle(el);
    return (
      style.visibility !== 'hidden' &&
      style.display !== 'none' &&
      style.opacity !== '0'
    );
  };

  const inputs = () => Array.from(document.querySelectorAll('input')).filter(isVisible);
  const passwordInput = () => inputs().find((el) => el.type === 'password');
  const codeInput = () =>
    inputs().find(
      (el) =>
        el.autocomplete === 'one-time-code' ||
        /otp|totp|2fa|mfa|verification|security.?code/i.test(el.name + ' ' + el.id),
    );
  const textLike = (el) => ['text', 'email', 'tel', ''].includes(el.type);
  const looksLikeSearch = (el) =>
    /search|query/i.test(el.name + ' ' + el.id + ' ' + el.placeholder);

  const usernameInput = (password) => {
    const candidates = inputs().filter(
      (el) => textLike(el) && !looksLikeSearch(el) && el !== codeInput(),
    );
    if (password) {
      const before = candidates.filter(
        (el) => el.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING,
      );
      const sameForm = before.filter((el) => el.form && el.form === password.form);
      const pool = sameForm.length > 0 ? sameForm : before;
      return pool[pool.length - 1];
    }
    // Without a password field to anchor on, only trust a field that says it
    // is for a username. Guessing could type the username into any box on a
    // page that is already signed in.
    return candidates.find((el) =>
      /user|email|login|account|identifier|phone/i.test(
        el.name + ' ' + el.id + ' ' + el.autocomplete + ' ' + el.placeholder,
      ),
    );
  };

  const setValue = (el, value) => {
    el.focus();
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };

  const buttonLabel = (el) =>
    (el.innerText || el.value || el.getAttribute('aria-label') || '').trim();

  const submit = (field, pattern) => {
    const form = field.form;
    const buttons = Array.from(
      (form ?? document).querySelectorAll('button, input[type=submit], input[type=button], [role=button]'),
    ).filter(isVisible);
    const target =
      buttons.find((el) => el.type === 'submit') ??
      buttons.find((el) => pattern.test(buttonLabel(el)));
    if (target) {
      target.click();
    } else if (form && form.requestSubmit) {
      form.requestSubmit();
    } else {
      for (const type of ['keydown', 'keypress', 'keyup']) {
        field.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      }
    }
  };

  const password = passwordInput();

  if (args.mode === 'probe') {
    return {
      password: Boolean(password),
      username: Boolean(usernameInput(password)),
      code: Boolean(codeInput()),
    };
  }

  const userField = usernameInput(password);
  if (password) {
    if (userField) setValue(userField, args.username);
    setValue(password, args.password);
    await sleep(150);
    submit(password, /sign.?in|log.?in|continue|submit/i);
    return { stage: 'password-submitted' };
  }

  if (userField) {
    setValue(userField, args.username);
    await sleep(150);
    submit(userField, /next|continue|sign.?in|log.?in/i);
    return { stage: 'username-submitted' };
  }

  return { stage: 'no-form' };
}`;

export function buildPageScript(args: ScriptArgs) {
  return `(${PAGE_SCRIPT})(${JSON.stringify(args)})`;
}
