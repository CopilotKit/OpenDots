import { describe, expect, it, vi } from 'vitest';
import {
  chatgptPlanBody,
  createChatgptPlanFetch,
} from '../src/server/chatgpt-plan-request.js';

describe('ChatGPT plan Responses request contract', () => {
  it('forces ephemeral streaming and strips fields excluded by plan sharing', () => {
    const result = chatgptPlanBody({
      model: 'account-model',
      input: [{ role: 'user', content: 'hello' }],
      store: true,
      stream: false,
      temperature: 0.2,
      max_output_tokens: 100,
      previous_response_id: 'old',
      metadata: { secret: 'no' },
    });
    expect(result).toMatchObject({
      model: 'account-model',
      store: false,
      stream: true,
    });
    expect(result).not.toHaveProperty('temperature');
    expect(result).not.toHaveProperty('max_output_tokens');
    expect(result).not.toHaveProperty('previous_response_id');
    expect(result).not.toHaveProperty('metadata');
  });

  it('places local function tools into a documented additional_tools input item', () => {
    const tools = [
      {
        type: 'function',
        name: 'create_space_page',
        parameters: { type: 'object' },
      },
    ];
    const result = chatgptPlanBody({
      input: [{ role: 'user', content: 'save this' }],
      tools,
    });
    expect(result).not.toHaveProperty('tools');
    expect(result.input).toEqual([
      { type: 'additional_tools', role: 'developer', tools },
      { role: 'user', content: 'save this' },
    ]);
  });

  it('keeps tools available before replayed tool history on continuation turns', () => {
    const result = chatgptPlanBody({
      input: [
        {
          type: 'function_call',
          call_id: 'call-1',
          name: 'read_space_page',
          arguments: '{}',
        },
        {
          type: 'function_call_output',
          call_id: 'call-1',
          output: 'page contents',
        },
        { role: 'user', content: 'continue' },
      ],
      tools: [{ type: 'function', name: 'read_space_page' }],
    });
    const input = result.input as Array<Record<string, unknown>>;
    expect(input[0]).toMatchObject({
      type: 'additional_tools',
      role: 'developer',
    });
    expect(input.slice(1)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'function_call', call_id: 'call-1' }),
        expect.objectContaining({
          type: 'function_call_output',
          call_id: 'call-1',
        }),
      ]),
    );
  });

  it('rewrites the actual fetch Request without exposing its bearer credential in the body', async () => {
    const mockFetch = vi.fn(async (request: Request) => {
      const body = await request.json();
      return Response.json({
        path: new URL(request.url).pathname,
        authorization: request.headers.get('authorization'),
        body,
      });
    });
    vi.stubGlobal('fetch', mockFetch);
    try {
      const planFetch = createChatgptPlanFetch(
        async () => 'fixture-oauth-token',
      );
      const result = await planFetch(
        new Request('https://api.openai.com/v1/responses', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'listed-model',
            input: [{ role: 'user', content: 'hello' }],
            temperature: 0.4,
            tools: [{ type: 'function', name: 'read_space_page' }],
          }),
        }),
      );
      const payload = await result.json();
      expect(payload.path).toBe('/v1/responses');
      expect(payload.authorization).toBe('Bearer fixture-oauth-token');
      expect(JSON.stringify(payload.body)).not.toContain('fixture-oauth-token');
      expect(payload.body.store).toBe(false);
      expect(payload.body.stream).toBe(true);
      expect(payload.body.input[0].type).toBe('additional_tools');
      expect(payload.body).not.toHaveProperty('temperature');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
