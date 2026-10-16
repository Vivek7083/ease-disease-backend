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

  describe('FRONTEND_BASE_URL and TRUST_PROXY_HOPS', () => {
    const prod = { ...validEnv, NODE_ENV: 'production', PAYU_KEY: 'k', PAYU_SALT: 's', API_PUBLIC_URL: 'https://api.easedisease.in' };

    it('are optional in development and default TRUST_PROXY_HOPS to 0', () => {
      const result = envSchema.parse(validEnv);
      expect(result.FRONTEND_BASE_URL).toBeUndefined();
      expect(result.TRUST_PROXY_HOPS).toBe(0);
    });

    it.each([
      ['http://localhost:4200', 'http://localhost:4200'],
      ['http://localhost:4200/', 'http://localhost:4200'],
      ['https://easedisease.in', 'https://easedisease.in'],
      ['HTTPS://EaseDisease.in', 'https://easedisease.in'],
    ])('normalises %s to %s', (input, expected) => {
      expect(envSchema.parse({ ...validEnv, FRONTEND_BASE_URL: input }).FRONTEND_BASE_URL).toBe(expected);
    });

    it.each([
      'not a url',
      'javascript:alert(1)',
      'ftp://easedisease.in',
      'https://easedisease.in/app',
      'https://easedisease.in///',
      'https://easedisease.in/?x=1',
      'https://easedisease.in/#frag',
      'https://user:pass@easedisease.in',
      '',
    ])('rejects %j', (input) => {
      expect(() => envSchema.parse({ ...validEnv, FRONTEND_BASE_URL: input })).toThrow();
    });

    it.each(['staging', 'production'])('is required when NODE_ENV is %s, and must be https', (nodeEnv) => {
      const env = { ...prod, NODE_ENV: nodeEnv };
      expect(() => envSchema.parse(env)).toThrow();
      expect(() => envSchema.parse({ ...env, FRONTEND_BASE_URL: 'http://easedisease.in' })).toThrow();
      expect(envSchema.parse({ ...env, FRONTEND_BASE_URL: 'https://easedisease.in' }).FRONTEND_BASE_URL).toBe('https://easedisease.in');
    });

    it.each([['0', 0], ['1', 1], ['5', 5], ['', 0]])('accepts TRUST_PROXY_HOPS=%j (a blank value means 0, the safe default)', (input, expected) => {
      expect(envSchema.parse({ ...validEnv, TRUST_PROXY_HOPS: input }).TRUST_PROXY_HOPS).toBe(expected);
    });

    it.each(['-1', '6', '1.5', 'many'])('rejects TRUST_PROXY_HOPS=%j', (input) => {
      expect(() => envSchema.parse({ ...validEnv, TRUST_PROXY_HOPS: input })).toThrow();
    });
  });

  describe('API_PUBLIC_URL', () => {
    const deployed = { ...validEnv, PAYU_KEY: 'k', PAYU_SALT: 's', FRONTEND_BASE_URL: 'https://easedisease.in' };

    it('is optional in development', () => {
      expect(envSchema.parse(validEnv).API_PUBLIC_URL).toBeUndefined();
    });

    it.each([
      ['http://localhost:3000', 'http://localhost:3000'],
      ['https://api.easedisease.in/', 'https://api.easedisease.in'],
      ['HTTPS://API-Staging.EaseDisease.in', 'https://api-staging.easedisease.in'],
    ])('normalises %s to %s', (input, expected) => {
      expect(envSchema.parse({ ...validEnv, API_PUBLIC_URL: input }).API_PUBLIC_URL).toBe(expected);
    });

    it.each(['javascript:alert(1)', 'https://api.easedisease.in/v1', 'https://api.easedisease.in/?x=1', 'https://u:p@api.easedisease.in', 'nope', ''])(
      'rejects %j',
      (input) => {
        expect(() => envSchema.parse({ ...validEnv, API_PUBLIC_URL: input })).toThrow();
      },
    );

    it.each(['staging', 'production'])('is required in %s, and must be https', (nodeEnv) => {
      const env = { ...deployed, NODE_ENV: nodeEnv };
      expect(() => envSchema.parse(env)).toThrow(/API_PUBLIC_URL/);
      expect(() => envSchema.parse({ ...env, API_PUBLIC_URL: 'http://api.easedisease.in' })).toThrow(/API_PUBLIC_URL/);
      expect(envSchema.parse({ ...env, API_PUBLIC_URL: 'https://api.easedisease.in' }).API_PUBLIC_URL).toBe('https://api.easedisease.in');
    });
  });

  describe('PayU config', () => {
    it('defaults PAYU_ENV to test and allows missing credentials in development', () => {
      const result = envSchema.parse(validEnv);
      expect(result.PAYU_ENV).toBe('test');
      expect(result.PAYU_KEY).toBeUndefined();
      expect(result.PAYU_SALT).toBeUndefined();
    });

    it.each(['staging', 'production'])('requires PAYU_KEY and PAYU_SALT when NODE_ENV is %s', (nodeEnv) => {
      // A valid FRONTEND_BASE_URL is always present here, so only the PayU credentials can be the reason for a failure.
      const deployed = { ...validEnv, NODE_ENV: nodeEnv, FRONTEND_BASE_URL: 'https://easedisease.in', API_PUBLIC_URL: 'https://api.easedisease.in' };
      expect(() => envSchema.parse(deployed)).toThrow(/PAYU_KEY/);
      expect(() => envSchema.parse({ ...deployed, PAYU_KEY: 'k' })).toThrow(/PAYU_SALT/);
      expect(() => envSchema.parse({ ...deployed, PAYU_SALT: 's' })).toThrow(/PAYU_KEY/);
      expect(envSchema.parse({ ...deployed, PAYU_KEY: 'k', PAYU_SALT: 's' }).PAYU_KEY).toBe('k');
    });

    it('rejects empty credential strings', () => {
      expect(() => envSchema.parse({ ...validEnv, PAYU_KEY: '' })).toThrow();
    });

    it('rejects an unknown PAYU_ENV', () => {
      expect(() => envSchema.parse({ ...validEnv, PAYU_ENV: 'sandbox' })).toThrow();
    });

    it('only allows PAYU_ENV=live in production', () => {
      const creds = { PAYU_KEY: 'k', PAYU_SALT: 's', PAYU_ENV: 'live' };
      const frontend = { FRONTEND_BASE_URL: 'https://easedisease.in', API_PUBLIC_URL: 'https://api.easedisease.in' };
      expect(() => envSchema.parse({ ...validEnv, ...creds })).toThrow(/PAYU_ENV=live/);
      expect(() => envSchema.parse({ ...validEnv, ...creds, ...frontend, NODE_ENV: 'staging' })).toThrow(/PAYU_ENV=live/);
      expect(envSchema.parse({ ...validEnv, ...creds, ...frontend, NODE_ENV: 'production' }).PAYU_ENV).toBe('live');
    });
  });
});
