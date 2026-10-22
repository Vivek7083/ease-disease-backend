import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { configureTrustProxy } from '../src/common/http/trust-proxy.js';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter.js';
import { RequestIdMiddleware } from '../src/common/middleware/request-id.middleware.js';
import { SlidingWindowLimiter } from '../src/common/rate-limit/sliding-window-limiter.js';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { PAYU_SIGNAL_LIMITER } from '../src/payments/payments.controller.js';
import { PaymentsModule } from '../src/payments/payments.module.js';
import { PayuClient, PayuGatewayError, type PayuVerifyResult } from '../src/payments/payu/payu-client.js';
import { PayuCredentialsProvider } from '../src/payments/payu/payu-credentials.provider.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { setupSwaggerIfAllowed } from '../src/swagger.js';
import { AMOUNT_PAISE, CREDS, REFERENCE, TXNID, createCheckoutFixture, signedPayload, snapshot } from './helpers/payu-fixtures.js';
import { createTestPrisma, truncateAll } from './helpers/test-db.js';

/**
 * P5b: PayU's callback and webhook over real HTTP (supertest), with the real payment handler and the real
 * `_test` Postgres. Only PayU itself is faked. Credentials are fake.
 */
const FRONTEND = 'https://easedisease.in';
const CALLBACK = '/v1/payments/payu/callback';
const WEBHOOK = '/v1/payments/payu/webhook';
const LOCAL = /^(::1|::ffff:127\.0\.0\.1|127\.0\.0\.1)$/;

