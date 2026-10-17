import type { SettingsPatch, SettingsStatus } from './settings';
import type { SignInResult } from './sign-in';
import type { LoginInput, LoginPatch, LoginSummary } from './vault';

// What the ploop window can ask the desktop app to do, exposed to the page as
// `window.ploop`. A copy of these types lives in src/client/desktop.ts.
export type PloopDesktopApi = {
  vault: {
    list(): Promise<LoginSummary[]>;
    add(input: LoginInput): Promise<LoginSummary>;
    update(id: string, patch: LoginPatch): Promise<LoginSummary>;
    remove(id: string): Promise<boolean>;
    // Each of these asks for Touch ID (or a confirmation) first.
    reveal(id: string): Promise<string>;
    copyPassword(id: string): Promise<void>;
    // Opens the site's own window and signs in, like pressing "Sign in".
    signIn(id: string): Promise<SignInResult>;
  };
  settings: {
    status(): Promise<SettingsStatus>;
    save(patch: SettingsPatch): Promise<void>;
    // Asks for the .env file the CopilotKit CLI wrote, saves its Intelligence
    // connection and restarts the server. Resolves without importing if cancelled.
    importIntelligence(): Promise<{ imported: boolean; local?: boolean }>;
  };
  app: {
    info(): Promise<{ version: string; signed: boolean }>;
    checkForUpdates(): Promise<void>;
  };
};
