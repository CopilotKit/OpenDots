import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
export function isPublicAddress(address: string): boolean {
  const ip = address.toLowerCase().replace(/^\[|\]$/g, '');
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0 || b === 2)) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0)
    );
  }
  if (isIP(ip) === 6) {
    const normalized = new URL(`http://[${ip}]`).hostname.slice(1, -1);
    const second = Number.parseInt(normalized.split(':')[1] || '0', 16);
    if (normalized.startsWith('2001:') && second < 0x200) return false;
    if (normalized.startsWith('3fff:') && second < 0x1000) return false;
    return (
      /^[23][0-9a-f]{3}:/.test(normalized) &&
      !/^(2001:(0:|db8:|10:|20:)|2002:)/.test(normalized)
    );
  }
  return false;
}
export async function validateUrl(
  input: string,
): Promise<{ url: URL; address: string; family: number }> {
  const url = new URL(input);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error(
      'Only public HTTP(S) URLs without credentials are allowed.',
    );
  if (url.port && !['80', '443'].includes(url.port))
    throw new Error('Only standard web ports are allowed.');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local')
  )
    throw new Error('Local addresses are blocked.');
  const addresses = await lookup(hostname, { all: true });
  if (
    !addresses.length ||
    addresses.some((item) => !isPublicAddress(item.address))
  )
    throw new Error('Private or special network addresses are blocked.');
  return { url, ...addresses[0] };
}
