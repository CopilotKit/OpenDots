import { beforeEach, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
vi.mock('../src/client/api', () => ({ api: vi.fn() }));
import { api } from '../src/client/api';
import {
  decidePageReview,
  fetchReviewTarget,
  isDeletedReview,
} from '../src/client/page-review-decision';
import { approveLabel, PageReviewCard } from '../src/client/PageReviewCard';

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

it('recognizes a saved review whose page was deleted without saving again', async () => {
  const draft = { title: 'Brief', content: 'Evidence', spaceId: 'space' };
  const deleted = {
    deleted: true,
    pageId: 'gone',
    spaceId: 'space',
    reviewDraft: draft,
  };
  vi.mocked(api).mockResolvedValue(deleted);
  const result = await decidePageReview('thread', 'call', draft, true);
  expect(isDeletedReview(result)).toBe(true);
  expect(result).toBe(deleted);
  expect(
    vi.mocked(api).mock.calls.filter((call) => call[1] === 'POST'),
  ).toHaveLength(0);
  expect(isDeletedReview({ id: 'page' })).toBe(false);
  expect(isDeletedReview(null)).toBe(false);
});

it('rejects a changed draft for a review whose page was deleted', async () => {
  vi.mocked(api).mockResolvedValue({
    deleted: true,
    pageId: 'gone',
    spaceId: 'space',
    reviewDraft: { title: 'Brief', content: 'Evidence', spaceId: 'space' },
  });
  await expect(
    decidePageReview(
      'thread',
      'call',
      { title: 'Brief', content: 'Changed', spaceId: 'space' },
      true,
    ),
  ).rejects.toThrow('different draft');
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

it('renders a Markdown table in the draft as a table, not raw pipe text', () => {
  const content = '| Category | Score |\n| --- | --- |\n| Speed | 9 |';
  const html = renderToStaticMarkup(
    <PageReviewCard
      args={{ title: 'Brief', content, spaceId: 'space' }}
      status="executing"
      respond={async () => {}}
      threadId="thread"
      toolCallId="call"
      onSaved={() => {}}
    />,
  );
  expect(html).toContain('<table>');
  expect(html).toContain('<th>Category</th>');
  expect(html).toContain('<td>Speed</td>');
  expect(html).not.toContain('| Category |');
});

it('resolves no approval target for a create draft without calling the api', async () => {
  expect(await fetchReviewTarget('space', null)).toBeNull();
  expect(await fetchReviewTarget('space', undefined)).toBeNull();
  expect(api).not.toHaveBeenCalled();
});

it('identifies distinct existing pages so identical drafts cannot render identical cards', async () => {
  vi.mocked(api).mockImplementation(async (path: string) => {
    if (path === '/workspace')
      return { spaces: [{ id: 'space', name: 'Handbook' }] } as never;
    if (path === '/spaces/space/pages/page-a')
      return { id: 'page-a', title: 'Onboarding' } as never;
    if (path === '/spaces/space/pages/page-b')
      return { id: 'page-b', title: 'Release plan' } as never;
    throw new Error(`unexpected path ${path}`);
  });
  const first = await fetchReviewTarget('space', 'page-a');
  const second = await fetchReviewTarget('space', 'page-b');
  expect(first).toMatchObject({
    pageId: 'page-a',
    title: 'Onboarding',
    spaceId: 'space',
    spaceName: 'Handbook',
  });
  expect(second).toMatchObject({ pageId: 'page-b', title: 'Release plan' });
  expect(first?.title).not.toBe(second?.title);
});

it('keeps the target title when the workspace listing is unavailable', async () => {
  vi.mocked(api).mockImplementation(async (path: string) => {
    if (path === '/workspace') throw new Error('Forbidden');
    return { id: 'page-a', title: 'Onboarding' } as never;
  });
  expect(await fetchReviewTarget('space', 'page-a')).toMatchObject({
    title: 'Onboarding',
    spaceName: null,
  });
});

it('labels the approval action as an update or a create', () => {
  expect(approveLabel(true)).toBe('Approve & update page');
  expect(approveLabel(false)).toBe('Approve & create page');
  expect(approveLabel(true)).not.toBe(approveLabel(false));
});

it('flags update drafts on the card and stays silent for creates', () => {
  const update = renderToStaticMarkup(
    <PageReviewCard
      args={{
        title: 'Brief',
        content: 'Evidence',
        spaceId: 'space',
        pageId: 'page-a',
        expectedRevision: 2,
      }}
      status="executing"
      respond={async () => {}}
      threadId="thread"
      toolCallId="call"
      onSaved={() => {}}
    />,
  );
  // Until the target lookup resolves the card can only say it is
  // identifying the target; the unidentified fallback is gone.
  expect(update).toContain('Identifying the page this would update');
  expect(update).not.toContain('Updates an existing page.');
  const create = renderToStaticMarkup(
    <PageReviewCard
      args={{ title: 'Brief', content: 'Evidence', spaceId: 'space' }}
      status="executing"
      respond={async () => {}}
      threadId="thread"
      toolCallId="call"
      onSaved={() => {}}
    />,
  );
  expect(create).not.toContain('Updates an existing page');
  expect(create).not.toContain('Identifying the page');
});
