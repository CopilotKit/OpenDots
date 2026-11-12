export interface Notices {
  refresh: string;
  capture: string;
  action: string;
}

export interface PollFailure {
  ok: false;
  status?: number;
  message: string;
}

const TRANSPORT_MESSAGES = new Set(['Server returned an unreadable response.']);

// A failure that carries no HTTP status did not come from the API, so it is a
// network failure (fetch throws a TypeError whose text differs by browser).
function isTransportFailure(result: PollFailure): boolean {
  return (
    result.status === undefined ||
    result.status === 502 ||
    result.status === 504 ||
    TRANSPORT_MESSAGES.has(result.message)
  );
}

export function visibleNotice(notices: Notices): string {
  return notices.action || notices.refresh || notices.capture;
}

export function dismissNotice(notices: Notices): Notices {
  if (notices.action) return { ...notices, action: '' };
  if (notices.refresh) return { ...notices, refresh: '' };
  if (notices.capture) return { ...notices, capture: '' };
  return notices;
}

export function applyRefreshResult(
  current: Notices,
  result: { ok: true } | PollFailure,
): Notices {
  if (result.ok) return current.refresh ? { ...current, refresh: '' } : current;
  if (result.status === 401) return current;
  if (current.refresh === result.message) return current;
  return { ...current, refresh: result.message };
}

export function applyCaptureResult(
  current: Notices,
  result: { ok: true } | PollFailure,
): Notices {
  if (result.ok) return current.capture ? { ...current, capture: '' } : current;
  if (result.status === 401) return current;
  if (isTransportFailure(result)) {
    if (current.capture === result.message) return current;
    return { ...current, capture: result.message };
  }
  if (current.action === result.message) return current;
  return { ...current, action: result.message };
}
