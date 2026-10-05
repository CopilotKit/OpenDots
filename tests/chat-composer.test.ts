import { expect, it } from 'vitest';
import { shouldSubmitComposerOnKeyDown } from '../src/client/chat-composer';

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
