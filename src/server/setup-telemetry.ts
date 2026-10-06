import { randomUUID } from 'node:crypto';
import { EventType } from '@ag-ui/core';
import { z } from 'zod';
import type { Store } from './store.js';

const step = z.enum(['setup_required', 'ready', 'settings']);
const viewed = z.object({ kind: z.literal('step_viewed'), step }).strict();
const abandoned = z
  .object({ kind: z.literal('setup_abandoned'), step })
  .strict();
export const setupInputSchema = z.discriminatedUnion('kind', [
  viewed,
  abandoned,
]);
const eventSchema = z.discriminatedUnion('kind', [
  viewed,
  abandoned,
  z.object({ kind: z.literal('activated') }).strict(),
  z
    .object({
      kind: z.literal('setup_failed'),
      step,
      error_class: z.enum([
        'configuration_missing',
        'assistant_run_failed',
        'channel_start_failed',
      ]),
    })
    .strict(),
]);
export type SetupEvent = z.infer<typeof eventSchema>;
const stateSchema = z
  .object({
    identity: z.string().min(1),
    installationId: z.uuid(),
    activated: z.boolean(),
    lastStep: step.optional(),
    queue: z
      .array(
        z
          .object({
            id: z.uuid(),
            occurredAt: z.number().int().nonnegative(),
            event: eventSchema,
          })
          .strict(),
      )
      .max(256),
  })
  .strict();
type State = z.infer<typeof stateSchema>;
export const setupMetadata = {
  accessibility_title: 'OpenDots',
  opendots_distribution: 'web',
  opendots_version: '0.1.0',
  runtime_env: 'node',
  server_platform:
    process.platform === 'darwin'
      ? 'macos'
      : process.platform === 'win32'
        ? 'windows'
        : process.platform === 'linux'
          ? 'linux'
          : 'other',
  server_arch:
    process.arch === 'arm64'
      ? 'aarch64'
      : process.arch === 'x64'
        ? 'x86_64'
        : 'other',
  sampleRate: 1,
  sampleWeight: 1,
  sampleRateAdjustmentFactor: 0,
} as const;
const names: Record<SetupEvent['kind'], string> = {
  step_viewed: 'oss.runtime.setup_step_viewed',
  setup_failed: 'oss.runtime.setup_failed',
  activated: 'oss.runtime.setup_activated',
  setup_abandoned: 'oss.runtime.setup_abandoned',
};
type Diagnostic =
  'delivery_failed' | 'storage_failed' | 'invalid_state' | 'invalid_event';
type Send = (identity: string, body: Record<string, unknown>) => Promise<void>;
const productionSend: Send = async (identity, body) => {
  const response = await fetch('https://telemetry.copilotkit.ai/ingest', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CopilotKit-Telemetry-Id': identity,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(1500),
  });
  if (!response.ok) throw new Error('Telemetry delivery failed');
};

