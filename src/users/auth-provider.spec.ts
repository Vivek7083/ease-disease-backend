import { describe, expect, it } from 'vitest';
import { mapSignInProvider } from './auth-provider.js';

describe('mapSignInProvider', () => {
  it('maps google.com to google.com', () => {
    expect(mapSignInProvider('google.com')).toBe('google.com');
  });

  it('maps password (what an email link reports) to emailLink', () => {
    expect(mapSignInProvider('password')).toBe('emailLink');
  });

  it.each(['facebook.com', 'github.com', 'anonymous', 'custom', 'phone', 'emailLink', 'Google.com', 'GOOGLE.COM', ' google.com', 'google.com ', 'password ', ''])(
    'does not offer "%s"',
    (raw) => {
      expect(mapSignInProvider(raw)).toBeUndefined();
    },
  );
});
