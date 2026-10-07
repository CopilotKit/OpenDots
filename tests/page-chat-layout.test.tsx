import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { chromium } from 'playwright';
import { expect, it, vi } from 'vitest';
import { Chat } from '../src/client/Chat';
import { PageReviewCard } from '../src/client/PageReviewCard';

vi.mock('@copilotkit/react-core/v2', () => ({
  useAgent: () => ({
    isReady: true,
    agent: {
      messages: [
        { id: 'user', role: 'user', content: 'Please review these notes.' },
        {
          id: 'assistant',
          role: 'assistant',
          content: 'I prepared a review draft with the key points.',
          toolCalls: [
            {
              id: 'review',
              type: 'function',
              function: { name: 'review_space_page', arguments: '{}' },
            },
          ],
        },
      ],
    },
  }),
  useCopilotKit: () => ({ copilotkit: {} }),
  useHumanInTheLoop: () => {},
  useRenderTool: () => {},
  CopilotChatToolCallsView: () => (
    <PageReviewCard
      args={{
        title: 'Project notes',
        content: 'A summary of the project plan.',
        spaceId: 'space',
      }}
      status="executing"
      threadId="thread"
      toolCallId="review"
      onSaved={() => {}}
    />
  ),
}));
vi.mock('../src/client/api', () => ({ api: vi.fn() }));
vi.mock('../src/client/useVoice', () => ({
  useVoice: () => ({ status: 'idle' }),
}));
vi.mock('../src/client/CallView', () => ({ CallView: () => null }));

it('keeps page chat inside its sidebar across desktop and stacked widths', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const page = await browser.newPage();
    const css = ['style.css', 'editor.css']
      .map((file) =>
        readFileSync(new URL(`../src/client/${file}`, import.meta.url), 'utf8'),
      )
      .join('\n');
    const html = renderToStaticMarkup(
      <section
        className="document-session chat-visible"
        style={{ height: 900 }}
      >
        <div className="document-column">Project notes</div>
        <div className="document-assistant open">
          <aside className="document-chat-panel">
            <div className="document-chat-heading">
              <span>Page conversation</span>
              <button>Close</button>
            </div>
            <Chat
              thread={{
                id: 'thread',
                dotId: 'dot',
                ownerId: 'owner',
                title: 'Page chat',
                createdAt: 0,
              }}
              dot={{
                id: 'dot',
                name: 'Research specialist',
                spaceId: 'space',
                spaceIds: ['space'],
                instructions: 'Review notes',
                researchAllowed: false,
                memoryAllowed: false,
                createdAt: 0,
              }}
              onConsumed={() => {}}
              voiceReady={false}
              calls={[]}
              paused={false}
              onSaved={() => {}}
              onSchedule={() => {}}
            />
          </aside>
        </div>
      </section>,
    );
    await page.setContent(`<style>${css}</style>${html}`);
    for (const width of [1320, 1150, 901, 900, 700, 390]) {
      await page.setViewportSize({ width, height: 900 });
      const bounds = await page
        .locator('.document-assistant')
        .evaluate((panel) => {
          const chat = panel.querySelector('.live-chat')!;
          return {
            panelWidth: panel.clientWidth,
            panelScroll: panel.scrollWidth,
            chatRight: chat.getBoundingClientRect().right,
            panelRight: panel.getBoundingClientRect().right,
          };
        });
      expect(
        bounds.panelScroll,
        `panel overflow at ${width}px`,
      ).toBeLessThanOrEqual(bounds.panelWidth + 1);
      expect(
        bounds.chatRight,
        `chat extends outside panel at ${width}px`,
      ).toBeLessThanOrEqual(bounds.panelRight + 1);
    }
  } finally {
    await browser.close();
  }
}, 30000);
