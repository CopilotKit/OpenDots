import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { EncryptedJsonFile, type SecretBox } from './encrypted-file';

// The keys and addresses ploop needs. Stored encrypted next to the vault, and
// handed to ploop's local server as environment variables when it starts.
const settingsSchema = z.object({
  openrouterApiKey: z.string().optional(),
  // ploop keeps its conversations in CopilotKit Intelligence.
  intelligenceApiKey: z.string().optional(),
  // Only for Intelligence running on this Mac (the local evaluation in
  // Docker); hosted Intelligence needs neither.
  intelligenceApiUrl: z.string().optional(),
  intelligenceWsUrl: z.string().optional(),
  // Ties SDK usage to the Intelligence account; the CLI writes it with the key.
  telemetryId: z.string().optional(),
  // Optional OpenRouter model id; the server has a default.
  model: z.string().optional(),
  // A computer ploop can use over SSH. None of this is secret: the key itself
  // stays in a file the user already has, and only its path is kept.
  sshHost: z.string().optional(),
  sshUser: z.string().optional(),
  sshPort: z.string().optional(),
  sshKeyPath: z.string().optional(),
  // The server's OWNER_TOKEN, so other programs on this Mac can't use it.
  ownerToken: z.string().optional(),
});

export type Settings = z.infer<typeof settingsSchema>;

export const settingKeys = [
  'openrouterApiKey',
  'intelligenceApiKey',
  'intelligenceApiUrl',
  'intelligenceWsUrl',
  'telemetryId',
  'model',
  'sshHost',
  'sshUser',
  'sshPort',
  'sshKeyPath',
] as const;

export type SettingKey = (typeof settingKeys)[number];
export type SettingsPatch = Partial<Record<SettingKey, string>>;

// Never includes a secret: just which ones are set.
export type SettingsStatus = {
  openrouterApiKey: boolean;
  intelligenceApiKey: boolean;
  intelligenceApiUrl: string;
  intelligenceWsUrl: string;
  telemetryId: string;
  model: string;
  sshHost: string;
  sshUser: string;
  sshPort: string;
  sshKeyPath: string;
};

export class SettingsStore {
  private readonly file: EncryptedJsonFile<Settings>;

  constructor(options: { file: string; box: SecretBox }) {
    this.file = new EncryptedJsonFile({
      file: options.file,
      box: options.box,
      schema: settingsSchema,
      empty: () => ({}),
    });
  }

  async status(): Promise<SettingsStatus> {
    const settings = await this.file.read();
    return {
      openrouterApiKey: Boolean(settings.openrouterApiKey),
      intelligenceApiKey: Boolean(settings.intelligenceApiKey),
      intelligenceApiUrl: settings.intelligenceApiUrl ?? '',
      intelligenceWsUrl: settings.intelligenceWsUrl ?? '',
      telemetryId: settings.telemetryId ?? '',
      model: settings.model ?? '',
      sshHost: settings.sshHost ?? '',
      sshUser: settings.sshUser ?? '',
      sshPort: settings.sshPort ?? '',
      sshKeyPath: settings.sshKeyPath ?? '',
    };
  }

  // A missing field is left alone; an empty string clears it.
  async save(patch: SettingsPatch): Promise<void> {
    await this.file.update(settings => {
      const next: Settings = { ...settings };
      for (const key of settingKeys) {
        const value = patch[key]?.trim();
        if (value === undefined) continue;
        if (value === '') delete next[key];
        else next[key] = value;
      }
      return { value: next, result: undefined };
    });
  }

  async ownerToken(): Promise<string> {
    return this.file.update(settings => {
      if (settings.ownerToken) {
        return { value: settings, result: settings.ownerToken };
      }
      const ownerToken = randomBytes(32).toString('hex');
      return { value: { ...settings, ownerToken }, result: ownerToken };
    });
  }

  // The environment ploop's server runs with.
  async toEnv(): Promise<Record<string, string>> {
    const settings = await this.file.read();
    const env: Record<string, string> = {};
    if (settings.openrouterApiKey)
      env.OPENROUTER_API_KEY = settings.openrouterApiKey;
    if (settings.intelligenceApiKey)
      env.CPK_INTELLIGENCE_API_KEY = settings.intelligenceApiKey;
    if (settings.intelligenceApiUrl)
      env.INTELLIGENCE_API_URL = settings.intelligenceApiUrl;
    if (settings.intelligenceWsUrl)
      env.INTELLIGENCE_GATEWAY_WS_URL = settings.intelligenceWsUrl;
    if (settings.telemetryId) env.CPK_TELEMETRY_ID = settings.telemetryId;
    if (settings.model) env.PLOOP_MODEL = settings.model;
    if (settings.sshHost) {
      env.PLOOP_SSH_HOST = settings.sshHost;
      if (settings.sshUser) env.PLOOP_SSH_USER = settings.sshUser;
      if (settings.sshPort) env.PLOOP_SSH_PORT = settings.sshPort;
      if (settings.sshKeyPath) env.PLOOP_SSH_KEY_PATH = settings.sshKeyPath;
    }
    return env;
  }
}

// The Intelligence connection the CopilotKit CLI writes to a .env file
// (`copilotkit project select`, or `copilotkit local connect` for Intelligence
// on this Mac). Every other line is ignored. Settings the file leaves out are
// cleared, so switching from local to hosted Intelligence drops the local URLs.
export function intelligenceFromEnvFile(text: string): SettingsPatch {
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    const quoted = value.match(/^(['"])(.*)\1$/);
    if (quoted) value = quoted[2];
    else value = value.replace(/\s+#.*$/, '');
    if (value) values.set(match[1], value);
  }
  const first = (...names: string[]) =>
    names.map(name => values.get(name)).find(Boolean) ?? '';
  const intelligenceApiKey = first(
    'CPK_INTELLIGENCE_API_KEY',
    'INTELLIGENCE_API_KEY',
  );
  if (!intelligenceApiKey) {
    throw new Error(
      'That file has no Intelligence key. Run `npx copilotkit@latest project select` (or `local connect --approve-connection`) in its folder first.',
    );
  }
  return {
    intelligenceApiKey,
    intelligenceApiUrl: first('INTELLIGENCE_API_URL'),
    intelligenceWsUrl: first(
      'INTELLIGENCE_GATEWAY_WS_URL',
      'INTELLIGENCE_WS_URL',
    ),
    telemetryId: first('CPK_TELEMETRY_ID'),
  };
}
