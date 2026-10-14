import { expect, it, vi } from 'vitest';
import { composioTools } from '../src/server/composio-tools.js';
import type { composioSession } from '../src/server/composio.js';

type Session = Awaited<ReturnType<typeof composioSession>>;

it('passes Composio JSON Schema through and returns only safe execution failures', async () => {
  const parameters = {
    type: 'object' as const,
    properties: { query: { type: 'string' } },
    required: ['query'],
  };
  const execute = vi
    .fn()
    .mockResolvedValueOnce({ data: { ok: true }, error: null })
    .mockRejectedValueOnce(new Error('provider secret'));
  const tools = vi.fn().mockResolvedValue([
    {
      type: 'function',
      function: { name: 'COMPOSIO_TEST', description: 'Test', parameters },
    },
  ]);
  const session = {
    tools,
    execute,
  } as unknown as Session;
  const check = vi.fn();
  const signal = new AbortController().signal;
  const [tool] = await composioTools(session, check, signal);

  expect(tools).toHaveBeenCalledWith(undefined, { signal });

  expect(tool.parameters).toBe(parameters);
  await expect(tool.execute?.({ query: 'one' })).resolves.toEqual({
    data: { ok: true },
    error: null,
  });
  await expect(tool.execute?.({ query: 'two' })).resolves.toEqual({
    data: {},
    error: 'Composio tool failed: Error.',
  });
  expect(execute).toHaveBeenCalledWith(
    'COMPOSIO_TEST',
    expect.anything(),
    undefined,
    { signal },
  );
  expect(check).toHaveBeenCalledTimes(3);
});
