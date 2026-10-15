import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { beforeEach, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => vi.fn());
vi.mock('../src/client/api', () => ({ api }));
import { WorkspaceDialog } from '../src/client/WorkspaceDialog';
import type { Dot } from '../src/shared/types';

const dot: Dot = {
  id: 'dot-to-delete',
  spaceId: 'space',
  spaceIds: ['space'],
  name: 'Research Scout',
  instructions: 'Research carefully',
  researchAllowed: true,
  memoryAllowed: true,
  appsAllowed: false,
  composioToolkits: [],
  createdAt: 1,
};
const contents = (node: unknown): string =>
  typeof node === 'string'
    ? node
    : Array.isArray(node)
      ? node.map(contents).join('')
      : node && typeof node === 'object' && 'children' in node
        ? contents((node as { children: unknown }).children)
        : '';
const button = (root: ReturnType<typeof create>, label: string) =>
  root.root.findAll(
    (node) =>
      node.type === 'button' && contents(node.props.children).includes(label),
  )[0];

beforeEach(() => {
  api.mockReset().mockResolvedValue([]);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('HTMLElement', class HTMLElementMock {});
  vi.stubGlobal('document', {
    activeElement: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelector: () => null,
  });
});

const props = (mutate: ReturnType<typeof vi.fn>) => ({
  dialog: { type: 'dot' as const, dot, spaceId: dot.spaceId },
  state: {
    settings: {
      researchAllowed: true,
      memoryAllowed: true,
      appsAllowed: false,
    },
  } as never,
  workspace: {
    spaces: [{ id: dot.spaceId, name: 'Everyday' }],
    dots: [dot],
    setup: { composio: false },
  } as never,
  onClose: vi.fn(),
  mutate: mutate as unknown as (
    path: string,
    method: string,
    body?: unknown,
  ) => Promise<{ ok: true } | { ok: false; error: string }>,
});

it('requires typing the specialist name before issuing the delete request', async () => {
  const mutate = vi.fn().mockResolvedValue({ ok: true });
  const p = props(mutate);
  let root!: ReturnType<typeof create>;
  await act(async () => {
    root = create(createElement(WorkspaceDialog, p));
  });
  await act(async () => {
    button(root, 'Delete this Dot').props.onClick();
  });
  expect(contents(root.toJSON())).toContain('Research Scout');
  const confirm = button(root, 'Delete Dot');
  expect(confirm.props.disabled).toBe(true);
  const nameInput = root.root.find(
    (node) => node.type === 'input' && node.props.id === 'confirm-dot-name',
  );
  await act(async () => {
    nameInput.props.onChange({ target: { value: 'Research Scout' } });
  });
  const enabledConfirm = button(root, 'Delete Dot');
  expect(enabledConfirm.props.disabled).toBe(false);
  await act(async () => {
    await enabledConfirm.props.onClick();
  });
  expect(mutate).toHaveBeenCalledWith('/dots/dot-to-delete', 'DELETE');
  expect(p.onClose).toHaveBeenCalledTimes(1);
});

it('keeps the confirmation open and shows dependency errors from the API', async () => {
  const mutate = vi.fn().mockResolvedValue({
    ok: false,
    error: 'End this Dot’s active call before deleting it.',
  });
  const p = props(mutate);
  let root!: ReturnType<typeof create>;
  await act(async () => {
    root = create(createElement(WorkspaceDialog, p));
  });
  await act(async () => {
    button(root, 'Delete this Dot').props.onClick();
  });
  const nameInput = root.root.find(
    (node) => node.type === 'input' && node.props.id === 'confirm-dot-name',
  );
  await act(async () => {
    nameInput.props.onChange({ target: { value: dot.name } });
  });
  await act(async () => {
    await button(root, 'Delete Dot').props.onClick();
  });
  expect(contents(root.toJSON())).toContain(
    'End this Dot’s active call before deleting it.',
  );
  expect(p.onClose).not.toHaveBeenCalled();
});
