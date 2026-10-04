import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ToolDefinition } from '@copilotkit/runtime/v2';

type RpcMessage = {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { message?: string };
};
type Pending = { resolve(value: unknown): void; reject(error: Error): void };
type CodexAccount = { type: string } | null;

class CodexAppServer {
  private child: ChildProcessWithoutNullStreams;
  private pending = new Map<number, Pending>();
  private listeners = new Set<(message: RpcMessage) => void>();
  private nextId = 0;
  private ready: Promise<void>;

  constructor(command: string) {
    this.child = spawn(command, ['app-server', '--stdio'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child.stderr.on('data', () => {});
    const lines = createInterface({ input: this.child.stdout });
    lines.on('line', (line) => {
      let message: RpcMessage;
      try {
        message = JSON.parse(line) as RpcMessage;
      } catch {
        return;
      }
      if (message.id !== undefined && this.pending.has(Number(message.id))) {
        const pending = this.pending.get(Number(message.id))!;
        this.pending.delete(Number(message.id));
        if (message.error)
          pending.reject(
            new Error(message.error.message ?? 'Codex request failed.'),
          );
        else pending.resolve(message.result);
      } else {
        for (const listener of this.listeners) listener(message);
      }
    });
    this.child.on('error', (error) => this.fail(error));
    this.child.on('exit', (code) =>
      this.fail(new Error(`Codex app-server exited (${code ?? 'unknown'}).`)),
    );
    this.ready = this.request('initialize', {
      clientInfo: { name: 'opendots', title: 'OpenDots', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    }).then(() => {
      this.notify('initialized', {});
    });
  }

  private fail(error: Error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private write(message: Record<string, unknown>) {
    if (this.child.killed || !this.child.stdin.writable)
      throw new Error('Codex app-server is not available.');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private async request(method: string, params: unknown): Promise<any> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex ${method} request timed out.`));
      }, 20000);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      try {
        this.write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  private notify(method: string, params: unknown) {
    this.write({ method, params });
  }

  async account(): Promise<CodexAccount> {
    await this.ready;
    const response = (await this.request('account/read', {
      refreshToken: false,
    })) as { account?: CodexAccount };
    return response.account ?? null;
  }

  async readThread(threadId: string) {
    await this.ready;
    const response = (await this.request('thread/read', {
      threadId,
      includeTurns: true,
    })) as {
      thread?: {
        turns?: Array<{
          items?: Array<{
            type?: string;
            text?: string;
            content?: Array<{ type?: string; text?: string }>;
          }>;
        }>;
      };
    };
    return (response.thread?.turns ?? [])
      .flatMap((turn) => turn.items ?? [])
      .flatMap((item) => {
        if (item.type === 'agentMessage' && item.text?.trim())
          return [{ role: 'assistant', content: item.text }];
        if (item.type === 'userMessage') {
          const content = (item.content ?? [])
            .filter((part) => part.type === 'text')
            .map((part) => part.text ?? '')
            .join('\n');
          return content.trim() ? [{ role: 'user', content }] : [];
        }
        return [];
      });
  }

  async turn(input: {
    threadId?: string;
    instructions: string;
    text: string;
    tools: ToolDefinition[];
    onTool(name: string, args: unknown): Promise<unknown>;
    onDelta(text: string): void;
    onThread(threadId: string): void;
    signal: AbortSignal;
  }): Promise<string> {
    await this.ready;
    input.signal.throwIfAborted();
    const dynamicTools = input.tools.map((tool) => ({
      type: 'function',
      name: tool.name,
      description: tool.description,
      inputSchema: z.toJSONSchema(tool.parameters as z.ZodType),
    }));
    let threadId = input.threadId;
    if (threadId) {
      await this.request('thread/resume', {
        threadId,
        cwd: process.cwd(),
        approvalPolicy: 'untrusted',
        sandbox: 'read-only',
        developerInstructions: input.instructions,
      });
    } else {
      const modelResponse = (await this.request('model/list', {
        includeHidden: false,
      })) as {
        data?: Array<{ id?: string; model?: string }>;
        models?: Array<{ id?: string; model?: string }>;
      };
      const models = modelResponse.data ?? modelResponse.models ?? [];
      const model =
        models.find((candidate) => candidate.id === 'gpt-5.6-luna') ??
        models[0];
      const modelId = model?.id ?? model?.model;
      if (!modelId)
        throw new Error('Codex did not provide a model for this account.');
      const result = (await this.request('thread/start', {
        cwd: process.cwd(),
        model: modelId,
        approvalPolicy: 'untrusted',
        sandbox: 'read-only',
        developerInstructions: input.instructions,
        dynamicTools,
      })) as { thread?: { id?: string } };
      threadId = result.thread?.id;
      if (!threadId) throw new Error('Codex did not create a conversation.');
      input.onThread(threadId);
    }

    let turnId = '';
    let settled = false;
    let finalText = '';
    let unsubscribe = () => {};
    let abort = () => {};
    const completed = new Promise<string>((resolve, reject) => {
      unsubscribe = this.subscribe(async (message) => {
        const params = message.params ?? {};
        if (
          message.method === 'item/agentMessage/delta' &&
          params.threadId === threadId
        ) {
          const delta = typeof params.delta === 'string' ? params.delta : '';
          finalText += delta;
          input.onDelta(delta);
        } else if (
          message.method === 'turn/completed' &&
          params.threadId === threadId
        ) {
          settled = true;
          unsubscribe();
          const turn = params.turn as
            | { id?: string; status?: string; error?: { message?: string } }
            | undefined;
          if (turn?.id && turnId && turn.id !== turnId) return;
          if (turn?.status === 'failed')
            reject(
              new Error(
                turn.error?.message ?? 'Codex could not complete this turn.',
              ),
            );
          else if (turn?.status === 'interrupted')
            reject(new Error('Codex turn was interrupted.'));
          else resolve(finalText);
        } else if (
          message.method === 'item/tool/call' &&
          message.id !== undefined &&
          params.threadId === threadId
        ) {
          const methodName = String(params.tool ?? '');
          try {
            const result = await input.onTool(methodName, params.arguments);
            this.write({
              id: message.id,
              result: {
                success: true,
                contentItems: [{ type: 'inputText', text: stringify(result) }],
              },
            });
          } catch (error) {
            this.write({
              id: message.id,
              result: {
                success: false,
                contentItems: [
                  {
                    type: 'inputText',
                    text:
                      error instanceof Error ? error.message : 'Tool failed.',
                  },
                ],
              },
            });
          }
        } else if (
          message.id !== undefined &&
          (message.method === 'item/commandExecution/requestApproval' ||
            message.method === 'item/fileChange/requestApproval')
        ) {
          this.write({ id: message.id, result: { decision: 'decline' } });
        }
      });
      abort = () => {
        if (!settled) {
          settled = true;
          unsubscribe();
          reject(new Error('Codex turn was cancelled.'));
        }
        void this.request('turn/interrupt', { threadId }).catch(() => {});
      };
      input.signal.addEventListener('abort', abort, { once: true });
      void this.request('turn/start', {
        threadId,
        input: [{ type: 'text', text: input.text, text_elements: [] }],
        approvalPolicy: 'untrusted',
        sandboxPolicy: { type: 'readOnly', networkAccess: false },
      })
        .then((result) => {
          turnId = String(
            (result as { turn?: { id?: string } })?.turn?.id ?? '',
          );
        })
        .catch((error: unknown) => {
          unsubscribe();
          reject(
            error instanceof Error ? error : new Error('Codex request failed.'),
          );
        });
    });
    void completed.then(
      () => input.signal.removeEventListener('abort', abort),
      () => input.signal.removeEventListener('abort', abort),
    );
    return completed;
  }

  private subscribe(listener: (message: RpcMessage) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close() {
    this.child.kill();
  }
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

export class CodexService {
  private connected = false;
  constructor(private command = process.env.CODEX_CLI_PATH || 'codex') {}

  isConnected() {
    return this.connected;
  }

  async verify() {
    const server = new CodexAppServer(this.command);
    try {
      const account = await server.account();
      this.connected = account?.type === 'chatgpt';
      return { connected: this.connected, accountType: account?.type ?? null };
    } catch (error) {
      this.connected = false;
      throw error;
    } finally {
      server.close();
    }
  }

  async run(input: Parameters<CodexAppServer['turn']>[0]) {
    const server = new CodexAppServer(this.command);
    try {
      return await server.turn(input);
    } finally {
      server.close();
    }
  }

  async readThread(threadId?: string) {
    if (!threadId) return [];
    const server = new CodexAppServer(this.command);
    try {
      await server.account();
      return await server.readThread(threadId);
    } finally {
      server.close();
    }
  }
}
