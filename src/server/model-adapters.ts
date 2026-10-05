import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { openaiCompatibleText } from '@tanstack/ai-openai/compatible';
import type { PlatformConfig } from './platform-config.js';
import { resolveModel, type ResolvedModel } from './models.js';
import {
  assertHarnessRuntime,
  harnessEnvironment,
  HarnessSetupError,
} from './harness-runtime.js';
import type { SandboxHandle, withSandbox } from '@tanstack/ai-sandbox';

type HarnessRuntime = { setupError: () => HarnessSetupError | undefined } & (
  | {
      kind: 'claude-code';
      adapter: ReturnType<
        typeof import('@tanstack/ai-claude-code').claudeCodeText
      >;
      middleware: ReturnType<typeof withSandbox>;
    }
  | {
      kind: 'codex';
      adapter: ReturnType<typeof import('@tanstack/ai-codex').codexText>;
      middleware: ReturnType<typeof withSandbox>;
    }
);

export function resolveActiveModel(config: PlatformConfig): ResolvedModel {
  return resolveModel({
    provider: config.modelProvider ?? 'openai',
    apiKey: config.apiKey,
    model: config.model,
    baseUrl: config.baseUrl,
    anthropicKey: config.anthropicKey,
    anthropicModel: config.anthropicModel,
    anthropicBaseUrl: config.anthropicBaseUrl,
    clineKey: config.clineKey,
    clineModel: config.clineModel,
    clineBaseUrl: config.clineBaseUrl,
    claudeAuthMode: config.claudeAuthMode,
    claudeModel: config.claudeModel,
    claudeCwd: config.claudeCwd,
    claudePermissionMode: config.claudePermissionMode,
    codexAuthMode: config.codexAuthMode,
    codexModel: config.codexModel,
    codexCwd: config.codexCwd,
    modelFallbacks: config.modelFallbacks,
  });
}

export function httpAdapterFor(resolved: ResolvedModel) {
  if (resolved.harness)
    throw new Error(`Model ${resolved.model} needs a harness adapter.`);
  return openaiCompatibleText(resolved.model, {
    apiKey: resolved.apiKey,
    baseURL: resolved.baseUrl,
    api: 'chat-completions',
    maxRetries: 1,
    ...(resolved.provider === 'anthropic'
      ? {
          defaultHeaders: {
            Authorization: null,
            'x-api-key': resolved.apiKey,
            'anthropic-version': '2023-06-01',
          },
        }
      : {}),
  });
}

export function harnessScrubbedEnvironment(): string[] {
  return Object.keys(process.env).filter(
    (key) =>
      /(?:_KEY|_TOKEN|_SECRET)$/i.test(key) ||
      /^_*(?:VARLOCK|DMNO)_/i.test(key) ||
      [
        'NODE_OPTIONS',
        'ELECTRON_RUN_AS_NODE',
        'OPENAI_BASE_URL',
        'OPENAI_API_BASE',
        'ANTHROPIC_BASE_URL',
        'CLAUDE_CODE_USE_BEDROCK',
        'CLAUDE_CODE_USE_VERTEX',
        'CLAUDE_CODE_USE_FOUNDRY',
      ].includes(key),
  );
}

