import { defineTool, type ToolDefinition } from '@copilotkit/runtime/v2';
import type { composioSession } from './composio.js';
import { safeFailure } from './slack-channel.js';

type Session = Awaited<ReturnType<typeof composioSession>>;

export async function composioTools(session: Session, check: () => void) {
  const tools = await session.tools();
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
            const { data, error } = await session.execute(
              fn.name,
              input as Record<string, unknown>,
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
