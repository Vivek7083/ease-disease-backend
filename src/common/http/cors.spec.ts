import { describe, expect, it } from 'vitest';
import { corsOptions } from './cors.js';

type OriginFn = (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => void;

function allows(settings: Parameters<typeof corsOptions>[0], origin: string | undefined): boolean | undefined {
  let result: boolean | undefined;
  (corsOptions(settings).origin as OriginFn)(origin, (_err, allow) => {
    result = allow;
  });
  return result;
}

describe('corsOptions', () => {
  const deployed = { nodeEnv: 'production', frontendBaseUrl: 'https://easedisease.in', extraOrigins: ['https://preview.easedisease.in'] };

  it('allows the frontend origin and the extra origins, nothing else', () => {
    expect(allows(deployed, 'https://easedisease.in')).toBe(true);
    expect(allows(deployed, 'https://preview.easedisease.in')).toBe(true);
    expect(allows(deployed, 'https://evil.example')).toBe(false);
    expect(allows(deployed, 'https://easedisease.in.evil.example')).toBe(false);
    expect(allows(deployed, 'http://easedisease.in')).toBe(false);
    expect(allows(deployed, undefined)).toBe(false);
  });

  it('trusts localhost:4200 only in development', () => {
    expect(allows({ nodeEnv: 'development' }, 'http://localhost:4200')).toBe(true);
    expect(allows({ nodeEnv: 'development' }, 'http://localhost:9999')).toBe(false);
    expect(allows(deployed, 'http://localhost:4200')).toBe(false);
    expect(allows({ nodeEnv: 'test' }, 'http://localhost:4200')).toBe(false);
  });

  it('lists the headers our routes use and sends no cookies', () => {
    const options = corsOptions(deployed);
    expect(options.allowedHeaders).toEqual(['Authorization', 'Content-Type', 'Idempotency-Key', 'X-Firebase-AppCheck']);
    expect(options.exposedHeaders).toEqual(['Retry-After', 'Idempotent-Replayed', 'X-Request-Id']);
    expect(options.methods).toEqual(['GET', 'POST', 'OPTIONS']);
    expect(options.credentials).toBe(false);
  });
});
