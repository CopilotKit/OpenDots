import { expect, it } from 'vitest';
import {
  applyCaptureResult,
  applyRefreshResult,
  dismissNotice,
  visibleNotice,
  type Notices,
} from '../src/client/poll-notice';

const saved: Notices = { connection: '', action: 'Could not save.' };

it('clears a recovered connection error without wiping an action error', () => {
  const lost = applyRefreshResult(saved, {
    ok: false,
    message: 'Server returned an unreadable response.',
    status: 502,
  });
  expect(lost).toEqual({
    connection: 'Server returned an unreadable response.',
    action: 'Could not save.',
  });
  expect(visibleNotice(lost)).toBe('Could not save.');

  const recovered = applyRefreshResult(lost, { ok: true });
  expect(recovered).toEqual(saved);
  expect(
    visibleNotice(
      applyRefreshResult(
        { connection: 'Failed to fetch', action: '' },
        { ok: true },
      ),
    ),
  ).toBe('');
});

it('keeps an unauthorized poll from replacing the connection notice', () => {
  const current: Notices = { connection: 'Failed to fetch', action: '' };
  expect(
    applyRefreshResult(current, {
      ok: false,
      status: 401,
      message: 'Enter your owner access token to unlock OpenDots.',
    }),
  ).toBe(current);
});

it('treats a capture transport failure as a connection notice and leaves save errors in place', () => {
  const lost = applyCaptureResult(saved, {
    ok: false,
    message: 'Failed to fetch',
  });
  expect(lost.connection).toBe('Failed to fetch');
  expect(lost.action).toBe('Could not save.');
  expect(applyCaptureResult(lost, { ok: true })).toEqual(saved);

  const specific = applyCaptureResult(
    { connection: 'Failed to fetch', action: 'Could not save.' },
    { ok: false, status: 500, message: 'Thread not found.' },
  );
  expect(specific.connection).toBe('Failed to fetch');
  expect(specific.action).toBe('Thread not found.');
  expect(applyRefreshResult(specific, { ok: true }).action).toBe(
    'Thread not found.',
  );
});

it('dismisses the visible notice and leaves the other one', () => {
  const both: Notices = {
    connection: 'Failed to fetch',
    action: 'Could not save.',
  };
  expect(dismissNotice(both)).toEqual({
    connection: 'Failed to fetch',
    action: '',
  });
  expect(dismissNotice({ connection: 'Failed to fetch', action: '' })).toEqual({
    connection: '',
    action: '',
  });
});
