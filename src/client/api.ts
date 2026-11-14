let token = sessionStorage.getItem('opendots-token') ?? '';
let tokenHeaders = headersFor(token);
function headersFor(value: string): Record<string, string> {
  return value ? { Authorization: `Bearer ${value}` } : {};
}
export function setToken(value: string) {
  token = value;
  tokenHeaders = headersFor(value);
  if (value) sessionStorage.setItem('opendots-token', value);
  else sessionStorage.removeItem('opendots-token');
}
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  method = 'GET',
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    signal,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(['GET', 'HEAD'].includes(method)
        ? {}
        : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = (await response
    .json()
    .catch(() => ({ error: 'Server returned an unreadable response.' }))) as {
    error?: string;
  };
  if (!response.ok)
    throw new ApiError(
      data.error ?? `Request failed (${response.status}).`,
      response.status,
    );
  return data as T;
}
// The same object until the token changes. CopilotKitProvider refetches
// inspector metadata whenever its headers prop is a new object.
export function authHeaders(): Record<string, string> {
  return tokenHeaders;
}