/** Installation-scoped state contains closed metadata only; credentials never enter it. */
export class SetupTelemetry {
  private state?: State;
  private pending?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  constructor(
    private store: Store,
    private env: NodeJS.ProcessEnv = process.env,
    private send: Send = productionSend,
    private report: (diagnostic: Diagnostic) => void = (diagnostic) =>
      console.error({
        error: diagnostic,
        context: { component: 'setup_telemetry' },
        timestamp: new Date().toISOString(),
      }),
  ) {
    if (!this.enabled()) return;
    try {
      const saved = this.store.setupTelemetryState();
      const parsed = saved
        ? stateSchema.safeParse(JSON.parse(saved))
        : undefined;
      if (parsed && !parsed.success) this.report('invalid_state');
      const installationId = randomUUID();
      this.state = parsed?.success
        ? parsed.data
        : {
            identity: installationId,
            installationId,
            activated: false,
            queue: [],
          };
      // The CLI identity remains authoritative, including queued events on replay.
      this.state.identity = this.env.CPK_TELEMETRY_ID?.trim()
        ? this.env.CPK_TELEMETRY_ID
        : this.state.installationId;
      if (this.state.lastStep && !this.state.activated) {
        const last = this.state.lastStep;
        this.capture({ kind: 'setup_abandoned', step: last });
      }
      this.persist();
    } catch {
      this.report('storage_failed');
    }
  }
  get identity() {
    return this.state?.identity;
  }
  get metadata() {
    return {
      ...setupMetadata,
      ...(this.state ? { installation_id: this.state.installationId } : {}),
    };
  }
  private enabled() {
    const off =
      ['DO_NOT_TRACK', 'COPILOTKIT_TELEMETRY_DISABLED'].some((key) =>
        ['true', '1'].includes(this.env[key] ?? ''),
      ) || this.env.COPILOTKIT_TELEMETRY_SAMPLE_RATE === '0';
    if (off) {
      this.state = undefined;
      try {
        this.store.clearSetupTelemetry();
      } catch {
        this.report('storage_failed');
      }
    }
    return !off;
  }
  private persist() {
    if (!this.state) return false;
    try {
      this.store.saveSetupTelemetryState(JSON.stringify(this.state));
      return true;
    } catch {
      this.report('storage_failed');
      return false;
    }
  }
  capture(input: SetupEvent) {
    if (!this.enabled() || !this.state) return;
    const parsed = eventSchema.safeParse(input);
    if (!parsed.success) {
      this.report('invalid_event');
      return;
    }
    const event = parsed.data;
    if (event.kind === 'activated') {
      if (this.state.activated) return;
      this.state.activated = true;
      delete this.state.lastStep;
    } else if (event.kind === 'step_viewed' && !this.state.activated) {
      this.state.lastStep = event.step;
    } else if (event.kind === 'setup_abandoned') {
      if (this.state.activated || this.state.lastStep !== event.step) return;
      delete this.state.lastStep;
    }
    this.state.queue.push({
      id: randomUUID(),
      occurredAt: Math.floor(Date.now() / 1000),
      event,
    });
    this.state.queue = this.state.queue.slice(-256);
    this.persist();
  }
  start() {
    if (this.timer || !this.enabled()) return;
    // Delivery is independent of setup; flush reports failures with closed diagnostics.
    void this.flush();
    this.timer = setInterval(() => void this.flush(), 15000);
    this.timer.unref();
  }
  async stop() {
    clearInterval(this.timer);
    this.timer = undefined;
    if (this.state?.lastStep)
      this.capture({ kind: 'setup_abandoned', step: this.state.lastStep });
    await this.flush();
  }
  flush(): Promise<void> {
    return (this.pending ??= this.deliver()
      .catch(() => this.report('delivery_failed'))
      .finally(() => {
        this.pending = undefined;
      }));
  }
  private async deliver() {
    if (!this.enabled() || !this.state || !this.persist()) return;
    // One bounded pass. New events and retries are handled by the next pass.
    const queued = this.state?.queue.slice() ?? [];
    const deadline = Date.now() + 2000;
    for (const entry of queued) {
      if (Date.now() >= deadline) return;
      if (!this.enabled() || !this.state) return;
      try {
        await this.send(this.state.identity, {
          event: names[entry.event.kind],
          event_id: entry.id,
          properties: entry.event,
          global_properties: this.metadata,
          package: { name: 'opendots', version: '0.1.0' },
          ts: entry.occurredAt,
        });
      } catch {
        this.report('delivery_failed');
        return;
      }
      if (!this.enabled() || !this.state) return;
      this.state.queue = this.state.queue.filter(
        (event) => event.id !== entry.id,
      );
      this.persist();
    }
  }
}

/** No text is retained: only successful nonempty answer / failure booleans. */
export function answerObserver(capture: (event: SetupEvent) => void) {
  let text = false;
  const assistantMessages = new Set<string>();
  let failed = false;
  return (event: {
    type: string;
    delta?: string;
    message?: string;
    messageId?: string;
    role?: string;
  }) => {
    if (
      event.type === EventType.TEXT_MESSAGE_START &&
      event.role === 'assistant' &&
      event.messageId
    )
      assistantMessages.add(event.messageId);
    if (
      event.type === EventType.TEXT_MESSAGE_CONTENT &&
      event.messageId &&
      assistantMessages.has(event.messageId) &&
      event.delta?.trim()
    )
      text = true;
    if (event.type === EventType.RUN_ERROR && !failed) {
      failed = true;
      capture({
        kind: 'setup_failed',
        step: 'ready',
        error_class: 'assistant_run_failed',
      });
    }
    if (event.type === EventType.RUN_FINISHED && text && !failed)
      capture({ kind: 'activated' });
  };
}
