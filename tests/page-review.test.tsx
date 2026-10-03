import { beforeEach, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
vi.mock('../src/client/api', () => ({ api: vi.fn() }));
import { api } from '../src/client/api';
import { decidePageReview } from '../src/client/page-review-decision';
import { PageReviewCard } from '../src/client/PageReviewCard';

beforeEach(() => {
  vi.mocked(api).mockReset();
});

it('declines malformed drafts without validating or saving them', async () => {
  vi.mocked(api).mockResolvedValue(null);
  expect(
    await decidePageReview('thread', 'call', { title: '' }, false),
  ).toBeNull();
  expect(api).toHaveBeenCalledTimes(1);
  expect(api).toHaveBeenCalledWith('/conversations/thread/reviewed-page/call');
});

it('recovers an already committed save instead of emitting a decline', async () => {
  const page = { id: 'saved', spaceId: 'space' };
  vi.mocked(api).mockResolvedValue(page);
  expect(await decidePageReview('thread', 'call', {}, false)).toBe(page);
  expect(api).toHaveBeenCalledTimes(1);
});

it('does not decide or save when receipt recovery fails', async () => {
  vi.mocked(api).mockRejectedValue(new Error('Access revoked'));
  await expect(decidePageReview('thread', 'call', {}, false)).rejects.toThrow(
    'Access revoked',
  );
  expect(api).toHaveBeenCalledTimes(1);
});

it('checks for a receipt before retrying a save whose response was lost', async () => {
  const draft = { title: 'Brief', content: 'Evidence', spaceId: 'space' };
  const page = { id: 'saved', ...draft, reviewDraft: draft };
  vi.mocked(api)
    .mockResolvedValueOnce(null)
    .mockRejectedValueOnce(new Error('Connection lost'));
  await expect(decidePageReview('thread', 'call', draft, true)).rejects.toThrow(
    'Connection lost',
  );
  vi.mocked(api).mockResolvedValueOnce(page);
  expect(await decidePageReview('thread', 'call', draft, true)).toBe(page);
  expect(
    vi.mocked(api).mock.calls.filter((call) => call[1] === 'POST'),
  ).toHaveLength(1);
});

it('rejects a changed restored draft before sending a decision or another save', async () => {
  const original = {
    title: 'Brief',
    content: 'Approved text',
    spaceId: 'space',
  };
  const page = {
    id: 'saved',
    ...original,
    content: 'The page was edited later.',
    reviewDraft: original,
  };
  vi.mocked(api).mockResolvedValue(page);
  expect(
    await decidePageReview('thread', 'call', original, true),
  ).toMatchObject({ id: 'saved' });
  for (const changed of [
    { ...original, title: 'Changed' },
    { ...original, content: 'Changed' },
    { ...original, spaceId: 'other' },
  ]) {
    await expect(
      decidePageReview('thread', 'call', changed, true),
    ).rejects.toThrow('different draft');
  }
  expect(
    vi.mocked(api).mock.calls.filter((call) => call[1] === 'POST'),
  ).toHaveLength(0);
});

it('hides decisions and unsaved claims until the persisted receipt is checked', () => {
  const html = renderToStaticMarkup(
    <PageReviewCard
      args={{ title: 'Brief', content: 'Evidence', spaceId: 'space' }}
      status="executing"
      respond={async () => {}}
      threadId="thread"
      toolCallId="call"
      onSaved={() => {}}
    />,
  );
  expect(html).toContain('Checking whether this draft was already saved.');
  expect(html).not.toContain('Decline');
  expect(html).not.toContain('Approve &amp; save');
  expect(html).not.toContain('Nothing is saved');
});

it('does not claim a canceled or declined review was unsaved before recovering its receipt', () => {
  for (const result of [
    undefined,
    JSON.stringify({ approved: false }),
    JSON.stringify({ status: 'stopped' }),
  ]) {
    const html = renderToStaticMarkup(
      <PageReviewCard
        args={{}}
        status="complete"
        result={result}
        threadId="thread"
        toolCallId="call"
        onSaved={() => {}}
      />,
    );
    expect(html).toContain('Checking whether this draft was already saved.');
    expect(html).not.toContain('No page was saved.');
    expect(html).not.toContain('Decline');
  }
});
