// ploop only ever fills a password into a page whose origin it has checked,
// so every URL that reaches the vault or a sign-in goes through here first.

function isLoopbackHost(hostname: string) {
  return (
    hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
  );
}

// Returns the parsed URL when it is a place ploop is willing to sign in to:
// https anywhere, or http on this machine (for testing your own sites).
export function parseSiteUrl(input: string): URL | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }

  if (url.username !== '' || url.password !== '') return null;
  if (url.protocol === 'https:') return url;
  if (url.protocol === 'http:' && isLoopbackHost(url.hostname)) return url;
  return null;
}

export function sameOrigin(a: string, b: string) {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

// The host without a leading "www.", used as the default label and to match
// what the agent asks for ("github.com") against saved logins.
export function siteHost(url: string) {
  const parsed = parseSiteUrl(url);
  if (parsed == null) return '';
  return parsed.hostname.replace(/^www\./, '');
}

// What is safe to show the agent: no query string or fragment, which can carry
// session tokens.
export function publicUrl(url: string) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '';
  }
}
