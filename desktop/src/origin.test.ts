import { describe, expect, it } from 'vitest';
import { parseSiteUrl, publicUrl, sameOrigin, siteHost } from './origin';

describe('origin helpers', () => {
  it('accepts https and local http only', () => {
    expect(parseSiteUrl('https://example.com/login')).not.toBeNull();
    expect(parseSiteUrl('http://localhost:3000')).not.toBeNull();
    expect(parseSiteUrl('http://127.0.0.1:8080/x')).not.toBeNull();
    expect(parseSiteUrl('http://example.com')).toBeNull();
    expect(parseSiteUrl('file:///etc/passwd')).toBeNull();
    expect(parseSiteUrl('https://a:b@example.com')).toBeNull();
  });

  it('compares origins exactly', () => {
    expect(sameOrigin('https://a.com/x', 'https://a.com/y?z=1')).toBe(true);
    expect(sameOrigin('https://a.com', 'https://a.com.evil.com')).toBe(false);
    expect(sameOrigin('https://a.com', 'http://a.com')).toBe(false);
    expect(sameOrigin('https://a.com', 'https://a.com:8443')).toBe(false);
    expect(sameOrigin('nonsense', 'https://a.com')).toBe(false);
  });

  it('strips the query and fragment from addresses shown to the agent', () => {
    expect(publicUrl('https://a.com/home?token=secret#frag')).toBe(
      'https://a.com/home',
    );
  });

  it('names a site by its host without www', () => {
    expect(siteHost('https://www.github.com/login')).toBe('github.com');
  });
});
