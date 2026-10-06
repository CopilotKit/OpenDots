export function completion(
  delta: Record<string, unknown>,
  finishReason = 'stop',
) {
  const chunks = [
    {
      id: 'completion',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'custom-model',
      choices: [{ index: 0, delta, finish_reason: null }],
    },
    {
      id: 'completion',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'custom-model',
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
    },
  ];
  return new Response(
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') +
      'data: [DONE]\n\n',
    {
      headers: { 'Content-Type': 'text/event-stream' },
    },
  );
}
