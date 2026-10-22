import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { APP_CHECK_VERIFIER, AppCheckRejectedError } from '../src/auth/app-check-verifier.js';
import { IDENTITY_VERIFIER, IdentityRejectedError, IdentityUnavailableError, type VerifiedIdentity } from '../src/auth/identity-verifier.js';
import { AppException } from '../src/common/exceptions/app.exception.js';
import { BookingsModule } from '../src/bookings/bookings.module.js';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter.js';
import { configureTrustProxy } from '../src/common/http/trust-proxy.js';
import { RequestIdMiddleware } from '../src/common/middleware/request-id.middleware.js';
import {
  BOOKING_CREATE_RATE_LIMITER,
  CHECKOUT_LIMIT_PER_HOUR,
  CHECKOUT_RATE_LIMITER,
  CHECKOUT_WINDOW_MS,
  IP_LIMIT_PER_MINUTE,
  IP_RATE_LIMITER,
  RATE_LIMIT_WINDOW_MS,
} from '../src/common/rate-limit/rate-limit.guards.js';
import { SlidingWindowLimiter } from '../src/common/rate-limit/sliding-window-limiter.js';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { PAYU_SIGNAL_LIMITER } from '../src/payments/payments.controller.js';
import { PaymentsModule } from '../src/payments/payments.module.js';
import { PayuClient, type PayuVerifyResult } from '../src/payments/payu/payu-client.js';
import { PayuCredentialsProvider } from '../src/payments/payu/payu-credentials.provider.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { setupSwaggerIfAllowed } from '../src/swagger.js';
import { FakeAppCheckVerifier, SHAPED_APP_CHECK_TOKEN } from './helpers/app-check-kit.js';
import { FakeIdentityVerifier, IDENTITY, SHAPED_TOKEN } from './helpers/identity-kit.js';
import { CREDS, REFERENCE, createBookingFixture, createCheckoutFixture, signedPayload } from './helpers/payu-fixtures.js';
import { createTestPrisma, truncateAll } from './helpers/test-db.js';

const KEY_A = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const KEY_B = '0b9f8c1e-3d2a-4b6c-9e5f-7a1d2c3b4e5f';
const OTHER_REFERENCE = 'ED-OTHER001';

/**
 * B1c: POST /v1/bookings/{ref}/checkout over real HTTP on the real `_test` Postgres. Identity and App Check are scripted
 * fakes; PayU is a fake; the rate limiters are the REAL ones driven by a fake clock.
 */
