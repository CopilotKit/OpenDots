export interface Notices {
  connection: string;
  action: string;
}

export interface PollFailure {
  ok: false;
  status?: number;
  message: string;
}

const TRANSPORT_MESSAGES = new Set([
  'Failed to fetch',
  'Server returned an unreadable response.',
]);

export function visibleNotice(notices: Notices): string {
  return notices.action || notices.connection;
}

export function dismissNotice(notices: Notices): Notices {
  if (notices.action) return { ...notices, action: '' };
  if (notices.connection) return { ...notices, connection: '' };
  return notices;
}

export function applyRefreshResult(
  current: Notices,
  result: { ok: true } | PollFailure,
): Notices {
  if (result.ok)
    return current.connection ? { ...current, connection: '' } : current;
  if (result.status === 401) return current;
  if (current.connection === result.message) return current;
  return { ...current, connection: result.message };
}

export function applyCaptureResult(
  current: Notices,
  result: { ok: true } | PollFailure,
): Notices {
  if (result.ok)
    return current.connection ? { ...current, connection: '' } : current;
  if (result.status === 401) return current;
  if (
    result.status === 502 ||
    result.status === 504 ||
    TRANSPORT_MESSAGES.has(result.message)
  ) {
    if (current.connection === result.message) return current;
    return { ...current, connection: result.message };
  }
  if (current.action === result.message) return current;
  return { ...current, action: result.message };
}