async function requireHostLogin(
  handle: SandboxHandle,
  provider: 'claude-code' | 'codex',
  signal?: AbortSignal,
) {
  const statusSignal = AbortSignal.any([
    AbortSignal.timeout(10_000),
    ...(signal ? [signal] : []),
  ]);
  // local-process exec subscribes to future aborts only; refuse an already
  // aborted probe before it spawns and never accept partial output after abort.
  statusSignal.throwIfAborted();
  const result = await handle.process
    .exec(
      provider === 'claude-code'
        ? 'claude auth status --json'
        : 'codex login status',
      {
        signal: statusSignal,
        ...(process.platform === 'win32' &&
        !process.env.HOME &&
        process.env.USERPROFILE
          ? { env: { HOME: process.env.USERPROFILE } }
          : {}),
      },
    )
    .catch(() => {
      throw new HarnessSetupError(
        'The CLI subscription login check could not finish. Check the installed CLI and login on this machine, then retry.',
      );
    });
  statusSignal.throwIfAborted();
  if (result.exitCode === 127) {
    throw new HarnessSetupError(
      provider === 'claude-code'
        ? 'Claude CLI is unavailable. Install Claude Code, run claude auth login on this machine, then retry.'
        : 'Codex CLI is unavailable. Install Codex, run codex login on this machine, then retry.',
    );
  }
  if (provider === 'codex') {
    if (
      result.exitCode === 0 &&
      /logged in using chatgpt/i.test(`${result.stdout}\n${result.stderr}`)
    )
      return;
  } else if (result.exitCode === 0) {
    let status: unknown;
    try {
      status = JSON.parse(result.stdout);
    } catch {
      status = undefined;
    }
    if (
      typeof status === 'object' &&
      status !== null &&
      'loggedIn' in status &&
      status.loggedIn === true &&
      'authMethod' in status &&
      status.authMethod === 'claude.ai'
    )
      return;
  }
  throw new HarnessSetupError(
    provider === 'claude-code'
      ? 'Claude subscription login is required. Run claude auth login on this machine, then retry. API-key login is not a subscription.'
      : 'ChatGPT subscription login is required. Run codex login on this machine, then retry. API-key login is not a subscription.',
  );
}

export async function harnessAdapterFor(
  resolved: ResolvedModel,
  scope: { dotId: string; threadId: string; signal?: AbortSignal },
): Promise<HarnessRuntime> {
  if (!resolved.harness)
    throw new Error(`Model ${resolved.model} is not a harness model.`);
  assertHarnessRuntime({
    provider: resolved.provider,
    ...harnessEnvironment(),
  });
  const { defineSandbox, withSandbox } = await import('@tanstack/ai-sandbox');
  const { localProcessSandbox } =
    await import('@tanstack/ai-sandbox-local-process');
  const scopeId = createHash('sha256')
    .update(JSON.stringify([resolved.provider, scope.dotId, scope.threadId]))
    .digest('hex');
  // The SDK serializes thrown errors into events. Keep safe setup guidance
  // separately so no provider error payload needs to be trusted or forwarded.
  let setupError: HarnessSetupError | undefined;
  const definition = defineSandbox({
    id: `opendots-${resolved.provider}-${scopeId}`,
    workspace: { source: { type: 'none' }, root: '/workspace' },
    provider: localProcessSandbox({
      dir: join(resolved.cwd, scopeId),
      removeOnDestroy: false,
      scrubEnv: harnessScrubbedEnvironment(),
    }),
    lifecycle: { reuse: 'none', snapshot: 'none', destroyOnComplete: true },
    fileEvents: false,
    hooks: {
      onReady: async (handle) => {
        try {
          await requireHostLogin(handle, resolved.provider, scope.signal);
        } catch (error) {
          if (error instanceof HarnessSetupError) setupError = error;
          throw error;
        }
      },
    },
  });
  const middleware = withSandbox(definition);
  if (resolved.kind === 'claude-code') {
    const mod = await import('@tanstack/ai-claude-code');
    return {
      kind: resolved.kind,
      adapter: mod.claudeCodeText(resolved.model, {
        cwd: '/workspace',
        permissionMode: resolved.permissionMode,
        authMode: resolved.authMode,
        settingSources: ['project'],
      }),
      middleware,
      setupError: () => setupError,
    };
  }
  const mod = await import('@tanstack/ai-codex');
  return {
    kind: resolved.kind,
    adapter: mod.codexText(resolved.model, {
      cwd: '/workspace',
      authMode: resolved.authMode,
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
      webSearchMode: 'disabled',
    }),
    middleware,
    setupError: () => setupError,
  };
}