describe('POST /v1/bookings/{reference}/checkout', () => {
  let prisma: PrismaClient;
  let app: NestExpressApplication;
  let now: number;
  let config: Record<string, unknown>;
  let payu: { verifyPayment: ReturnType<typeof vi.fn> };
  let credentialsGet: () => typeof CREDS;
  const identityVerifier = new FakeIdentityVerifier();
  const appCheckVerifier = new FakeAppCheckVerifier();

  async function createApp(trustProxyHops = 0) {
    await app?.close();
    @Global()
    @Module({
      providers: [
        { provide: ConfigService, useValue: { get: (name: string) => config[name] } },
        { provide: PrismaService, useValue: prisma },
      ],
      exports: [ConfigService, PrismaService],
    })
    class FakeInfraModule {}

    const moduleRef = await Test.createTestingModule({ imports: [FakeInfraModule, PaymentsModule, BookingsModule] })
      .overrideProvider(IDENTITY_VERIFIER)
      .useValue(identityVerifier)
      .overrideProvider(APP_CHECK_VERIFIER)
      .useValue(appCheckVerifier)
      .overrideProvider(PayuClient)
      .useValue(payu)
      .overrideProvider(PayuCredentialsProvider)
      .useValue({ get: () => credentialsGet(), status: () => ({ source: 'env', env: 'test', keyHint: '***' }) })
      .overrideProvider(PAYU_SIGNAL_LIMITER)
      .useValue(new SlidingWindowLimiter(1000, 60_000, () => now))
      .overrideProvider(IP_RATE_LIMITER)
      .useValue(new SlidingWindowLimiter(IP_LIMIT_PER_MINUTE, RATE_LIMIT_WINDOW_MS, () => now))
      .overrideProvider(BOOKING_CREATE_RATE_LIMITER)
      .useValue(new SlidingWindowLimiter(10, 3_600_000, () => now))
      .overrideProvider(CHECKOUT_RATE_LIMITER)
      .useValue(new SlidingWindowLimiter(CHECKOUT_LIMIT_PER_HOUR, CHECKOUT_WINDOW_MS, () => now))
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureTrustProxy(app, trustProxyHops);
    const requestId = new RequestIdMiddleware();
    app.use((req: never, res: never, next: never) => requestId.use(req, res, next));
    app.useGlobalFilters(new AllExceptionsFilter());
    setupSwaggerIfAllowed(app, 'development');
    await app.init();
    await app.listen(0, '127.0.0.1');
  }

  beforeAll(() => {
    prisma = createTestPrisma();
  });
  afterAll(async () => {
    await app?.close();
    await prisma.$disconnect();
  });

  const logSpies: ReturnType<typeof vi.spyOn>[] = [];
  beforeEach(async () => {
    await truncateAll(prisma);
    now = 1_000_000_000;
    config = {
      NODE_ENV: 'development',
      FIREBASE_PROJECT_ID: 'easedisease-test',
      APP_CHECK_MODE: 'enforce',
      API_PUBLIC_URL: 'https://api.easedisease.in',
      FRONTEND_BASE_URL: 'https://easedisease.in',
    };
    payu = { verifyPayment: vi.fn() };
    credentialsGet = () => CREDS;
    identityVerifier.calls.length = 0;
    identityVerifier.willReturn(IDENTITY);
    appCheckVerifier.calls.length = 0;
    appCheckVerifier.willReturn({ appId: 'app' });
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
      logSpies.push(vi.spyOn(Logger.prototype, level).mockImplementation(() => undefined));
    }
    await createApp();
  });
  afterEach(() => {
    for (const spy of logSpies.splice(0)) spy.mockRestore();
  });

  const pay = (reference: string = REFERENCE, key: string | null = KEY_A) => {
    const req = request(app.getHttpServer()).post(`/v1/bookings/${reference}/checkout`).set('X-Firebase-AppCheck', SHAPED_APP_CHECK_TOKEN).set('Authorization', `Bearer ${SHAPED_TOKEN}`);
    return key === null ? req : req.set('Idempotency-Key', key);
  };
  /** Signs in as the owner of a fixture booking. */
  const asOwnerOf = (firebaseUid: string, extra: Partial<VerifiedIdentity> = {}) => identityVerifier.willReturn({ ...IDENTITY, uid: firebaseUid, ...extra });
  const fixture = async (options: Parameters<typeof createBookingFixture>[1] = {}) => {
    const made = await createBookingFixture(prisma, options);
    asOwnerOf(made.user.firebaseUid);
    return made;
  };
  const counts = async () => ({ transactions: await prisma.transaction.count(), keys: await prisma.idempotencyKey.count() });
  const loggedText = () => logSpies.flatMap((spy) => spy.mock.calls).map((call) => call.map(String).join(' ')).join('\n');

  describe('paying for a booking', () => {
    it('answers 200 with exactly the form (no warnings, no salt) and creates one INITIATED transaction with the booking amount', async () => {
      const { booking } = await fixture();
      const res = await pay().expect(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['idempotent-replayed']).toBeUndefined();
      expect(Object.keys(res.body).sort()).toEqual(['fields', 'gatewayUrl', 'method']);
      expect(res.body).toMatchObject({
        gatewayUrl: 'https://test.payu.in/_payment',
        method: 'POST',
        fields: { key: 'test_key', amount: '2499.00', productinfo: 'One-Time Consult', firstname: 'Priya', email: 'priya@example.com', phone: '9876543210', udf1: REFERENCE },
      });
      expect(JSON.stringify(res.body)).not.toContain(CREDS.salt);
      const transactions = await prisma.transaction.findMany();
      expect(transactions).toHaveLength(1);
      expect(transactions[0]).toMatchObject({ status: 'INITIATED', bookingId: booking.id, amountPaise: booking.amountPaise, orderId: res.body.fields.txnid });
    });

    it('the same key again returns the identical form, flagged as a replay, and creates nothing more', async () => {
      await fixture();
      const first = await pay().expect(200);
      const second = await pay().expect(200);
      expect(second.body).toEqual(first.body);
      expect(second.headers['idempotent-replayed']).toBe('true');
      expect(await counts()).toEqual({ transactions: 1, keys: 1 });
    });

    it('a new key for the same booking reuses the same payment record and form', async () => {
      await fixture();
      const first = await pay(REFERENCE, KEY_A).expect(200);
      const second = await pay(REFERENCE, KEY_B).expect(200);
      expect(second.body).toEqual(first.body);
      expect(second.headers['idempotent-replayed']).toBeUndefined();
      expect(await counts()).toEqual({ transactions: 1, keys: 2 });
    });

    it('simultaneous requests end with one payment record and the same form, with one key or several', async () => {
      await fixture();
      // 5 + 5 requests stay inside the 10-an-hour budget.
      const sameKey = await Promise.all(Array.from({ length: 5 }, () => pay(REFERENCE, KEY_A)));
      expect(sameKey.map((r) => r.status)).toEqual(Array(5).fill(200));
      for (const r of sameKey) expect(r.body).toEqual(sameKey[0]!.body);
      const otherKeys = await Promise.all(Array.from({ length: 5 }, () => pay(REFERENCE, crypto.randomUUID())));
      expect(otherKeys.map((r) => r.status)).toEqual(Array(5).fill(200));
      for (const r of otherKeys) expect(r.body).toEqual(sameKey[0]!.body);
      expect((await counts()).transactions).toBe(1);
    });

    it('a booking made through POST /v1/bookings is paid for end to end, and a PayU success confirms it', async () => {
      const pkg = await prisma.package.create({ data: { title: 'One-Time Consult', description: ['x'], pricePaise: 249900 } });
      const created = await request(app.getHttpServer())
        .post('/v1/bookings')
        .set('X-Firebase-AppCheck', SHAPED_APP_CHECK_TOKEN)
        .set('Authorization', `Bearer ${SHAPED_TOKEN}`)
        .set('Idempotency-Key', KEY_B)
        .send({ packageId: pkg.id, name: 'Meera Nair', whatsappNumber: '+91 98765 43210', email: 'Meera@Example.com', age: 41, city: 'Kochi', consent: true })
        .expect(201);
      const { reference } = created.body.booking;

      const form = (await pay(reference, KEY_A).expect(200)).body;
      expect(form.fields).toMatchObject({ firstname: 'Meera', email: 'meera@example.com', phone: '9876543210', udf1: reference });

      const f = form.fields as Record<string, string>;
      payu.verifyPayment.mockResolvedValue({
        outcome: 'found', txnid: f['txnid'], status: 'success', rawStatus: 'success', unmappedStatus: 'captured',
        amountPaise: 249900, mihpayid: '21564143078', mode: 'UPI', bankRefNum: '431998369241', errorCode: 'E000', errorMessage: 'NO ERROR',
      } satisfies PayuVerifyResult);
      const callback = signedPayload({ txnid: f['txnid']!, amount: f['amount']!, productinfo: f['productinfo']!, firstname: f['firstname']!, email: f['email']!, udf1: reference });
      await request(app.getHttpServer()).post('/v1/payments/payu/callback').type('form').send(callback).expect(303);
      expect((await prisma.booking.findUniqueOrThrow({ where: { reference } })).status).toBe('CONFIRMED');
      expect((await prisma.transaction.findFirstOrThrow()).status).toBe('SUCCESS');

      // And now the same key is refused: the app must show the status page, never a dead payment form.
      const again = await pay(reference, KEY_A).expect(409);
      expect(again.body.error.code).toBe('BOOKING_NOT_PAYABLE');
    });

    it('a foreign WhatsApp number is paid with the configured fallback phone', async () => {
      config['PAYU_FALLBACK_PHONE'] = '9000011111';
      await fixture({ consulteeWhatsappNumber: '+14155552671' });
      expect((await pay().expect(200)).body.fields.phone).toBe('9000011111');
    });

    it('stores the sender address and user-agent on the new payment record, keeps them on reuse, and never returns them', async () => {
      await fixture();
      const first = await pay(REFERENCE, KEY_A).set('User-Agent', 'First/1').expect(200);
      const second = await pay(REFERENCE, KEY_B).set('User-Agent', 'Second/2').expect(200);
      const tx = await prisma.transaction.findFirstOrThrow();
      expect([tx.createdIp, tx.createdUserAgent]).toEqual(['127.0.0.1', 'First/1']);
      expect(JSON.stringify([first.body, second.body])).not.toMatch(/127\.0\.0\.1|First\/1|Second\/2/);
    });

    it('cuts a very long user-agent at 512 characters and stores a missing one as null', async () => {
      await fixture();
      await pay().set('User-Agent', 'u'.repeat(900)).expect(200);
      expect((await prisma.transaction.findFirstOrThrow()).createdUserAgent).toBe('u'.repeat(512));
      await truncateAll(prisma);
      await fixture();
      await pay().unset('User-Agent').expect(200);
      expect((await prisma.transaction.findFirstOrThrow()).createdUserAgent).toBeNull();
    });

    it('ignores a forged X-Forwarded-For when no proxy is trusted', async () => {
      await fixture();
      await pay().set('X-Forwarded-For', '198.51.100.9').expect(200);
      expect((await prisma.transaction.findFirstOrThrow()).createdIp).toBe('127.0.0.1');
    });
  });

  describe('who may pay, and for what', () => {
    it('another person\'s booking, an unknown reference, a malformed reference and a person with no account all get the identical 404', async () => {
      await fixture();
      await createBookingFixture(prisma, { reference: OTHER_REFERENCE });
      asOwnerOf('some-other-uid');
      const bodies: unknown[] = [];
      for (const reference of [OTHER_REFERENCE, 'ED-NOSUCH1', "' OR '1'='1", 'x'.repeat(40)]) {
        const res = await pay(reference).expect(404);
        expect(res.body.error.code).toBe('BOOKING_NOT_FOUND');
        bodies.push({ ...res.body.error, requestId: undefined });
      }
      for (const body of bodies) expect(body).toEqual(bodies[0]);
      // The caller above has no account row. A real account that does not own the booking behaves the same:
      const stranger = await prisma.user.create({ data: { firebaseUid: 'uid-stranger', email: 'x@example.com', authProvider: 'google.com', lastAuthProvider: 'google.com' } });
      asOwnerOf(stranger.firebaseUid);
      expect((await pay(REFERENCE).expect(404)).body.error.code).toBe('BOOKING_NOT_FOUND');
      expect(await counts()).toEqual({ transactions: 0, keys: 0 });
      expect(await prisma.user.count()).toBe(3); // no account was created by a payment route
    });

    it.each(['CONFIRMED', 'FAILED', 'CANCELLED', 'EXPIRED', 'COMPLETED', 'NEEDS_ATTENTION', 'NO_SHOW'] as const)('a %s booking is 409 BOOKING_NOT_PAYABLE and nothing is stored', async (bookingStatus) => {
      await fixture({ bookingStatus });
      const res = await pay().expect(409);
      expect(res.body.error).toMatchObject({ code: 'BOOKING_NOT_PAYABLE', details: { reason: 'BOOKING_STATUS', status: bookingStatus } });
      expect(await counts()).toEqual({ transactions: 0, keys: 0 });
    });

    it.each(['SUCCESS', 'FAILURE', 'CANCELLED', 'PENDING', 'EXPIRED'] as const)('a booking whose payment is already %s is 409 PAYMENT_ALREADY_STARTED and its record is untouched', async (transactionStatus) => {
      const { user } = await createCheckoutFixture(prisma, { transactionStatus });
      asOwnerOf(user.firebaseUid);
      const before = await prisma.transaction.findFirstOrThrow();
      const res = await pay().expect(409);
      expect(res.body.error).toMatchObject({ code: 'BOOKING_NOT_PAYABLE', details: { reason: 'PAYMENT_ALREADY_STARTED', status: transactionStatus } });
      expect(await prisma.transaction.findFirstOrThrow()).toEqual(before);
      expect((await counts()).keys).toBe(0);
    });

    it('a foreign number with no fallback is 409 PAYMENT_PHONE_UNSUPPORTED, writes nothing, and the same key works once a fallback exists', async () => {
      await fixture({ consulteeWhatsappNumber: '+14155552671' });
      const res = await pay().expect(409);
      expect(res.body.error.code).toBe('PAYMENT_PHONE_UNSUPPORTED');
      expect(await counts()).toEqual({ transactions: 0, keys: 0 });
      config['PAYU_FALLBACK_PHONE'] = '9000011111';
      await pay().expect(200);
    });

    it('payments not configured: 503 PAYMENT_GATEWAY_UNAVAILABLE, no payment record and no key left behind', async () => {
      await fixture();
      credentialsGet = () => {
        throw new AppException('PAYMENT_GATEWAY_UNAVAILABLE', 'Payment gateway is not configured', 503);
      };
      const res = await pay().expect(503);
      expect(res.body.error.code).toBe('PAYMENT_GATEWAY_UNAVAILABLE');
      expect(await counts()).toEqual({ transactions: 0, keys: 0 });
    });
  });

  describe('Idempotency-Key', () => {
    it.each([['missing', null], ['empty', ''], ['not a uuid', 'abc'], ['a v1 uuid', 'c232ab00-9414-11ec-b3c8-9f6bdeced846']])('%s: 400 naming the header, nothing written', async (_label, key) => {
      await fixture();
      const res = await pay(REFERENCE, key).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(res.body.error.details.fields).toHaveProperty(['Idempotency-Key']);
      expect(await counts()).toEqual({ transactions: 0, keys: 0 });
    });

    it('the same key for a different booking is 409 IDEMPOTENCY_CONFLICT and creates nothing for the second booking', async () => {
      const { user } = await fixture();
      await prisma.booking.create({
        data: { reference: OTHER_REFERENCE, userId: user.id, packageId: (await prisma.package.findFirstOrThrow()).id, packageTitle: 'One-Time Consult', amountPaise: 249900, consulteeName: 'Priya Sharma', consulteeWhatsappNumber: '+919876543210', consulteeEmail: 'priya@example.com', consulteeAge: 34, consulteeCity: 'Bengaluru', consentAt: new Date() },
      });
      await pay(REFERENCE, KEY_A).expect(200);
      const res = await pay(OTHER_REFERENCE, KEY_A).expect(409);
      expect(res.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
      expect((await counts()).transactions).toBe(1);
    });

    it('a key is scoped to the person: user B reusing user A\'s key makes their own payment', async () => {
      await fixture();
      await pay(REFERENCE, KEY_A).expect(200);
      const b = await createBookingFixture(prisma, { reference: OTHER_REFERENCE });
      asOwnerOf(b.user.firebaseUid);
      const res = await pay(OTHER_REFERENCE, KEY_A).expect(200);
      expect(res.headers['idempotent-replayed']).toBeUndefined();
      expect(await counts()).toEqual({ transactions: 2, keys: 2 });
    });

    it('after 24 hours the key is free again', async () => {
      await fixture();
      await pay().expect(200);
      await prisma.$executeRaw`UPDATE idempotency_keys SET created_at = now() - interval '24 hours 1 minute'`;
      const again = await pay().expect(200);
      expect(again.headers['idempotent-replayed']).toBeUndefined();
      expect(await counts()).toEqual({ transactions: 1, keys: 1 });
    });

    it('the payment record and its key commit together: a failure after the insert leaves neither', async () => {
      await fixture();
      await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION test_fail_key_update() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'forced failure after the transaction insert'; END $$ LANGUAGE plpgsql`);
      await prisma.$executeRawUnsafe('CREATE TRIGGER test_fail_key_update BEFORE UPDATE ON idempotency_keys FOR EACH ROW EXECUTE FUNCTION test_fail_key_update()');
      try {
        const res = await pay().expect(500);
        expect(res.body.error.code).toBe('INTERNAL');
        expect(await counts()).toEqual({ transactions: 0, keys: 0 });
      } finally {
        await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS test_fail_key_update ON idempotency_keys');
        await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS test_fail_key_update()');
      }
      await pay().expect(200);
    });
  });

  describe('guards', () => {
    it('no token, a bad token and an unverified email are refused before anything is written', async () => {
      await fixture();
      const bare = await request(app.getHttpServer()).post(`/v1/bookings/${REFERENCE}/checkout`).set('X-Firebase-AppCheck', SHAPED_APP_CHECK_TOKEN).set('Idempotency-Key', KEY_A);
      expect(bare.status).toBe(401);
      identityVerifier.willReturn(new IdentityRejectedError('revoked'));
      expect((await pay().expect(401)).body.error.code).toBe('UNAUTHENTICATED');
      identityVerifier.willReturn({ ...IDENTITY, emailVerified: false });
      expect((await pay().expect(403)).body.error.code).toBe('EMAIL_NOT_VERIFIED');
      expect(await counts()).toEqual({ transactions: 0, keys: 0 });
    });

    it('a missing or rejected App Check token is 403 and the login token is not even checked', async () => {
      await fixture();
      const missing = await request(app.getHttpServer()).post(`/v1/bookings/${REFERENCE}/checkout`).set('Authorization', `Bearer ${SHAPED_TOKEN}`).set('Idempotency-Key', KEY_A);
      expect(missing.status).toBe(403);
      appCheckVerifier.willReturn(new AppCheckRejectedError('bad'));
      expect((await pay().expect(403)).body.error.code).toBe('APP_CHECK_FAILED');
      expect(identityVerifier.calls).toHaveLength(0);
    });

    it('Google unreachable is 503 AUTH_UNAVAILABLE, never a silent pass', async () => {
      await fixture();
      identityVerifier.willReturn(new IdentityUnavailableError('down'));
      expect((await pay().expect(503)).body.error.code).toBe('AUTH_UNAVAILABLE');
      expect((await counts()).transactions).toBe(0);
    });

    it('asks Google whether the account was revoked when deployed (staging), and not on a laptop', async () => {
      await fixture();
      await pay().expect(200);
      expect(identityVerifier.calls.at(-1)?.options?.checkRevoked).toBe(false);

      config['NODE_ENV'] = 'staging';
      await createApp();
      await pay().expect(200);
      expect(identityVerifier.calls.at(-1)?.options?.checkRevoked).toBe(true);
    });

    it('a revoked account gets the same 401 as any bad token, and nothing is written', async () => {
      config['NODE_ENV'] = 'staging';
      await createApp();
      await fixture();
      identityVerifier.willReturn((_token, options) => (options?.checkRevoked ? new IdentityRejectedError('revoked') : { ...IDENTITY, uid: 'whatever' }));
      const res = await pay().expect(401);
      expect(res.body.error).toMatchObject({ code: 'UNAUTHENTICATED', message: 'Authentication required' });
      expect(await counts()).toEqual({ transactions: 0, keys: 0 });
    });

    it('requests refused by an earlier guard spend nobody\'s hourly budget', async () => {
      await fixture();
      identityVerifier.willReturn(new IdentityRejectedError('expired'));
      for (let i = 0; i < 15; i++) await pay().expect(401);
      const { user } = await prisma.booking.findFirstOrThrow({ include: { user: true } });
      asOwnerOf(user.firebaseUid);
      for (let i = 0; i < CHECKOUT_LIMIT_PER_HOUR; i++) await pay(REFERENCE, crypto.randomUUID()).expect(200);
    });
  });

  describe('rate limit: 10 an hour per person', () => {
    const fresh = () => pay(REFERENCE, crypto.randomUUID());

    it('allows 10 and refuses the 11th with the standard 429 envelope and Retry-After', async () => {
      await fixture();
      for (let i = 0; i < 10; i++) await fresh().expect(200);
      const res = await fresh().expect(429);
      expect(res.body.error).toEqual({ code: 'RATE_LIMITED', message: 'Too many requests', details: { retryAfterSeconds: 3600 }, requestId: expect.any(String) });
      expect(res.headers['retry-after']).toBe('3600');
    });

    it('is per person: another person is unaffected', async () => {
      await fixture();
      for (let i = 0; i < 10; i++) await fresh().expect(200);
      await fresh().expect(429);
      const b = await createBookingFixture(prisma, { reference: OTHER_REFERENCE });
      asOwnerOf(b.user.firebaseUid);
      await pay(OTHER_REFERENCE, crypto.randomUUID()).expect(200);
    });

    it('slides, counts a replay, and shares no budget with booking creation', async () => {
      await fixture();
      await pay(REFERENCE, KEY_A).expect(200);
      for (let i = 0; i < 9; i++) await pay(REFERENCE, KEY_A).expect(200); // replays spend the budget too
      await pay(REFERENCE, KEY_A).expect(429);
      now += 3_600_001;
      await pay(REFERENCE, KEY_A).expect(200);
    });
  });

  describe('privacy and documentation', () => {
    it('no log line carries a token, an email, a name, a phone number, the key or the payment hash', async () => {
      await fixture();
      const ok = await pay().expect(200);
      await pay('ED-NOSUCH1', KEY_B).expect(404);
      identityVerifier.willReturn(new IdentityRejectedError('expired'));
      await pay().expect(401);
      const logs = loggedText();
      for (const secret of ['Priya', 'priya@example.com', '9876543210', SHAPED_TOKEN, KEY_A, KEY_B, ok.body.fields.hash, CREDS.salt]) {
        expect(logs).not.toContain(secret);
      }
    });

    it('Swagger documents the route with its headers and every answer', async () => {
      const doc = (await request(app.getHttpServer()).get('/docs-json').expect(200)).body;
      const operation = doc.paths['/v1/bookings/{reference}/checkout'].post;
      expect(Object.keys(operation.responses).sort()).toEqual(['200', '400', '401', '403', '404', '409', '429', '503']);
      expect(operation.parameters.map((p: { name: string }) => p.name)).toEqual(expect.arrayContaining(['X-Firebase-AppCheck', 'Idempotency-Key', 'reference']));
      expect(operation.security).toEqual([{ 'firebase-id-token': [] }]);
    });
  });
});
