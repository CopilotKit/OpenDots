import { defineTool, type ToolDefinition } from '@copilotkit/runtime/v2';
import type { composioSession } from './composio.js';
import { safeFailure } from './slack-channel.js';

type Session = Awaited<ReturnType<typeof composioSession>>;
type CancellableSession = Session & {
  tools(
    modifiers: Parameters<Session['tools']>[0],
    requestOptions: { signal?: AbortSignal },
  ): ReturnType<Session['tools']>;
  execute(
    toolSlug: string,
    input: Record<string, unknown>,
    options: Parameters<Session['execute']>[2],
    requestOptions: { signal?: AbortSignal },
  ): ReturnType<Session['execute']>;
};

export async function composioTools(
  session: Session,
  check: () => void,
  signal?: AbortSignal,
) {
  check();
  // @composio/core 0.22 supports request options at runtime but omits them
  // from the public Session function aliases.
  const cancellable = session as CancellableSession;
  const tools = await cancellable.tools(undefined, { signal });
  return tools
    .filter((tool) => tool.type === 'function')
    .map(({ function: fn }) =>
      defineTool({
        name: fn.name,
        description: fn.description ?? `Use the Composio ${fn.name} tool.`,
        parameters: fn.parameters as unknown as ToolDefinition['parameters'],
        execute: async (input: unknown) => {
          check();
          try {
            const { data, error } = await cancellable.execute(
              fn.name,
              input as Record<string, unknown>,
              undefined,
              { signal },
            );
            return { data, error };
          } catch (error) {
            return {
              data: {},
              error: `Composio tool failed: ${safeFailure(error)}.`,
            };
          }
        },
      }),
    );
}
