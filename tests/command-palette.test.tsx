import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { beforeEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => vi.fn());
vi.mock('../src/client/api', () => ({ api }));

import { CommandPalette } from '../src/client/CommandPalette';

const workspace = {
  spaces: [{ id: 'space-1', name: 'Everyday', description: '' }],
  dots: [
    {
      id: 'dot-1',
      name: 'Scout',
      instructions: 'Research carefully',
      spaceId: 'space-1',
    },
  ],
} as never;

const props = (overrides: Record<string, unknown> = {}) => ({
  open: true,
  spaceId: 'space-1',
  workspace,
  onClose: vi.fn(),
  onOpenPage: vi.fn(),
  onOpenSpace: vi.fn(),
  onNewPage: vi.fn(),
  onNewSpace: vi.fn(),
  onOpenDot: vi.fn(),
  ...overrides,
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  api.mockReset();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});

it('renders nothing when closed', async () => {
  let root!: ReturnType<typeof create>;
  await act(async () => {
    root = create(createElement(CommandPalette, props({ open: false })));
  });
  expect(root.toJSON()).toBeNull();
});

it('lists commands before searching and runs one with Enter', async () => {
  const p = props();
  let root!: ReturnType<typeof create>;
  await act(async () => {
    root = create(createElement(CommandPalette, p));
  });
  const input = root.root.findByProps({ role: 'combobox' });
  expect(root.root.findAllByProps({ role: 'option' }).length).toBeGreaterThan(
    0,
  );
  await act(async () => {
    input.props.onKeyDown({ key: 'Enter', preventDefault: () => {} });
  });
  expect(p.onNewPage).toHaveBeenCalledTimes(1);
  expect(p.onClose).toHaveBeenCalledTimes(1);
});

it('searches across the workspace and navigates with the keyboard', async () => {
  api.mockResolvedValue({
    query: 'launch',
    pages: [
      {
        kind: 'page',
        id: 'page-1',
        spaceId: 'space-1',
        spaceName: 'Everyday',
        title: 'Launch plan',
        excerpt: 'launch steps',
        updatedAt: 2,
        score: 30,
      },
    ],
    spaces: [],
    dots: [],
  });
  const p = props();
  let root!: ReturnType<typeof create>;
  await act(async () => {
    root = create(createElement(CommandPalette, p));
  });
  const input = root.root.findByProps({ role: 'combobox' });
  await act(async () => {
    input.props.onChange({ target: { value: 'launch' } });
  });
  await act(async () => {
    await sleep(300);
  });
  expect(api).toHaveBeenCalledWith(
    '/search?q=launch&limit=20',
    'GET',
    undefined,
    expect.anything(),
  );
  const options = root.root.findAllByProps({ role: 'option' });
  expect(options.length).toBeGreaterThan(0);
  expect(options[0].props['aria-selected']).toBe(true);

  await act(async () => {
    input.props.onKeyDown({ key: 'ArrowDown', preventDefault: () => {} });
  });
  await act(async () => {
    input.props.onKeyDown({ key: 'Escape', preventDefault: () => {} });
  });
  expect(p.onClose).toHaveBeenCalled();
});
