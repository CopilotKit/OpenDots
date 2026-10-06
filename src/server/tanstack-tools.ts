import { toolDefinition } from '@tanstack/ai';
import type {
  BuiltInAgentFactoryContext,
  ToolDefinition,
} from '@copilotkit/runtime/v2';
import { z } from 'zod';

export function tanstackTools(tools: ToolDefinition[]) {
  return tools.map(({ name, description, parameters, execute }) => {
    if (!execute) throw new Error(`Server tool has no executor: ${name}`);
    return toolDefinition({
      name,
      description,
      inputSchema: parameters,
    }).server(execute);
  });
}

// CopilotKit supplies snapshot-bound executors in its factory context. Keep
// their execution tied to that verified snapshot, with validated inputs.
export function learnedSkillTools(
  { learnedSkills, abortSignal }: BuiltInAgentFactoryContext,
  check: () => void,
) {
  return Object.entries(learnedSkills.tools).map(([name, tool]) => {
    const inputSchema =
      name === 'copilotkit_load_skill'
        ? z.object({ skill_name: z.string() })
        : name === 'copilotkit_read_skill_file'
          ? z.object({ skill_name: z.string(), path: z.string() })
          : undefined;
    const execute = tool.execute;
    if (!inputSchema || !execute)
      throw new Error(`Unsupported learned-skill tool: ${name}`);
    return toolDefinition({
      name,
      description: tool.description ?? name,
      inputSchema,
    }).server(async (input, context) => {
      check();
      abortSignal.throwIfAborted();
      return execute(input, {
        toolCallId: context?.toolCallId ?? name,
        messages: [],
        abortSignal,
      });
    });
  });
}
