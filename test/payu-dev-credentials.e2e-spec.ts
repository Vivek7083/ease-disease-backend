import { INestApplication, Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter.js';
import { PayuClient } from '../src/payments/payu/payu-client.js';
import { PayuModule } from '../src/payments/payu/payu.module.js';

/**
 * Mounts only PayuModule with a fake ConfigService, so we can exercise development vs production
 * without a database and without touching process.env. Credentials here are fake.
 */
async function createApp(values: Record<string, unknown>): Promise<INestApplication<App>> {
  @Global()
  @Module({
    providers: [{ provide: ConfigService, useValue: { get: (name: string) => values[name] } }],
    exports: [ConfigService],
  })
  class FakeConfigModule {}

  const moduleRef = await Test.createTestingModule({ imports: [FakeConfigModule, PayuModule] }).compile();
  const app = moduleRef.createNestApplication<INestApplication<App>>();
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  return app;
}

const URL = '/dev/payu/credentials';
const good = { key: 'test_key_abcd', salt: 'very_secret_salt', env: 'test' };

describe('dev PayU credentials endpoint (development)', () => {
  let app: INestApplication<App>;
  beforeEach(async () => {
    app = await createApp({ NODE_ENV: 'development' });
  });
  afterEach(async () => {
    await app.close();
  });

  it('starts with nothing configured', async () => {
    const res = await request(app.getHttpServer()).get(URL).expect(200);
    expect(res.body).toEqual({ source: 'none', env: null, keyHint: null });
  });

  it('loads test credentials and reports status without the salt', async () => {
    const put = await request(app.getHttpServer()).put(URL).send(good).expect(200);
    expect(put.body).toEqual({ source: 'memory', env: 'test', keyHint: '…abcd' });
    expect(JSON.stringify(put.body)).not.toContain('very_secret_salt');

    const get = await request(app.getHttpServer()).get(URL).expect(200);
    expect(get.body).toEqual(put.body);
  });

  it('is wired into the shared PayuClient: its requests use the credentials loaded over HTTP', async () => {
    const client = app.get(PayuClient);
    // Before loading, the client fails closed because nothing is configured.
    await expect(client.verifyPayment('EDTX01JBTESTTXN000000001')).rejects.toMatchObject({
      code: 'PAYMENT_GATEWAY_UNAVAILABLE',
    });

    await request(app.getHttpServer()).put(URL).send(good).expect(200);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 500 }));
    try {
      await client.verifyPayment('EDTX01JBTESTTXN000000001').catch(() => undefined);
      const [url, init] = fetchSpy.mock.calls[0] as [string, { body: string }];
      expect(url).toContain('test.payu.in');
      expect(new URLSearchParams(init.body).get('key')).toBe('test_key_abcd');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('clears credentials on DELETE', async () => {
    await request(app.getHttpServer()).put(URL).send(good).expect(200);
    const res = await request(app.getHttpServer()).delete(URL).expect(200);
    expect(res.body.source).toBe('none');
  });

  it('refuses live credentials without confirmLive and stores nothing', async () => {
    const res = await request(app.getHttpServer()).put(URL).send({ ...good, env: 'live' }).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.error.details.fields).toHaveProperty('confirmLive');
    const status = await request(app.getHttpServer()).get(URL).expect(200);
    expect(status.body.source).toBe('none');
  });

  it('accepts live credentials with confirmLive: true', async () => {
    const res = await request(app.getHttpServer()).put(URL).send({ ...good, env: 'live', confirmLive: true }).expect(200);
    expect(res.body).toMatchObject({ source: 'memory', env: 'live' });
  });

  it.each([
    ['missing salt', { key: 'k', env: 'test' }],
    ['empty key', { ...good, key: '  ' }],
    ['unknown env', { ...good, env: 'sandbox' }],
    ['non-string salt', { ...good, salt: 123 }],
    ['not an object', 'nope'],
  ])('rejects %s with the VALIDATION_FAILED envelope and never echoes values', async (_name, body) => {
    const res = await request(app.getHttpServer()).put(URL).send(body as object).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.error.requestId).toEqual(expect.any(String));
    expect(JSON.stringify(res.body)).not.toContain('very_secret_salt');
  });
});

describe.each(['production', 'staging', 'test'])('dev PayU credentials endpoint (%s)', (nodeEnv) => {
  let app: INestApplication<App>;
  beforeEach(async () => {
    app = await createApp({ NODE_ENV: nodeEnv, PAYU_KEY: 'env_key_1234', PAYU_SALT: 'env_salt', PAYU_ENV: 'test' });
  });
  afterEach(async () => {
    await app.close();
  });

  it('returns 404 for every method and stores nothing', async () => {
    for (const call of [
      () => request(app.getHttpServer()).get(URL),
      () => request(app.getHttpServer()).put(URL).send(good),
      () => request(app.getHttpServer()).delete(URL),
    ]) {
      const res = await call().expect(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    }
  });
});
