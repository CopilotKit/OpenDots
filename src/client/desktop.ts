// What the ploop Mac app adds to the page as `window.ploop`. The source of
// truth is desktop/src/api.ts; keep the two in step. In an ordinary browser
// there is no `window.ploop`, and the Vault is not shown.
export interface PloopLogin {
  id: string;
  label: string;
  url: string;
  username: string;
  notes: string;
  agentAccess: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface PloopLoginInput {
  label?: string;
  url: string;
  username: string;
  password: string;
  notes?: string;
  agentAccess?: boolean;
}
export interface PloopSignInResult {
  status: 'signed-in' | 'already-signed-in' | 'needs-attention' | 'failed';
  url: string;
  title: string;
  note: string;
}
export interface PloopSettingsStatus {
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
}
export type PloopSettingsPatch = Partial<
  Record<
    | 'openrouterApiKey'
    | 'intelligenceApiKey'
    | 'intelligenceApiUrl'
    | 'intelligenceWsUrl'
    | 'telemetryId'
    | 'model'
    | 'sshHost'
    | 'sshUser'
    | 'sshPort'
    | 'sshKeyPath',
    string
  >
>;
export interface PloopDesktopApi {
  vault: {
    list(): Promise<PloopLogin[]>;
    add(input: PloopLoginInput): Promise<PloopLogin>;
    update(id: string, patch: Partial<PloopLoginInput>): Promise<PloopLogin>;
    remove(id: string): Promise<boolean>;
    // Each of these asks for Touch ID (or a confirmation) first.
    reveal(id: string): Promise<string>;
    copyPassword(id: string): Promise<void>;
    signIn(id: string): Promise<PloopSignInResult>;
  };
  settings: {
    status(): Promise<PloopSettingsStatus>;
    save(patch: PloopSettingsPatch): Promise<void>;
    // Reads the Intelligence connection from the .env file the CopilotKit CLI
    // wrote, then restarts the server.
    importIntelligence(): Promise<{ imported: boolean; local?: boolean }>;
  };
  app: {
    info(): Promise<{ version: string; signed: boolean }>;
    checkForUpdates(): Promise<void>;
  };
}
declare global {
  interface Window {
    ploop?: PloopDesktopApi;
  }
}
export function desktopApi(): PloopDesktopApi | undefined {
  return typeof window === 'undefined' ? undefined : window.ploop;
}
