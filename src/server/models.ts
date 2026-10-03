import { resolve } from 'node:path';
import type { ClaudeCodePermissionMode } from '@tanstack/ai-claude-code';

// Provider routing shared by Dot chat and research briefs.
export type ModelProvider =
  'openai' | 'anthropic' | 'cline-pass' | 'claude-code' | 'codex' | 'custom';

export type AuthMode = 'api-key' | 'host';
export type ClaudePermissionMode = ClaudeCodePermissionMode;

export interface ModelCatalogEntry {
  id: string;
  provider: ModelProvider;
  label: string;
  // First unavailable instant. A retirement after October 14 starts October 15 UTC.
  retirementAt?: string;
}

// Configuration examples, not a claim about availability, pricing, or benchmarks.
export const MODEL_CATALOG: ModelCatalogEntry[] = [
  {
    id: 'claude-sonnet-5-5',
    provider: 'anthropic',
    label: 'Claude Sonnet 5.5',
  },
  { id: 'claude-opus-5-5', provider: 'anthropic', label: 'Claude Opus 5.5' },
  { id: 'claude-fable-5-1', provider: 'anthropic', label: 'Claude Fable 5.1' },
  { id: 'claude-haiku-4-5', provider: 'anthropic', label: 'Claude Haiku 4.5' },
  {
    id: 'claude-sonnet-5-5',
    provider: 'claude-code',
    label: 'Claude Sonnet 5.5 subscription',
  },
  {
    id: 'claude-opus-5-5',
    provider: 'claude-code',
    label: 'Claude Opus 5.5 subscription',
  },
  {
    id: 'gpt-5.2-codex',
    provider: 'codex',
    label: 'GPT-5.2 Codex subscription',
  },
  { id: 'gpt-6.1-sol', provider: 'openai', label: 'GPT-6.1 Sol' },
  { id: 'gpt-6-astra', provider: 'openai', label: 'GPT-6 Astra' },
  {
    id: 'gpt-5.5',
    provider: 'openai',
    label: 'GPT-5.5',
    retirementAt: '2026-10-15T00:00:00Z',
  },
  {
    id: 'cline-pass/qwen3.7-max',
    provider: 'cline-pass',
    label: 'Cline Pass Qwen Max',
  },
];

export const OPENAI_BASE_URL = 'https://api.openai.com/v1';
export const CLINE_PASS_BASE_URL = 'https://api.cline.bot/api/v1';
export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1';

export type HttpModel = {
  kind: 'http';
  provider: 'openai' | 'anthropic' | 'cline-pass' | 'custom';
  model: string;
  baseUrl: string;
  apiKey: string;
  harness: false;
};
export type ResolvedModel =
  | HttpModel
  | {
      kind: 'claude-code';
      provider: 'claude-code';
      model: string;
      authMode: 'host';
      cwd: string;
      permissionMode: ClaudePermissionMode;
      harness: true;
    }
  | {
      kind: 'codex';
      provider: 'codex';
      model: string;
      authMode: 'host';
      cwd: string;
      harness: true;
    };

export interface ModelSelection {
  provider?: string;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  anthropicKey?: string;
  anthropicModel?: string;
  anthropicBaseUrl?: string;
  clineKey?: string;
  clineModel?: string;
  clineBaseUrl?: string;
  claudeAuthMode?: string;
  claudeModel?: string;
  claudeCwd?: string;
  claudePermissionMode?: string;
  codexAuthMode?: string;
  codexModel?: string;
  codexCwd?: string;
  modelFallbacks?: string[];
}

export function catalogEntry(
  provider: ModelProvider,
  model: string,
): ModelCatalogEntry | undefined {
  return MODEL_CATALOG.find(
    (entry) => entry.provider === provider && entry.id === model,
  );
}

export function isRetired(entry: ModelCatalogEntry, now = new Date()): boolean {
  return !!entry.retirementAt && now >= new Date(entry.retirementAt);
}

export function parseProvider(value?: string): ModelProvider {
  // These aliases are intentional compatibility spellings. Unknown names never select a fallback.
  switch ((value ?? '').trim().toLowerCase()) {
    case 'anthropic':
      return 'anthropic';
    case 'cline-pass':
    case 'clinepass':
    case 'cline_pass':
      return 'cline-pass';
    case 'claude-code':
    case 'claude_code':
    case 'claude':
    case 'claude-subscription':
      return 'claude-code';
    case 'codex':
    case 'codex-subscription':
    case 'chatgpt':
    case 'openai-codex':
      return 'codex';
    case 'custom':
      return 'custom';
    case 'openai':
    case '':
      return 'openai';
    default:
      throw new Error(
        'MODEL_PROVIDER must be openai, anthropic, cline-pass, claude-code, codex, or custom.',
      );
  }
}

