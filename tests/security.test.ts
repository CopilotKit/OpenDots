import { describe, expect, it } from 'vitest';
import { isPublicAddress, validateUrl } from '../src/browser/security.js';
describe('browser network boundaries', () => {
  it.each([
    '127.0.0.1',
    '10.0.0.1',
    '172.16.0.1',
    '192.168.0.1',
    '169.254.169.254',
    '0.0.0.0',
    '::1',
    '2001::1',
    '2001:100::1',
    '2002:7f00:1::',
    'fc00::1',
    'fe80::1',
    '3fff::1',
    '3fff:0fff::1',
    '::ffff:127.0.0.1',
    '224.0.0.1',
    '192.0.0.1',
    '192.0.2.1',
    '198.18.0.1',
    '198.19.255.255',
    '198.51.100.7',
    '203.0.113.9',
  ])('rejects private or special address %s', (address) =>
    expect(isPublicAddress(address)).toBe(false),
  );
  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '2606:4700:4700::1111',
    // Near, but outside, the documentation/benchmark ranges (not whole /16s).
    '192.0.1.1',
    '192.0.3.1',
    '198.51.99.1',
    '198.51.101.1',
    '203.0.112.1',
    '203.0.114.1',
    '203.0.200.1',
  ])('accepts public address %s', (address) =>
    expect(isPublicAddress(address)).toBe(true),
  );
  it('rejects non-http URLs and embedded credentials', async () => {
    await expect(validateUrl('file:///etc/passwd')).rejects.toThrow();
    await expect(
      validateUrl('https://user:pass@example.com'),
    ).rejects.toThrow();
    await expect(validateUrl('http://127.0.0.1')).rejects.toThrow();
  });
});
