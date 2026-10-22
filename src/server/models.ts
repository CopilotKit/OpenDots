import type { WorkspaceStore } from './workspace.js';
import type { Dot, ModelSettings } from '../shared/types.js';

// Model roles let Dots follow platform choices: a light planner, a heavier
// default worker and a vision model. A Dot may also name a model directly.
export const modelRoles = ['@planner', '@default', '@vision'] as const;
const fallback = {
  plannerModel: 'qwen3:4b',
  visionModel: 'qwen3-vl:8b',
};

export class ModelRegistry {
  private available: string[] = [];
  private fetchedAt = 0;
  constructor(
    private workspace: WorkspaceStore,
    private defaultModel: string | undefined,
    private baseUrl: string,
  ) {}
  settings(): ModelSettings {
    return {
      defaultModel:
        this.workspace.setting('defaultModel') ?? this.defaultModel ?? '',
      plannerModel:
        this.workspace.setting('plannerModel') ?? fallback.plannerModel,
      visionModel:
        this.workspace.setting('visionModel') ?? fallback.visionModel,
      available: this.available,
    };
  }
  update(patch: Partial<Omit<ModelSettings, 'available'>>) {
    for (const [key, value] of Object.entries(patch))
      if (value) this.workspace.setSetting(key, value);
    return this.settings();
  }
  resolve(model: string | null | undefined): string {
    const settings = this.settings();
    if (!model || model === '@default') return settings.defaultModel;
    if (model === '@planner') return settings.plannerModel;
    if (model === '@vision') return settings.visionModel;
    return model;
  }
  forDot(dot: Pick<Dot, 'model'>) {
    return this.resolve(dot.model);
  }
  /** Models installed in the local Ollama server (cached briefly). */
  async refresh(): Promise<string[]> {
    if (Date.now() - this.fetchedAt < 15_000) return this.available;
    try {
      const root = this.baseUrl.replace(/\/v1\/?$/, '');
      const response = await fetch(`${root}/api/tags`, {
        signal: AbortSignal.timeout(3000),
      });
      const body = (await response.json()) as { models?: { name: string }[] };
      // Hide embedding models and Ollama's internal engine copies.
      this.available = [
        ...new Set(
          (body.models ?? [])
            .map((model) => model.name)
            .filter(
              (name) => !/embed/i.test(name) && !name.startsWith('llamacpp:'),
            ),
        ),
      ].sort();
      this.fetchedAt = Date.now();
    } catch {
      // Ollama offline: keep the last known list.
    }
    return this.available;
  }
}
