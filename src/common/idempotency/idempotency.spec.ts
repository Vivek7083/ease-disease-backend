import { describe, expect, it } from 'vitest';
import { AppException } from '../exceptions/app.exception.js';
import { hashRequest, parseIdempotencyKey } from './idempotency.js';

const KEY = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';

describe('parseIdempotencyKey', () => {
  it('accepts a uuid v4 and returns it lower-case', () => {
    expect(parseIdempotencyKey(KEY)).toBe(KEY);
    expect(parseIdempotencyKey(` ${KEY.toUpperCase()} `)).toBe(KEY);
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['blank', '   '],
    ['not a uuid', 'abc'],
    ['a v1 uuid', 'c232ab00-9414-11ec-b3c8-9f6bdeced846'],
    ['a v7 uuid', '018f3c1a-7b2e-7d3a-8f1a-0e02b2c3d479'],
    ['a bad variant', 'f47ac10b-58cc-4372-c567-0e02b2c3d479'],
    ['two keys', `${KEY}, ${KEY}`],
    ['a repeated header', [KEY, KEY]],
    ['a long string', 'a'.repeat(5000)],
  ])('refuses %s with VALIDATION_FAILED naming the header', (_label, header) => {
    try {
      parseIdempotencyKey(header as string | undefined);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AppException);
      expect((error as AppException).code).toBe('VALIDATION_FAILED');
      expect((error as AppException).getStatus()).toBe(400);
      expect((error as AppException).details).toEqual({ fields: { 'Idempotency-Key': expect.any(String) } });
    }
  });
});

describe('hashRequest', () => {
  it('is a lower-case sha-256 hex string', () => {
    expect(hashRequest({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });
  it('is stable for equal content and different for different content', () => {
    expect(hashRequest({ a: 1, b: 'x' })).toBe(hashRequest({ a: 1, b: 'x' }));
    expect(hashRequest({ a: 1, b: 'x' })).not.toBe(hashRequest({ a: 2, b: 'x' }));
    expect(hashRequest({ a: 1, b: null })).not.toBe(hashRequest({ a: 1, b: 'null' }));
  });
});
