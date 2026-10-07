import { describe, expect, it } from 'vitest';
import { resolveAppOrigins } from '../src/config/env.js';

describe('application origin configuration', () => {
  it('allows both loopback browser origins by default in development', () => {
    expect(resolveAppOrigins(undefined, 'development')).toEqual([
      'http://localhost:5173',
      'http://127.0.0.1:5173',
    ]);
  });

  it.each(['production', 'test', undefined])(
    'preserves request-origin matching outside development (%s)',
    (nodeEnv) => {
      expect(resolveAppOrigins(undefined, nodeEnv)).toBeUndefined();
    },
  );

  it.each(['development', 'production'])(
    'replaces defaults with an explicit single origin in %s',
    (nodeEnv) => {
      expect(resolveAppOrigins('https://dots.example', nodeEnv)).toEqual([
        'https://dots.example',
      ]);
    },
  );

  it('trims multiple origins and drops empty entries', () => {
    expect(
      resolveAppOrigins(
        ' http://localhost:5173, ,http://127.0.0.1:5173, ',
        'development',
      ),
    ).toEqual(['http://localhost:5173', 'http://127.0.0.1:5173']);
  });

  it.each(['development', 'production'])(
    'treats an empty value as unset in %s',
    (nodeEnv) => {
      expect(resolveAppOrigins('', nodeEnv)).toEqual(
        resolveAppOrigins(undefined, nodeEnv),
      );
    },
  );

  it.each([' ', ', ,'])(
    'keeps a nonempty all-blank list restrictive (%s)',
    (value) => {
      expect(resolveAppOrigins(value, 'development')).toEqual([]);
    },
  );
});
