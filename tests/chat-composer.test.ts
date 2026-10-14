import { expect, it, vi } from 'vitest';
import {
  shouldSubmitComposerOnKeyDown,
  submitComposerOnEnter,
} from '../src/client/chat-composer';

function keyEvent({
  key = 'Enter',
  shiftKey = false,
  isComposing = false,
  keyCode,
}: {
  key?: string;
  shiftKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
} = {}) {
  return {
    key,
    shiftKey,
    nativeEvent: {
      isComposing,
      keyCode,
    },
  };
}

it('does not submit Enter while IME composition is active', () => {
  expect(shouldSubmitComposerOnKeyDown(keyEvent({ isComposing: true }))).toBe(
    false,
  );
});

it('does not submit legacy IME composition Enter events', () => {
  expect(shouldSubmitComposerOnKeyDown(keyEvent({ keyCode: 229 }))).toBe(false);
});

it('submits Enter after composition completes', () => {
  expect(shouldSubmitComposerOnKeyDown(keyEvent())).toBe(true);
});

it('keeps Shift+Enter available for multiline drafts', () => {
  expect(shouldSubmitComposerOnKeyDown(keyEvent({ shiftKey: true }))).toBe(
    false,
  );
});

function enterEvent(init: Parameters<typeof keyEvent>[0] = {}) {
  const requestSubmit = vi.fn();
  const preventDefault = vi.fn();
  return {
    requestSubmit,
    preventDefault,
    event: {
      ...keyEvent(init),
      preventDefault,
      currentTarget: { form: { requestSubmit } },
    },
  };
}

it('submits the form when Enter is pressed in the home composer', () => {
  const { event, requestSubmit, preventDefault } = enterEvent();
  submitComposerOnEnter(event, true);
  expect(preventDefault).toHaveBeenCalled();
  expect(requestSubmit).toHaveBeenCalledTimes(1);
});

it('keeps Enter from adding a line but does not submit an empty or busy composer', () => {
  const { event, requestSubmit, preventDefault } = enterEvent();
  submitComposerOnEnter(event, false);
  expect(preventDefault).toHaveBeenCalled();
  expect(requestSubmit).not.toHaveBeenCalled();
});

it('leaves Shift+Enter alone so it still inserts a newline', () => {
  const { event, requestSubmit, preventDefault } = enterEvent({
    shiftKey: true,
  });
  submitComposerOnEnter(event, true);
  expect(preventDefault).not.toHaveBeenCalled();
  expect(requestSubmit).not.toHaveBeenCalled();
});
