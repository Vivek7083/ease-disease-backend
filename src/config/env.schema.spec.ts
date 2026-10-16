import { describe, expect, it } from 'vitest';
import { envSchema } from './env.schema.js';

describe('envSchema', () => {
  const validEnv = {
    NODE_ENV: 'development',
    PORT: '3000',
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  };

  it('accepts a fully valid config and coerces PORT to a number', () => {
    const result = envSchema.parse(validEnv);
    expect(result.PORT).toBe(3000);
    expect(typeof result.PORT).toBe('number');
  });

  it('defaults NODE_ENV to development and PORT to 3000 when omitted', () => {
    const { NODE_ENV: _NODE_ENV, PORT: _PORT, ...rest } = validEnv;
    const result = envSchema.parse(rest);
    expect(result.NODE_ENV).toBe('development');
    expect(result.PORT).toBe(3000);
  });

  it('rejects a missing DATABASE_URL', () => {
    const { DATABASE_URL: _DATABASE_URL, ...rest } = validEnv;
    expect(() => envSchema.parse(rest)).toThrow();
  });

  it('rejects a non-URL DATABASE_URL', () => {
    expect(() => envSchema.parse({ ...validEnv, DATABASE_URL: 'not-a-url' })).toThrow();
  });

  it('rejects an invalid NODE_ENV value', () => {
    expect(() => envSchema.parse({ ...validEnv, NODE_ENV: 'not-a-real-env' })).toThrow();
  });

  it('rejects a non-numeric PORT', () => {
    expect(() => envSchema.parse({ ...validEnv, PORT: 'not-a-port' })).toThrow();
  });

  describe('PayU config', () => {
    it('defaults PAYU_ENV to test and allows missing credentials in development', () => {
      const result = envSchema.parse(validEnv);
      expect(result.PAYU_ENV).toBe('test');
      expect(result.PAYU_KEY).toBeUndefined();
      expect(result.PAYU_SALT).toBeUndefined();
    });

    it.each(['staging', 'production'])('requires PAYU_KEY and PAYU_SALT when NODE_ENV is %s', (nodeEnv) => {
      expect(() => envSchema.parse({ ...validEnv, NODE_ENV: nodeEnv })).toThrow();
      expect(() => envSchema.parse({ ...validEnv, NODE_ENV: nodeEnv, PAYU_KEY: 'k' })).toThrow();
      expect(() => envSchema.parse({ ...validEnv, NODE_ENV: nodeEnv, PAYU_SALT: 's' })).toThrow();
      expect(envSchema.parse({ ...validEnv, NODE_ENV: nodeEnv, PAYU_KEY: 'k', PAYU_SALT: 's' }).PAYU_KEY).toBe('k');
    });

    it('rejects empty credential strings', () => {
      expect(() => envSchema.parse({ ...validEnv, PAYU_KEY: '' })).toThrow();
    });

    it('rejects an unknown PAYU_ENV', () => {
      expect(() => envSchema.parse({ ...validEnv, PAYU_ENV: 'sandbox' })).toThrow();
    });

    it('only allows PAYU_ENV=live in production', () => {
      const creds = { PAYU_KEY: 'k', PAYU_SALT: 's', PAYU_ENV: 'live' };
      expect(() => envSchema.parse({ ...validEnv, ...creds })).toThrow();
      expect(() => envSchema.parse({ ...validEnv, ...creds, NODE_ENV: 'staging' })).toThrow();
      expect(envSchema.parse({ ...validEnv, ...creds, NODE_ENV: 'production' }).PAYU_ENV).toBe('live');
    });
  });
});
