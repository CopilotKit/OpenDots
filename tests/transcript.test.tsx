import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ChatTranscript,
  isInternalVoiceReceipt,
} from '../src/client/ChatTranscript';
import type { Message } from '@ag-ui/core';
it('keeps call receipts between the anchored message and later conversation turns', () => {
  const html = renderToStaticMarkup(
    <ChatTranscript
      messages={[
        { id: 'before', role: 'user', content: 'Before the call' },
        { id: 'after', role: 'assistant', content: 'Later message' },
      ]}
      calls={[
        {
          id: 'call',
          threadId: 'thread',
          status: 'ended',
          startedAt: 1000,
          endedAt: 6000,
          transcript: '',
          error: null,
          anchorMessageId: 'before',
        },
      ]}
    />,
  );
  expect(html.indexOf('Before the call')).toBeLessThan(
    html.indexOf('Call ended'),
  );
  expect(html.indexOf('Call ended')).toBeLessThan(
    html.indexOf('Later message'),
  );
});

it('renders tool-only assistant messages inline between chat turns without printing tool JSON', () => {
  const html = renderToStaticMarkup(
    <ChatTranscript
      messages={[
        { id: 'request', role: 'user', content: 'Open the website' },
        {
          id: 'tool-call',
          role: 'assistant',
          toolCalls: [
            {
              id: 'navigate',
              type: 'function',
              function: {
                name: 'computer_navigate',
                arguments: '{"url":"https://example.com"}',
              },
            },
          ],
        },
        { id: 'reply', role: 'assistant', content: 'Here is the summary' },
      ]}
      calls={[]}
      renderTools={(message) =>
        message.toolCalls?.length ? (
          <section>Inline computer view</section>
        ) : null
      }
    />,
  );
  expect(html.indexOf('Open the website')).toBeLessThan(
    html.indexOf('Inline computer view'),
  );
  expect(html.indexOf('Inline computer view')).toBeLessThan(
    html.indexOf('Here is the summary'),
  );
  expect(html).not.toContain('undefined');
  expect(html).not.toContain('computer_navigate');
});

it('visually labels scheduled prompts while keeping ordinary user messages unchanged', () => {
  const html = renderToStaticMarkup(
    <ChatTranscript
      messages={[
        { id: 'manual', role: 'user', content: 'Manual request' },
        {
          id: 'opendots:scheduled_task:run-1',
          role: 'user',
          content: 'Scheduled request body',
        },
        {
          id: 'opendots:scheduled_task:assistant',
          role: 'assistant',
          content: 'Scheduled request body',
          metadata: { opendotsSource: 'scheduled_task' },
        },
      ]}
      calls={[]}
    />,
  );

  expect(html).toContain('Manual request');
  expect(html).toContain('Scheduled request body');
  expect(html).toContain('Scheduled');
  expect(html).toContain('chat-bubble user scheduled');
  expect(html).toContain(
    '<div class="chat-bubble user"><p>Manual request</p></div>',
  );
  expect(html).toContain('chat-bubble assistant');
  expect(html.match(/Scheduled request body/g)).toHaveLength(2);
  expect(html.match(/scheduled-message-label/g)).toHaveLength(1);
});

it('labels a scheduled prompt from metadata without requiring a prefixed ID', () => {
  const html = renderToStaticMarkup(
    <ChatTranscript
      messages={[
        {
          id: 'scheduled',
          role: 'user',
          content: 'Metadata-marked scheduled prompt',
          metadata: { opendotsSource: 'scheduled_task' },
        },
      ]}
      calls={[]}
    />,
  );
  expect(html).toContain('scheduled-message-label');
  expect(html).toContain('Metadata-marked scheduled prompt');
});

it('retains the scheduled label when history replay provides only the durable message ID', () => {
  const html = renderToStaticMarkup(
    <ChatTranscript
      messages={[
        {
          id: 'opendots:scheduled_task:replayed',
          role: 'user',
          content: 'Replayed scheduled prompt',
        },
      ]}
      calls={[]}
    />,
  );

  expect(html).toContain('Scheduled');
  expect(html).toContain('Replayed scheduled prompt');
  expect(html).toContain('chat-bubble user scheduled');
});

it('hides only marked receipt prompts while retaining summaries and prior unmarked messages', () => {
  const messages: Message[] = [
    { id: 'legacy', role: 'user', content: 'Earlier unmarked receipt prompt' },
    {
      id: 'internal',
      role: 'user',
      content: 'Internal sync instructions',
      metadata: { opendotsSource: 'voice_receipt' },
    },
    {
      id: 'opendots:voice_receipt:durable',
      role: 'user',
      content: 'Persisted internal instructions without metadata',
    },
    {
      id: 'summary',
      role: 'assistant',
      content: 'Confirmed call summary',
      metadata: { opendotsSource: 'voice_receipt' },
    },
    {
      id: 'user',
      role: 'user',
      content: 'My next question',
      metadata: { opendotsSource: 'voice_compute' },
    },
  ];
  const html = renderToStaticMarkup(
    <ChatTranscript
      messages={messages.filter((message) => !isInternalVoiceReceipt(message))}
      calls={[]}
    />,
  );
  expect(html).not.toContain('Internal sync instructions');
  expect(html).not.toContain(
    'Persisted internal instructions without metadata',
  );
  expect(html).toContain('Earlier unmarked receipt prompt');
  expect(html).toContain('Confirmed call summary');
  expect(html).toContain('My next question');
});
