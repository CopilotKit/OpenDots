import { z } from 'zod';
import { EncryptedJsonFile, type SecretBox } from './encrypted-file';
import { parseSiteUrl, siteHost } from './origin';

export const loginSchema = z.object({
  id: z.string(),
  label: z.string(),
  url: z.string(),
  username: z.string(),
  password: z.string(),
  notes: z.string(),
  // Whether ploop (the agent) may sign in with this login. Off keeps the
  // login in the vault for you only.
  agentAccess: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type Login = z.infer<typeof loginSchema>;

// Everything except the password. This is all the window and the agent ever
// see until you ask to reveal or copy a password.
export type LoginSummary = Omit<Login, 'password'>;

export type LoginInput = {
  label?: string;
  url: string;
  username: string;
  password: string;
  notes?: string;
  agentAccess?: boolean;
};

export type LoginPatch = Partial<LoginInput>;

export class InvalidLoginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidLoginError';
  }
}

export function summarize(login: Login): LoginSummary {
  return {
    id: login.id,
    label: login.label,
    url: login.url,
    username: login.username,
    notes: login.notes,
    agentAccess: login.agentAccess,
    createdAt: login.createdAt,
    updatedAt: login.updatedAt,
  };
}

export class Vault {
  private readonly file: EncryptedJsonFile<Login[]>;
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(options: {
    file: string;
    box: SecretBox;
    now?: () => Date;
    newId?: () => string;
  }) {
    this.file = new EncryptedJsonFile({
      file: options.file,
      box: options.box,
      schema: z.array(loginSchema),
      empty: () => [],
    });
    this.now = options.now ?? (() => new Date());
    this.newId =
      options.newId ?? (() => `login_${crypto.randomUUID().slice(0, 8)}`);
  }

  async list(): Promise<LoginSummary[]> {
    const logins = await this.file.read();
    return logins
      .map(summarize)
      .sort((a, b) =>
        a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }),
      );
  }

  async get(id: string): Promise<Login | undefined> {
    return (await this.file.read()).find(login => login.id === id);
  }

  async add(input: LoginInput): Promise<LoginSummary> {
    const checked = validate(input);
    const timestamp = this.now().toISOString();

    return this.file.update(logins => {
      assertNotDuplicate(logins, checked.url, checked.username);
      const login: Login = {
        id: this.newId(),
        label: checked.label,
        url: checked.url,
        username: checked.username,
        password: checked.password,
        notes: checked.notes,
        agentAccess: checked.agentAccess,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      return { value: [...logins, login], result: summarize(login) };
    });
  }

  update(id: string, patch: LoginPatch): Promise<LoginSummary> {
    return this.file.update(logins => {
      const current = logins.find(login => login.id === id);
      if (current == null) {
        throw new InvalidLoginError('That login no longer exists.');
      }

      // An empty password in the patch means "keep the saved one", so the
      // edit form can leave the field blank.
      const checked = validate({
        label: patch.label ?? current.label,
        url: patch.url ?? current.url,
        username: patch.username ?? current.username,
        password:
          patch.password === undefined || patch.password === ''
            ? current.password
            : patch.password,
        notes: patch.notes ?? current.notes,
        agentAccess: patch.agentAccess ?? current.agentAccess,
      });
      assertNotDuplicate(
        logins.filter(login => login.id !== id),
        checked.url,
        checked.username,
      );

      const updated: Login = {
        ...current,
        ...checked,
        updatedAt: this.now().toISOString(),
      };
      return {
        value: logins.map(login => (login.id === id ? updated : login)),
        result: summarize(updated),
      };
    });
  }

  remove(id: string): Promise<boolean> {
    return this.file.update(logins => {
      const next = logins.filter(login => login.id !== id);
      return { value: next, result: next.length !== logins.length };
    });
  }
}

function validate(input: LoginInput) {
  const url = parseSiteUrl(input.url);
  if (url == null) {
    throw new InvalidLoginError(
      'Enter the sign-in page address starting with https:// (http:// only works for localhost).',
    );
  }

  const username = input.username.trim();
  if (username === '') {
    throw new InvalidLoginError('Enter the username or email for this login.');
  }
  if (input.password === '') {
    throw new InvalidLoginError('Enter the password for this login.');
  }

  const label = (input.label ?? '').trim();
  return {
    label: label === '' ? siteHost(url.toString()) : label,
    url: url.toString(),
    username,
    password: input.password,
    notes: (input.notes ?? '').trim(),
    agentAccess: input.agentAccess ?? true,
  };
}

function assertNotDuplicate(logins: Login[], url: string, username: string) {
  const origin = new URL(url).origin;
  const clash = logins.find(
    login =>
      new URL(login.url).origin === origin &&
      login.username.toLowerCase() === username.toLowerCase(),
  );
  if (clash != null) {
    throw new InvalidLoginError(
      `You already saved ${username} for ${siteHost(url)}. Edit that login instead.`,
    );
  }
}