function rejectRetired(
  provider: ModelProvider,
  model: string,
  now: Date,
): void {
  const entry = catalogEntry(provider, model);
  if (entry && isRetired(entry, now))
    throw new Error(
      `Model ${model} is retired starting ${entry.retirementAt}. Set a supported model for ${provider}.`,
    );
}

function hostAuth(value: string | undefined, variable: string): 'host' {
  if (value !== undefined && value.trim() !== 'host')
    throw new Error(
      `${variable} must be host for subscription models. Use the provider's CLI login, or select the HTTPS API provider for API-key authentication.`,
    );
  return 'host';
}

export function parseClaudePermissionMode(
  value?: string,
): ClaudePermissionMode {
  switch (value?.trim() ?? 'acceptEdits') {
    case 'default':
      return 'default';
    case 'acceptEdits':
      return 'acceptEdits';
    case 'bypassPermissions':
      return 'bypassPermissions';
    case 'plan':
      return 'plan';
    default:
      throw new Error(
        'CLAUDE_PERMISSION_MODE must be default, acceptEdits, bypassPermissions, or plan.',
      );
  }
}

export function resolveModel(
  selection: ModelSelection,
  now = new Date(),
): ResolvedModel {
  const provider = parseProvider(selection.provider);
  if (provider === 'claude-code') {
    const authMode = hostAuth(selection.claudeAuthMode, 'CLAUDE_AUTH_MODE');
    const permissionMode = parseClaudePermissionMode(
      selection.claudePermissionMode,
    );
    const model = selection.claudeModel?.trim();
    if (!model)
      throw new Error('Set CLAUDE_MODEL for the Claude subscription harness.');
    rejectRetired('anthropic', model, now);
    return {
      kind: 'claude-code',
      provider,
      model,
      authMode,
      cwd: resolve(
        selection.claudeCwd?.trim() || '.opendots/harnesses/claude-code',
      ),
      permissionMode,
      harness: true,
    };
  }
  if (provider === 'codex') {
    const authMode = hostAuth(selection.codexAuthMode, 'CODEX_AUTH_MODE');
    const model = selection.codexModel?.trim();
    if (!model)
      throw new Error('Set CODEX_MODEL for the ChatGPT subscription harness.');
    rejectRetired('codex', model, now);
    rejectRetired('openai', model, now);
    return {
      kind: 'codex',
      provider,
      model,
      authMode,
      cwd: resolve(selection.codexCwd?.trim() || '.opendots/harnesses/codex'),
      harness: true,
    };
  }
  if (provider === 'anthropic') {
    const model = selection.anthropicModel?.trim();
    const apiKey = selection.anthropicKey?.trim();
    if (!apiKey || !model)
      throw new Error('Set ANTHROPIC_API_KEY and ANTHROPIC_MODEL.');
    rejectRetired(provider, model, now);
    return {
      kind: 'http',
      provider,
      model,
      apiKey,
      baseUrl: selection.anthropicBaseUrl?.trim() || ANTHROPIC_BASE_URL,
      harness: false,
    };
  }
  if (provider === 'cline-pass') {
    const model = selection.clineModel?.trim();
    const apiKey = selection.clineKey?.trim();
    if (!apiKey || !model)
      throw new Error('Set CLINE_API_KEY and CLINE_MODEL.');
    return {
      kind: 'http',
      provider,
      model,
      apiKey,
      baseUrl: selection.clineBaseUrl?.trim() || CLINE_PASS_BASE_URL,
      harness: false,
    };
  }
  const model = selection.model?.trim();
  const apiKey = selection.apiKey?.trim();
  if (!apiKey || !model)
    throw new Error('Set OPENAI_API_KEY and OPENAI_MODEL.');
  const baseUrl = selection.baseUrl?.trim() || OPENAI_BASE_URL;
  // Custom endpoints own their model lifecycle. The default OpenAI endpoint still uses OpenAI retirement rules.
  if (provider === 'openai' || new URL(baseUrl).hostname === 'api.openai.com')
    rejectRetired('openai', model, now);
  return { kind: 'http', provider, model, apiKey, baseUrl, harness: false };
}

export function chatCompletionsRequest(
  resolved: ResolvedModel,
  body: { temperature?: number; max_tokens?: number; messages: unknown },
) {
  if (resolved.harness)
    throw new Error(
      `Model ${resolved.model} runs via local harness, not HTTPS.`,
    );
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (resolved.provider === 'anthropic') {
    headers['x-api-key'] = resolved.apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else headers['Authorization'] = `Bearer ${resolved.apiKey}`;
  return {
    url: `${resolved.baseUrl.replace(/\/$/, '')}/chat/completions`,
    headers,
    payload: { model: resolved.model, ...body },
  };
}
