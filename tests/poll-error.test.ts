import { expect, it } from 'vitest';
import { afterPollSuccess } from '../src/client/poll-error';

it('clears the failure the poll itself raised', () => {
  expect(afterPollSuccess('Failed to fetch', 'Failed to fetch')).toBe('');
});

it('leaves an error the owner is looking at from something they just did', () => {
  // A failed action reported its own error; a poll that happens to succeed a moment later must
  // not take it away before it has been read.
  expect(
    afterPollSuccess('That schedule interval is too short.', 'Failed to fetch'),
  ).toBe('That schedule interval is too short.');
});

it('leaves an error alone when the poll has not failed yet', () => {
  expect(
    afterPollSuccess('That folder is no longer available.', undefined),
  ).toBe('That folder is no longer available.');
});

it('stays empty when the owner already dismissed the banner', () => {
  expect(afterPollSuccess('', 'Failed to fetch')).toBe('');
});

it('does not clear a different message that happens to be showing', () => {
  // Two polls can fail for different reasons. Only the one the successful poll raised is its own.
  expect(
    afterPollSuccess('Could not reach the server.', 'Failed to fetch'),
  ).toBe('Could not reach the server.');
});
