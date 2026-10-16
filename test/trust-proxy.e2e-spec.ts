import { Controller, Get, Req } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { Request } from 'express';
import request from 'supertest';
import { configureTrustProxy } from '../src/common/http/trust-proxy.js';

@Controller('whoami')
class WhoAmIController {
  @Get()
  whoami(@Req() req: Request): { ip: string | undefined } {
    return { ip: req.ip };
  }
}

/**
 * `req.ip` is what P5 stores as `source_ip` and what the rate limiter keys on. These tests pin down how
 * Express resolves it for each TRUST_PROXY_HOPS value, with real forged headers.
 */
describe('trust proxy configuration (real Express)', () => {
  const ipFor = async (hops: number, headers: Record<string, string> = {}): Promise<string | undefined> => {
    const moduleRef = await Test.createTestingModule({ controllers: [WhoAmIController] }).compile();
    const app = moduleRef.createNestApplication<NestExpressApplication>();
    configureTrustProxy(app, hops);
    await app.init();
    try {
      let req = request(app.getHttpServer()).get('/whoami');
      for (const [name, value] of Object.entries(headers)) req = req.set(name, value);
      return (await req.expect(200)).body.ip;
    } finally {
      await app.close();
    }
  };

  const LOCAL = /^(::1|::ffff:127\.0\.0\.1|127\.0\.0\.1)$/;

  it('with 0 hops, uses the socket address and ignores a forged X-Forwarded-For entirely', async () => {
    expect(await ipFor(0)).toMatch(LOCAL);
    expect(await ipFor(0, { 'X-Forwarded-For': '6.6.6.6' })).toMatch(LOCAL);
    expect(await ipFor(0, { 'X-Forwarded-For': '6.6.6.6, 7.7.7.7', Forwarded: 'for=8.8.8.8' })).toMatch(LOCAL);
  });

  it('with 1 hop, takes the address the single trusted proxy saw (the rightmost entry), not what the client prepended', async () => {
    expect(await ipFor(1, { 'X-Forwarded-For': '203.0.113.7' })).toBe('203.0.113.7');
    expect(await ipFor(1, { 'X-Forwarded-For': '6.6.6.6, 203.0.113.7' })).toBe('203.0.113.7');
    expect(await ipFor(1, { 'X-Forwarded-For': '6.6.6.6, 7.7.7.7, 203.0.113.7' })).toBe('203.0.113.7');
  });

  it('with 1 hop and no header, falls back to the socket address', async () => {
    expect(await ipFor(1)).toMatch(LOCAL);
  });

  it('with 2 hops, goes one entry further left', async () => {
    expect(await ipFor(2, { 'X-Forwarded-For': '6.6.6.6, 198.51.100.9, 203.0.113.7' })).toBe('198.51.100.9');
  });

  it('keeps IPv6 and IPv4-mapped IPv6 addresses as received', async () => {
    expect(await ipFor(1, { 'X-Forwarded-For': '2001:db8::8a2e:370:7334' })).toBe('2001:db8::8a2e:370:7334');
    expect(await ipFor(1, { 'X-Forwarded-For': '::ffff:203.0.113.7' })).toBe('::ffff:203.0.113.7');
  });
});
