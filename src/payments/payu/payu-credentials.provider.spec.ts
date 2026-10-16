import type { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import { AppException } from '../../common/exceptions/app.exception.js';
import type { Env } from '../../config/env.schema.js';
import { PayuCredentialsProvider } from './payu-credentials.provider.js';

const provider = (values: Partial<Record<keyof Env, unknown>>) =>
  new PayuCredentialsProvider({ get: (name: keyof Env) => values[name] } as unknown as ConfigService<Env, true>);

const dev = { NODE_ENV: 'development' };
const envCreds = { PAYU_KEY: 'env_key_1234', PAYU_SALT: 'env_salt', PAYU_ENV: 'test' };
const memoryCreds = { key: 'mem_key_5678', salt: 'mem_salt', env: 'test' as const };

describe('PayuCredentialsProvider', () => {
  it('falls back to the env vars', () => {
    const p = provider({ ...dev, ...envCreds });
    expect(p.get()).toEqual({ key: 'env_key_1234', salt: 'env_salt', env: 'test' });
    expect(p.status()).toEqual({ source: 'env', env: 'test', keyHint: '…1234' });
  });

  it('defaults the env to test when PAYU_ENV is absent', () => {
    expect(provider({ ...dev, PAYU_KEY: 'k', PAYU_SALT: 's' }).get().env).toBe('test');
  });

  it('throws PAYMENT_GATEWAY_UNAVAILABLE (503) when nothing is configured', () => {
    const p = provider(dev);
    expect(() => p.get()).toThrow(AppException);
    expect(() => p.get()).toThrow(expect.objectContaining({ code: 'PAYMENT_GATEWAY_UNAVAILABLE' }));
    expect(p.status()).toEqual({ source: 'none', env: null, keyHint: null });
  });

  it('treats a key without a salt (or the reverse) as not configured', () => {
    expect(provider({ ...dev, PAYU_KEY: 'k' }).status().source).toBe('none');
    expect(provider({ ...dev, PAYU_SALT: 's' }).status().source).toBe('none');
  });

  describe('in development', () => {
    it('prefers in-memory credentials over env vars', () => {
      const p = provider({ ...dev, ...envCreds });
      p.setOverride(memoryCreds);
      expect(p.get()).toEqual(memoryCreds);
      expect(p.status()).toEqual({ source: 'memory', env: 'test', keyHint: '…5678' });
    });

    it('works with no env vars at all', () => {
      const p = provider(dev);
      p.setOverride(memoryCreds);
      expect(p.get()).toEqual(memoryCreds);
    });

    it('clearing falls back to the env vars', () => {
      const p = provider({ ...dev, ...envCreds });
      p.setOverride(memoryCreds);
      p.clearOverride();
      expect(p.status().source).toBe('env');
    });

    it('does not expose the salt in status and hides short keys', () => {
      const p = provider(dev);
      p.setOverride({ key: 'short', salt: 'super_secret_salt', env: 'live' });
      const status = p.status();
      expect(JSON.stringify(status)).not.toContain('super_secret_salt');
      expect(status.keyHint).toBe('***');
    });

    it('keeps its own copy, so mutating the input later has no effect', () => {
      const p = provider(dev);
      const input = { ...memoryCreds };
      p.setOverride(input);
      input.salt = 'changed';
      expect(p.get().salt).toBe('mem_salt');
    });
  });

  describe.each(['production', 'staging', 'test'])('in %s', (nodeEnv) => {
    it('refuses to store in-memory credentials', () => {
      const p = provider({ NODE_ENV: nodeEnv, ...envCreds });
      expect(() => p.setOverride(memoryCreds)).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
      expect(p.get().key).toBe('env_key_1234');
    });
  });
});
