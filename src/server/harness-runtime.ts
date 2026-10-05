import { existsSync } from 'node:fs';
import type { ModelProvider } from './models.js';

// Only bounded, application-authored setup messages can reach the chat UI.
export class HarnessSetupError extends Error {}

export function assertHarnessRuntime({
  provider,
  host = '127.0.0.1',
  nodeEnv,
  container = false,
}: {
  provider: ModelProvider;
  host?: string;
  nodeEnv?: string;
  container?: boolean;
}): void {
  if (provider !== 'claude-code' && provider !== 'codex') return;
  if (
    nodeEnv !== 'development' ||
    container ||
    !['127.0.0.1', '::1', 'localhost'].includes(host)
  ) {
    throw new HarnessSetupError(
      'Subscription harnesses require local development on a loopback host. Run npm run dev after CLI login, or select an HTTPS API provider for built, hosted, or Docker deployments.',
    );
  }
}

export function harnessEnvironment() {
  return {
    host: process.env.HOST?.trim() || '127.0.0.1',
    nodeEnv: process.env.NODE_ENV,
    container:
      ['true', '1'].includes(process.env.OPENDOTS_CONTAINER ?? '') ||
      existsSync('/.dockerenv'),
  };
}