describe('PayU callback and webhook over HTTP', () => {
  let prisma: PrismaClient;
  let app: NestExpressApplication;
  let payu: { verifyPayment: ReturnType<typeof vi.fn> };
  let clock: { now: number };

  const found = (overrides: Partial<Extract<PayuVerifyResult, { outcome: 'found' }>> = {}): PayuVerifyResult => ({
    outcome: 'found',
    txnid: TXNID,
    status: 'success',
    rawStatus: 'success',
    unmappedStatus: 'captured',
    amountPaise: AMOUNT_PAISE,
    mihpayid: '21564143078',
    mode: 'UPI',
    bankRefNum: '431998369241',
    errorCode: 'E000',
    errorMessage: 'NO ERROR',
    ...overrides,
  });

  async function createApp(options: { hops?: number; limit?: number; swagger?: boolean } = {}): Promise<void> {
    const values: Record<string, unknown> = { NODE_ENV: options.swagger ? 'development' : 'test', FRONTEND_BASE_URL: FRONTEND };
    @Global()
    @Module({
      providers: [
        { provide: ConfigService, useValue: { get: (name: string) => values[name] } },
        { provide: PrismaService, useValue: prisma },
      ],
      exports: [ConfigService, PrismaService],
    })
    class FakeInfraModule {}

    const moduleRef = await Test.createTestingModule({ imports: [FakeInfraModule, PaymentsModule] })
      .overrideProvider(PayuClient)
      .useValue(payu)
      .overrideProvider(PayuCredentialsProvider)
      .useValue({ get: () => CREDS, status: () => ({ source: 'env', env: 'test', keyHint: '***' }) })
      .overrideProvider(PAYU_SIGNAL_LIMITER)
      .useValue(new SlidingWindowLimiter(options.limit ?? 120, 60_000, () => clock.now))
      .compile();

    app = moduleRef.createNestApplication<NestExpressApplication>();
    const requestId = new RequestIdMiddleware();
    app.use((req: never, res: never, next: never) => requestId.use(req, res, next));
    configureTrustProxy(app, options.hops ?? 0);
    app.useGlobalFilters(new AllExceptionsFilter());
    if (options.swagger) setupSwaggerIfAllowed(app, 'development');
    await app.init();
  }

  beforeAll(() => {
    prisma = createTestPrisma();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await truncateAll(prisma);
    clock = { now: 1_000_000 };
    payu = { verifyPayment: vi.fn().mockResolvedValue(found()) };
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await app?.close();
  });

  const post = (path: string, payload: Record<string, unknown> | string, headers: Record<string, string> = {}) => {
    const req = request(app.getHttpServer()).post(path);
    for (const [name, value] of Object.entries(headers)) req.set(name, value);
    return typeof payload === 'string' ? req.send(payload) : req.type('form').send(payload as never);
  };
  const events = () => prisma.paymentEvent.findMany({ orderBy: { receivedAt: 'asc' } });
  const booking = () => prisma.booking.findFirstOrThrow();

  describe('callback (the browser return)', () => {
    beforeEach(() => createApp());

    it('success: 303 to the booking page, booking confirmed, event stored with source and IP', async () => {
      await createCheckoutFixture(prisma);

      const res = await post(CALLBACK, signedPayload()).expect(303);

      expect(res.headers['location']).toBe(`${FRONTEND}/booking/${REFERENCE}`);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect((await booking()).status).toBe('CONFIRMED');
      const [event] = await events();
      expect(event).toMatchObject({ source: 'RETURN', hashValid: true });
      expect(event!.sourceIp).toMatch(LOCAL);
      expect(event!.verification).toMatchObject({ result: 'applied' });
    });

    it('accepts a JSON body as well as a form', async () => {
      await createCheckoutFixture(prisma);
      const res = await request(app.getHttpServer()).post(CALLBACK).send(signedPayload()).expect(303);
      expect(res.headers['location']).toBe(`${FRONTEND}/booking/${REFERENCE}`);
      expect((await booking()).status).toBe('CONFIRMED');
    });

    it('failed payment: 303 to the same page, booking FAILED', async () => {
      await createCheckoutFixture(prisma);
      payu.verifyPayment.mockResolvedValue(found({ status: 'failure', rawStatus: 'failure' }));
      const res = await post(CALLBACK, signedPayload({ status: 'failure' })).expect(303);
      expect(res.headers['location']).toBe(`${FRONTEND}/booking/${REFERENCE}`);
      expect((await booking()).status).toBe('FAILED');
    });

    it('tampered hash: 303 with ?e=verify, nothing changes, PayU is not asked, the event is kept', async () => {
      await createCheckoutFixture(prisma);
      const before = await snapshot(prisma);

      const res = await post(CALLBACK, { ...signedPayload(), amount: '1.00' }).expect(303);

      expect(res.headers['location']).toBe(`${FRONTEND}/booking/${REFERENCE}?e=verify`);
      expect(await snapshot(prisma)).toEqual(before);
      expect(payu.verifyPayment).not.toHaveBeenCalled();
      expect((await events())[0]).toMatchObject({ hashValid: false, source: 'RETURN' });
    });

    it('PayU unreachable: still a 303 to the booking page (the page polls; the webhook settles it)', async () => {
      await createCheckoutFixture(prisma);
      payu.verifyPayment.mockRejectedValue(new PayuGatewayError('timeout'));
      const res = await post(CALLBACK, signedPayload()).expect(303);
      expect(res.headers['location']).toBe(`${FRONTEND}/booking/${REFERENCE}`);
      expect((await booking()).status).toBe('PENDING_PAYMENT');
    });

    it.each([
      ['an unknown txnid', () => post(CALLBACK, signedPayload({ txnid: 'EDTX01JBUNKNOWNTXN00001' }))],
      ['a garbage form', () => post(CALLBACK, { foo: 'bar' })],
      ['an empty body', () => request(app.getHttpServer()).post(CALLBACK)],
      ['a JSON array', () => request(app.getHttpServer()).post(CALLBACK).send([1, 2, 3])],
      ['plain text', () => request(app.getHttpServer()).post(CALLBACK).type('text/plain').send('txnid=EDTX01')],
    ])('%s: always a 303 to the bookings list, never a 4xx/5xx', async (_name, send) => {
      await createCheckoutFixture(prisma);
      const before = await snapshot(prisma);

      const res = await send().expect(303);

      expect(res.headers['location']).toBe(`${FRONTEND}/bookings?e=verify`);
      expect(await snapshot(prisma)).toEqual(before);
    });

    it.each([
      ['a protocol-relative URL', { udf1: '//evil.com', txnid: '//evil.com' }],
      ['an absolute URL', { udf1: 'https://evil.com/x', txnid: 'https://evil.com/x' }],
      ['CRLF header injection', { udf1: 'ED-1\r\nSet-Cookie: pwned=1', txnid: 'EDTX\r\nX-Evil: 1' }],
      ['a javascript: URL', { udf1: 'javascript:alert(1)', txnid: 'javascript:alert(1)' }],
      ['path traversal', { udf1: '../../admin', txnid: '../../admin' }],
    ])('cannot be steered by %s in the payload (no open redirect)', async (_name, fields) => {
      await createCheckoutFixture(prisma);

      const res = await post(CALLBACK, { ...signedPayload(), ...fields }).expect(303);

      const location = String(res.headers['location']);
      expect(location).toBe(`${FRONTEND}/bookings?e=verify`);
      expect(res.headers['set-cookie']).toBeUndefined();
      expect(res.headers['x-evil']).toBeUndefined();
    });

    it('takes the reference from our database even when the payload carries another (validly signed) one', async () => {
      await createCheckoutFixture(prisma);
      const res = await post(CALLBACK, signedPayload({ udf1: 'ED-ATTACK' })).expect(303);
      expect(res.headers['location']).toBe(`${FRONTEND}/booking/${REFERENCE}?e=verify`);
    });

    it('our own failure (database error): 303 to ?e=server, never an error page or a stack trace', async () => {
      await createCheckoutFixture(prisma);
      vi.spyOn(prisma.paymentEvent, 'create').mockRejectedValue(new Error('connection terminated'));

      const res = await post(CALLBACK, signedPayload()).expect(303);

      expect(res.headers['location']).toBe(`${FRONTEND}/bookings?e=server`);
      expect(res.text).not.toContain('connection terminated');
      expect((await booking()).status).toBe('PENDING_PAYMENT');
    });

    it('SQL-injection payloads over HTTP: stored as data, every table intact', async () => {
      await createCheckoutFixture(prisma);
      const before = await snapshot(prisma);
      const sql = "'; DROP TABLE transactions; --";

      await post(CALLBACK, { txnid: sql, status: sql, amount: sql, udf1: sql, hash: sql, [sql]: sql }).expect(303);
      await post(WEBHOOK, { txnid: sql, status: "' OR '1'='1", hash: sql }).expect(200);

      expect(await snapshot(prisma)).toEqual(before);
      expect(await prisma.paymentEvent.count()).toBe(2);
      expect(await prisma.$queryRaw`SELECT to_regclass('public.transactions')::text AS t`).toEqual([{ t: 'transactions' }]);
    });

    it('a malformed JSON body is refused by the body parser before the controller (400 envelope)', async () => {
      const res = await request(app.getHttpServer()).post(CALLBACK).type('json').send('{"txnid": ').expect(400);
      expect(res.body.error).toMatchObject({ code: 'VALIDATION_FAILED', requestId: expect.any(String) });
      expect(await prisma.paymentEvent.count()).toBe(0);
    });
  });

  describe('webhook (server to server)', () => {
    beforeEach(() => createApp());

    it('valid: 200 {ok:true}, booking confirmed, event stored with source WEBHOOK', async () => {
      await createCheckoutFixture(prisma);
      const res = await post(WEBHOOK, signedPayload()).expect(200);
      expect(res.body).toEqual({ ok: true });
      expect((await booking()).status).toBe('CONFIRMED');
      expect((await events())[0]).toMatchObject({ source: 'WEBHOOK', hashValid: true });
    });

    it('the same webhook again: 200 and nothing changes', async () => {
      await createCheckoutFixture(prisma);
      await post(WEBHOOK, signedPayload()).expect(200);
      const first = await snapshot(prisma);
      const res = await post(WEBHOOK, signedPayload()).expect(200);
      expect(res.body).toEqual({ ok: true });
      expect(await snapshot(prisma)).toEqual(first);
      expect(await prisma.paymentEvent.count()).toBe(2);
    });

    it.each([
      ['a bad hash', () => ({ ...signedPayload(), hash: 'f'.repeat(128) })],
      ['an unknown txnid', () => signedPayload({ txnid: 'EDTX01JBUNKNOWNTXN00001' })],
      ['a different booking reference', () => signedPayload({ udf1: 'ED-OTHER1' })],
    ])('%s: still 200 {ok:true}, nothing changes', async (_name, payload) => {
      await createCheckoutFixture(prisma);
      const before = await snapshot(prisma);
      const res = await post(WEBHOOK, payload()).expect(200);
      expect(res.body).toEqual({ ok: true });
      expect(await snapshot(prisma)).toEqual(before);
      expect(await prisma.paymentEvent.count()).toBe(1);
    });

    it('PayU unreachable: 200 (by decision), transaction stays INITIATED for the reconcile tick', async () => {
      await createCheckoutFixture(prisma);
      payu.verifyPayment.mockRejectedValue(new PayuGatewayError('HTTP 503'));
      await post(WEBHOOK, signedPayload()).expect(200);
      expect((await prisma.transaction.findFirstOrThrow()).status).toBe('INITIATED');
      expect((await events())[0]!.verification).toMatchObject({ result: 'gateway_error' });
    });

    it('our own failure (database error): 500 with the standard envelope, so PayU retries', async () => {
      await createCheckoutFixture(prisma);
      vi.spyOn(prisma.paymentEvent, 'create').mockRejectedValue(new Error('connection terminated'));

      const res = await post(WEBHOOK, signedPayload()).expect(500);

      expect(res.body.error).toMatchObject({ code: 'INTERNAL', requestId: expect.any(String) });
      expect(JSON.stringify(res.body)).not.toContain('connection terminated');
    });

    it('an unsupported content type is answered 200 and logged as an event with an empty body', async () => {
      await createCheckoutFixture(prisma);
      await request(app.getHttpServer()).post(WEBHOOK).type('text/plain').send('txnid=EDTX01JBTESTTXN000000001').expect(200);
      expect(await prisma.paymentEvent.count()).toBe(1);
      expect((await booking()).status).toBe('PENDING_PAYMENT');
    });

    it('accepts JSON as well as a form', async () => {
      await createCheckoutFixture(prisma);
      await request(app.getHttpServer()).post(WEBHOOK).send(signedPayload()).expect(200);
      expect((await booking()).status).toBe('CONFIRMED');
    });
  });

  describe('callback and webhook for the same payment at the same time', () => {
    beforeEach(() => createApp());

    it('exactly one confirmation, two alerts, and every signal logged', async () => {
      await createCheckoutFixture(prisma);

      const responses = await Promise.all(
        Array.from({ length: 8 }, (_, i) => (i % 2 === 0 ? post(CALLBACK, signedPayload()) : post(WEBHOOK, signedPayload()))),
      );

      expect(responses.map((r) => r.status).sort((a, b) => a - b)).toEqual([200, 200, 200, 200, 303, 303, 303, 303]);
      expect((await booking()).status).toBe('CONFIRMED');
      expect(await prisma.outbox.count()).toBe(2);
      const all = await events();
      expect(all).toHaveLength(8);
      expect(all.filter((e) => e.source === 'RETURN')).toHaveLength(4);
      expect(all.filter((e) => e.source === 'WEBHOOK')).toHaveLength(4);
      expect(all.every((e) => e.verification !== null)).toBe(true);
    });
  });

  describe('client IP', () => {
    it('with 0 trusted hops, a forged X-Forwarded-For is ignored: the socket address is stored', async () => {
      await createApp({ hops: 0 });
      await createCheckoutFixture(prisma);
      await post(WEBHOOK, signedPayload(), { 'X-Forwarded-For': '6.6.6.6' }).expect(200);
      expect((await events())[0]!.sourceIp).toMatch(LOCAL);
    });

    it('with 1 trusted hop, the address the proxy saw is stored, not what the client prepended', async () => {
      await createApp({ hops: 1 });
      await createCheckoutFixture(prisma);
      await post(CALLBACK, signedPayload(), { 'X-Forwarded-For': '6.6.6.6, 203.0.113.7' }).expect(303);
      expect((await events())[0]!.sourceIp).toBe('203.0.113.7');
    });

    it('stores an IPv6 client address exactly', async () => {
      await createApp({ hops: 1 });
      await createCheckoutFixture(prisma);
      await post(WEBHOOK, signedPayload(), { 'X-Forwarded-For': '2001:db8::8a2e:370:7334' }).expect(200);
      expect((await events())[0]!.sourceIp).toBe('2001:db8::8a2e:370:7334');
    });
  });

  describe('rate limit (per client IP)', () => {
    beforeEach(() => createApp({ hops: 1, limit: 3 }));
    const from = (ip: string) => ({ 'X-Forwarded-For': ip });

    it('webhook: the 4th request in a minute is a 429 envelope with Retry-After, and is not processed', async () => {
      await createCheckoutFixture(prisma);
      for (let i = 0; i < 3; i++) await post(WEBHOOK, signedPayload(), from('203.0.113.7')).expect(200);

      const res = await post(WEBHOOK, signedPayload(), from('203.0.113.7')).expect(429);

      expect(res.body.error).toMatchObject({ code: 'RATE_LIMITED', details: { retryAfterSeconds: 60 }, requestId: expect.any(String) });
      expect(res.headers['retry-after']).toBe('60');
      expect(await prisma.paymentEvent.count()).toBe(3); // the limited request stored nothing
    });

    it('callback: a limited request is a 303 to ?e=busy, not a bare 429 page, and is not processed', async () => {
      await createCheckoutFixture(prisma);
      for (let i = 0; i < 3; i++) await post(CALLBACK, signedPayload(), from('203.0.113.7')).expect(303);

      const res = await post(CALLBACK, signedPayload(), from('203.0.113.7')).expect(303);

      expect(res.headers['location']).toBe(`${FRONTEND}/bookings?e=busy`);
      expect(await prisma.paymentEvent.count()).toBe(3);
    });

    it('callback and webhook share one budget per IP', async () => {
      await createCheckoutFixture(prisma);
      await post(CALLBACK, signedPayload(), from('203.0.113.7')).expect(303);
      await post(WEBHOOK, signedPayload(), from('203.0.113.7')).expect(200);
      await post(CALLBACK, signedPayload(), from('203.0.113.7')).expect(303);
      await post(WEBHOOK, signedPayload(), from('203.0.113.7')).expect(429);
    });

    it('another IP is unaffected', async () => {
      await createCheckoutFixture(prisma);
      for (let i = 0; i < 4; i++) await post(WEBHOOK, signedPayload(), from('203.0.113.7'));
      await post(WEBHOOK, signedPayload(), from('198.51.100.9')).expect(200);
    });

    it('recovers after the window passes', async () => {
      await createCheckoutFixture(prisma);
      for (let i = 0; i < 3; i++) await post(WEBHOOK, signedPayload(), from('203.0.113.7')).expect(200);
      await post(WEBHOOK, signedPayload(), from('203.0.113.7')).expect(429);
      clock.now += 60_001;
      await post(WEBHOOK, signedPayload(), from('203.0.113.7')).expect(200);
    });

    it('a forged X-Forwarded-For prefix does not buy extra budget', async () => {
      await createCheckoutFixture(prisma);
      for (let i = 0; i < 3; i++) await post(WEBHOOK, signedPayload(), from(`10.0.0.${i}, 203.0.113.7`)).expect(200);
      await post(WEBHOOK, signedPayload(), from('10.9.9.9, 203.0.113.7')).expect(429);
    });
  });

  describe('API documentation (development only)', () => {
    it('lists both endpoints in Swagger, with no secret fields', async () => {
      await createApp({ swagger: true });
      const doc = (await request(app.getHttpServer()).get('/docs-json').expect(200)).body;
      expect(Object.keys(doc.paths)).toEqual(expect.arrayContaining([CALLBACK, WEBHOOK]));
      for (const route of [CALLBACK, WEBHOOK]) {
        const body = doc.paths[route].post.requestBody.content;
        expect(Object.keys(body)).toEqual(expect.arrayContaining(['application/x-www-form-urlencoded', 'application/json']));
        const fields = Object.keys(body['application/json'].schema.properties);
        expect(fields).toEqual(expect.arrayContaining(['txnid', 'status', 'amount', 'udf1', 'hash']));
        expect(fields).not.toContain('salt');
        expect(fields).not.toContain('key');
      }
    });
  });
});
