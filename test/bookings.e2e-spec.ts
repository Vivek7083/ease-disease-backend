import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { APP_CHECK_VERIFIER, AppCheckRejectedError } from '../src/auth/app-check-verifier.js';
import { IDENTITY_VERIFIER, IdentityRejectedError, IdentityUnavailableError, type VerifiedIdentity } from '../src/auth/identity-verifier.js';
import * as bookingReference from '../src/bookings/booking-reference.js';
import { BookingsModule } from '../src/bookings/bookings.module.js';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter.js';
import { configureTrustProxy } from '../src/common/http/trust-proxy.js';
import { RequestIdMiddleware } from '../src/common/middleware/request-id.middleware.js';
import {
  BOOKING_CREATE_LIMIT_PER_HOUR,
  BOOKING_CREATE_RATE_LIMITER,
  BOOKING_CREATE_WINDOW_MS,
  IP_LIMIT_PER_MINUTE,
  IP_RATE_LIMITER,
  RATE_LIMIT_WINDOW_MS,
} from '../src/common/rate-limit/rate-limit.guards.js';
import { SlidingWindowLimiter } from '../src/common/rate-limit/sliding-window-limiter.js';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { setupSwaggerIfAllowed } from '../src/swagger.js';
import { FakeAppCheckVerifier, SHAPED_APP_CHECK_TOKEN } from './helpers/app-check-kit.js';
import { FakeIdentityVerifier, IDENTITY, SHAPED_TOKEN } from './helpers/identity-kit.js';
import { createTestPrisma, truncateAll } from './helpers/test-db.js';

// A collision test needs to decide which references the generator returns; everything else uses the real one.
vi.mock('../src/bookings/booking-reference.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/bookings/booking-reference.js')>();
  return { ...actual, generateBookingReference: vi.fn(actual.generateBookingReference) };
});

const PACKAGE_ID = '00000000-0000-4000-8000-000000000001';
const KEY_A = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const KEY_B = '0b9f8c1e-3d2a-4b6c-9e5f-7a1d2c3b4e5f';

const FORM = {
  packageId: PACKAGE_ID,
  name: 'Priya Sharma',
  whatsappNumber: '+91 98765 43210',
  email: 'Priya@Example.com',
  age: 34,
  city: 'Bengaluru',
  gender: 'Female',
  notes: 'Bloating after meals',
  consent: true,
};

/**
 * B1: POST /v1/bookings over real HTTP on the real `_test` Postgres. Identity and App Check are scripted fakes; the rate
 * limiters are the REAL ones driven by a fake clock.
 */
describe('POST /v1/bookings', () => {
  let prisma: PrismaClient;
  let app: NestExpressApplication;
  let now: number;
  const identityVerifier = new FakeIdentityVerifier();
  const appCheckVerifier = new FakeAppCheckVerifier();
  const generator = vi.mocked(bookingReference.generateBookingReference);
  const realGenerator = generator.getMockImplementation()!;

  async function createApp(trustProxyHops = 0) {
    await app?.close();
    const values: Record<string, unknown> = { NODE_ENV: 'development', FIREBASE_PROJECT_ID: 'easedisease-test', APP_CHECK_MODE: 'enforce' };
    @Global()
    @Module({
      providers: [
        { provide: ConfigService, useValue: { get: (name: string) => values[name] } },
        { provide: PrismaService, useValue: prisma },
      ],
      exports: [ConfigService, PrismaService],
    })
    class FakeInfraModule {}

    const moduleRef = await Test.createTestingModule({ imports: [FakeInfraModule, BookingsModule] })
      .overrideProvider(IDENTITY_VERIFIER)
      .useValue(identityVerifier)
      .overrideProvider(APP_CHECK_VERIFIER)
      .useValue(appCheckVerifier)
      .overrideProvider(IP_RATE_LIMITER)
      .useValue(new SlidingWindowLimiter(IP_LIMIT_PER_MINUTE, RATE_LIMIT_WINDOW_MS, () => now))
      .overrideProvider(BOOKING_CREATE_RATE_LIMITER)
      .useValue(new SlidingWindowLimiter(BOOKING_CREATE_LIMIT_PER_HOUR, BOOKING_CREATE_WINDOW_MS, () => now))
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

  beforeAll(async () => {
    prisma = createTestPrisma();
  });
  afterAll(async () => {
    await app?.close();
    await prisma.$disconnect();
  });

  const logSpies: ReturnType<typeof vi.spyOn>[] = [];
  beforeEach(async () => {
    await truncateAll(prisma);
    await prisma.package.create({ data: { id: PACKAGE_ID, title: 'One-Time Consult', description: ['3-week plan.'], pricePaise: 249900 } });
    now = 1_000_000_000;
    identityVerifier.calls.length = 0;
    identityVerifier.willReturn(IDENTITY);
    appCheckVerifier.calls.length = 0;
    appCheckVerifier.willReturn({ appId: 'app' });
    generator.mockReset();
    generator.mockImplementation(realGenerator);
    await createApp(); // fresh limiters every test
    // Everything the app logs is captured so a test can prove no personal data ends up in a log line.
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
      logSpies.push(vi.spyOn(Logger.prototype, level).mockImplementation(() => undefined));
    }
  });
  afterEach(() => {
    for (const spy of logSpies.splice(0)) spy.mockRestore();
  });

  const post = (body: unknown = FORM, key: string | null = KEY_A) => {
    const req = request(app.getHttpServer()).post('/v1/bookings').set('X-Firebase-AppCheck', SHAPED_APP_CHECK_TOKEN).set('Authorization', `Bearer ${SHAPED_TOKEN}`);
    if (key !== null) req.set('Idempotency-Key', key);
    return req.send(body as object);
  };
  const as = (uid: string, extra: Partial<VerifiedIdentity> = {}) => identityVerifier.willReturn({ ...IDENTITY, uid, email: `${uid}@example.com`, ...extra });
  const counts = async () => ({ bookings: await prisma.booking.count(), keys: await prisma.idempotencyKey.count() });
  const loggedText = () => logSpies.flatMap((spy) => spy.mock.calls).map((call) => call.map(String).join(' ')).join('\n');

  describe('creating a booking', () => {
    it('answers 201 in the contract shape and stores the booking with a price snapshot', async () => {
      const res = await post().expect(201);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['idempotent-replayed']).toBeUndefined();
      expect(res.body).toEqual({
        booking: {
          reference: expect.stringMatching(/^ED-[0-9A-HJKMNP-TV-Z]{6}$/),
          status: 'PENDING_PAYMENT',
          packageTitle: 'One-Time Consult',
          amountPaise: 249900,
          currency: 'INR',
          name: 'Priya Sharma',
          whatsappNumber: '+919876543210',
          email: 'priya@example.com',
          age: 34,
          city: 'Bengaluru',
          gender: 'Female',
          canPay: true,
          payment: null,
        },
      });
      const row = await prisma.booking.findUniqueOrThrow({ where: { reference: res.body.booking.reference } });
      expect(row).toMatchObject({
        status: 'PENDING_PAYMENT',
        packageId: PACKAGE_ID,
        packageTitle: 'One-Time Consult',
        amountPaise: 249900,
        currency: 'INR',
        consulteeName: 'Priya Sharma',
        consulteeWhatsappNumber: '+919876543210',
        consulteeEmail: 'priya@example.com',
        consulteeAge: 34,
        consulteeCity: 'Bengaluru',
        consulteeGender: 'Female',
        notes: 'Bloating after meals',
        createdIp: '127.0.0.1',
        createdUserAgent: null,
      });
      expect(Math.abs(row.consentAt.getTime() - Date.now())).toBeLessThan(60_000);
    });

    it('the price comes from the package, and a later price change does not alter the booking', async () => {
      const res = await post().expect(201);
      await prisma.package.update({ where: { id: PACKAGE_ID }, data: { pricePaise: 999900, title: 'Renamed' } });
      const row = await prisma.booking.findUniqueOrThrow({ where: { reference: res.body.booking.reference } });
      expect([row.amountPaise, row.packageTitle]).toEqual([249900, 'One-Time Consult']);
    });

    it('stores optional fields as null when omitted', async () => {
      const { gender: _gender, notes: _notes, ...minimal } = FORM;
      const res = await post(minimal).expect(201);
      expect(res.body.booking.gender).toBeNull();
      const row = await prisma.booking.findUniqueOrThrow({ where: { reference: res.body.booking.reference } });
      expect([row.consulteeGender, row.notes]).toEqual([null, null]);
    });

    it('books for someone else: the booking keeps the form details and the account row is untouched', async () => {
      await post({ ...FORM, name: 'Ravi Kumar', email: 'ravi@example.com', whatsappNumber: '+44 7911 123456' }).expect(201);
      const user = await prisma.user.findUniqueOrThrow({ where: { firebaseUid: IDENTITY.uid } });
      expect(user).toMatchObject({ name: 'Priya Sharma', email: 'priya@example.com', phone: null });
      const booking = await prisma.booking.findFirstOrThrow();
      expect(booking).toMatchObject({ userId: user.id, consulteeName: 'Ravi Kumar', consulteeEmail: 'ravi@example.com', consulteeWhatsappNumber: '+447911123456' });
    });

    it('works for an account with no phone and no name (no PROFILE_INCOMPLETE)', async () => {
      as('uid-bare', { name: undefined });
      await post().expect(201);
      const user = await prisma.user.findUniqueOrThrow({ where: { firebaseUid: 'uid-bare' } });
      expect([user.name, user.phone]).toEqual([null, null]);
    });

    it('creates the account row when sign-in sync never ran, exactly as GET /v1/me would', async () => {
      expect(await prisma.user.count()).toBe(0);
      await post().expect(201);
      const user = await prisma.user.findUniqueOrThrow({ where: { firebaseUid: IDENTITY.uid } });
      expect(user).toMatchObject({ email: 'priya@example.com', authProvider: 'google.com' });
      expect((await prisma.booking.findFirstOrThrow()).userId).toBe(user.id);
    });

    it('refuses a sign-in method we do not offer and writes nothing', async () => {
      identityVerifier.willReturn({ ...IDENTITY, signInProvider: 'facebook.com' });
      const res = await post().expect(403);
      expect(res.body.error.code).toBe('UNSUPPORTED_SIGN_IN_PROVIDER');
      expect(await counts()).toEqual({ bookings: 0, keys: 0 });
      expect(await prisma.user.count()).toBe(0);
    });

    it('gives each booking its own reference', async () => {
      const first = await post(FORM, KEY_A).expect(201);
      const second = await post(FORM, KEY_B).expect(201);
      expect(first.body.booking.reference).not.toBe(second.body.booking.reference);
      expect((await counts()).bookings).toBe(2);
    });

    it('retries a colliding reference with a new one', async () => {
      const taken = await post(FORM, KEY_B).expect(201);
      generator.mockReset();
      generator.mockReturnValueOnce(taken.body.booking.reference).mockReturnValueOnce(taken.body.booking.reference).mockImplementation(realGenerator);
      const res = await post(FORM, KEY_A).expect(201);
      expect(res.body.booking.reference).not.toBe(taken.body.booking.reference);
      expect(await prisma.booking.count()).toBe(2);
    });

    it('gives up after 5 colliding references: 500, nothing stored, key still free', async () => {
      const taken = await post(FORM, KEY_B).expect(201);
      generator.mockReset();
      generator.mockReturnValue(taken.body.booking.reference);
      const res = await post(FORM, KEY_A).expect(500);
      expect(res.body.error.code).toBe('INTERNAL');
      expect(await counts()).toEqual({ bookings: 1, keys: 1 });
      generator.mockImplementation(realGenerator);
      await post(FORM, KEY_A).expect(201);
    });
  });

  describe('request origin (chargeback evidence)', () => {
    const stored = async () => prisma.booking.findFirstOrThrow({ select: { createdIp: true, createdUserAgent: true } });

    it('stores the sender address and user-agent on the booking', async () => {
      await post().set('User-Agent', 'EaseTest/1.0 (unit)').expect(201);
      expect(await stored()).toEqual({ createdIp: '127.0.0.1', createdUserAgent: 'EaseTest/1.0 (unit)' });
    });

    it('ignores a forged X-Forwarded-For when no proxy is trusted', async () => {
      await post().set('X-Forwarded-For', '198.51.100.9').expect(201);
      expect((await stored()).createdIp).toBe('127.0.0.1');
    });

    it('uses the forwarded address only when one proxy hop is trusted, and only its last entry', async () => {
      await createApp(1);
      await post().set('X-Forwarded-For', '6.6.6.6, 198.51.100.9').expect(201);
      expect((await stored()).createdIp).toBe('198.51.100.9');
    });

    it('cuts a very long user-agent at 512 characters', async () => {
      await post().set('User-Agent', 'u'.repeat(900)).expect(201);
      expect((await stored()).createdUserAgent).toBe('u'.repeat(512));
    });

    it('a missing user-agent is stored as null', async () => {
      await post().unset('User-Agent').expect(201);
      expect((await stored()).createdUserAgent).toBeNull();
    });

    it('is never in any response, and a replay keeps the first values', async () => {
      const first = await post().set('User-Agent', 'First/1').expect(201);
      const second = await post().set('User-Agent', 'Second/2').expect(201);
      expect(second.headers['idempotent-replayed']).toBe('true');
      expect(JSON.stringify([first.body, second.body])).not.toMatch(/127\.0\.0\.1|First\/1|Second\/2/);
      expect((await stored()).createdUserAgent).toBe('First/1');
    });
  });

  describe('validation', () => {
    it('answers 400 VALIDATION_FAILED with every bad field, and writes nothing', async () => {
      const res = await post({ packageId: 'x', name: 'A', whatsappNumber: '9876543210', email: 'nope', age: 0, city: '', consent: false }).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(Object.keys(res.body.error.details.fields).sort()).toEqual(['age', 'city', 'consent', 'email', 'name', 'packageId', 'whatsappNumber']);
      expect(await counts()).toEqual({ bookings: 0, keys: 0 });
    });

    it('refuses unknown fields such as a price or a status', async () => {
      const res = await post({ ...FORM, amountPaise: 1, status: 'CONFIRMED' }).expect(400);
      expect(res.body.error.details.fields).toEqual({ amountPaise: 'Unknown field', status: 'Unknown field' });
      expect((await counts()).bookings).toBe(0);
    });

    it('refuses NUL and control characters with 400 (never a 500)', async () => {
      for (const field of ['name', 'city', 'gender', 'notes']) {
        const res = await post({ ...FORM, [field]: 'ab\u0000cd' }).expect(400);
        expect(res.body.error.details.fields).toHaveProperty(field);
      }
      expect((await counts()).bookings).toBe(0);
    });

    it.each([
      ['an array', '[]'],
      ['a string', '"hello"'],
      ['null', 'null'],
    ])('refuses a JSON body that is %s', async (_label, raw) => {
      const res = await request(app.getHttpServer())
        .post('/v1/bookings')
        .set('X-Firebase-AppCheck', SHAPED_APP_CHECK_TOKEN)
        .set('Authorization', `Bearer ${SHAPED_TOKEN}`)
        .set('Idempotency-Key', KEY_A)
        .set('Content-Type', 'application/json')
        .send(raw);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    it('answers 400 for a missing body', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/bookings')
        .set('X-Firebase-AppCheck', SHAPED_APP_CHECK_TOKEN)
        .set('Authorization', `Bearer ${SHAPED_TOKEN}`)
        .set('Idempotency-Key', KEY_A);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    it('answers a malformed JSON body in the standard envelope with a 4xx', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/bookings')
        .set('X-Firebase-AppCheck', SHAPED_APP_CHECK_TOKEN)
        .set('Authorization', `Bearer ${SHAPED_TOKEN}`)
        .set('Idempotency-Key', KEY_A)
        .set('Content-Type', 'application/json')
        .send('{"name": ');
      expect(res.status).toBe(400);
      expect(res.body.error).toEqual({ code: 'VALIDATION_FAILED', message: 'The request body could not be read', details: {}, requestId: expect.any(String) });
      expect((await counts()).bookings).toBe(0);
    });

    it('missing or malformed Idempotency-Key is 400 naming the header, and nothing is written', async () => {
      for (const key of [null, '', 'abc', 'c232ab00-9414-11ec-b3c8-9f6bdeced846']) {
        const res = await post(FORM, key).expect(400);
        expect(res.body.error.code).toBe('VALIDATION_FAILED');
        expect(res.body.error.details.fields).toHaveProperty(['Idempotency-Key']);
      }
      expect(await counts()).toEqual({ bookings: 0, keys: 0 });
    });
  });

  describe('package', () => {
    it('unknown package: 404 PACKAGE_NOT_FOUND, nothing stored', async () => {
      const res = await post({ ...FORM, packageId: '11111111-1111-4111-8111-111111111111' }).expect(404);
      expect(res.body.error.code).toBe('PACKAGE_NOT_FOUND');
      expect(await counts()).toEqual({ bookings: 0, keys: 0 });
    });

    it('inactive package: 409 PACKAGE_NOT_ACTIVE, nothing stored, and the same key works once it is active again', async () => {
      await prisma.package.update({ where: { id: PACKAGE_ID }, data: { isActive: false } });
      const res = await post().expect(409);
      expect(res.body.error.code).toBe('PACKAGE_NOT_ACTIVE');
      expect(await counts()).toEqual({ bookings: 0, keys: 0 });
      await prisma.package.update({ where: { id: PACKAGE_ID }, data: { isActive: true } });
      await post().expect(201);
    });
  });

  describe('Idempotency-Key', () => {
    it('the same key and the same body replay the original answer and create nothing', async () => {
      const first = await post().expect(201);
      const second = await post().expect(201);
      expect(second.body).toEqual(first.body);
      expect(second.headers['idempotent-replayed']).toBe('true');
      expect(await counts()).toEqual({ bookings: 1, keys: 1 });
    });

    it('an equivalent body (number typed differently, other case) is the same request', async () => {
      const first = await post().expect(201);
      const second = await post({ ...FORM, whatsappNumber: '+919876543210', email: 'priya@example.com', name: ' Priya Sharma ' }).expect(201);
      expect(second.body).toEqual(first.body);
      expect(await prisma.booking.count()).toBe(1);
    });

    it('the same key with a different body is 409 IDEMPOTENCY_CONFLICT and still one booking', async () => {
      await post().expect(201);
      const res = await post({ ...FORM, city: 'Mysuru' }).expect(409);
      expect(res.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
      expect(await counts()).toEqual({ bookings: 1, keys: 1 });
    });

    it('a different key is a different booking', async () => {
      await post(FORM, KEY_A).expect(201);
      await post(FORM, KEY_B).expect(201);
      expect(await counts()).toEqual({ bookings: 2, keys: 2 });
    });

    it('a key is scoped to the person: user B reusing user A key makes their own booking', async () => {
      as('uid-a');
      const a = await post().expect(201);
      as('uid-b');
      const b = await post().expect(201);
      expect(b.headers['idempotent-replayed']).toBeUndefined();
      expect(b.body.booking.reference).not.toBe(a.body.booking.reference);
      expect(await counts()).toEqual({ bookings: 2, keys: 2 });
    });

    it('a failed first attempt stores nothing, so a corrected retry with the same key succeeds', async () => {
      await post({ ...FORM, age: 0 }).expect(400);
      await post({ ...FORM, packageId: '11111111-1111-4111-8111-111111111111' }).expect(404);
      const res = await post().expect(201);
      expect(res.headers['idempotent-replayed']).toBeUndefined();
      expect(await counts()).toEqual({ bookings: 1, keys: 1 });
    });

    it('a replay still answers after the package was switched off or repriced', async () => {
      const first = await post().expect(201);
      await prisma.package.update({ where: { id: PACKAGE_ID }, data: { isActive: false, pricePaise: 1 } });
      const second = await post().expect(201);
      expect(second.body).toEqual(first.body);
    });

    it('after 24 hours the key is free again: same key, same body makes a new booking', async () => {
      const first = await post().expect(201);
      await prisma.$executeRaw`UPDATE idempotency_keys SET created_at = now() - interval '24 hours 1 minute'`;
      const second = await post().expect(201);
      expect(second.headers['idempotent-replayed']).toBeUndefined();
      expect(second.body.booking.reference).not.toBe(first.body.booking.reference);
      expect(await counts()).toEqual({ bookings: 2, keys: 1 });
    });

    it('inside 24 hours the key is still held', async () => {
      await post().expect(201);
      await prisma.$executeRaw`UPDATE idempotency_keys SET created_at = now() - interval '23 hours 50 minutes'`;
      const again = await post().expect(201);
      expect(again.headers['idempotent-replayed']).toBe('true');
      expect(await prisma.booking.count()).toBe(1);
    });

    it('simultaneous identical requests make exactly one booking and every answer is the same', async () => {
      const responses = await Promise.all(Array.from({ length: 6 }, () => post()));
      expect(responses.map((r) => r.status)).toEqual(Array(6).fill(201));
      // Compared as data: the stored copy is jsonb, which may list the keys in another order.
      for (const r of responses) expect(r.body).toEqual(responses[0]!.body);
      expect(responses.filter((r) => r.headers['idempotent-replayed'] === 'true')).toHaveLength(5);
      expect(await counts()).toEqual({ bookings: 1, keys: 1 });
    });

    it('simultaneous requests with the same key but different bodies: one wins, the rest conflict', async () => {
      const responses = await Promise.all(['Mysuru', 'Hubballi', 'Mangaluru'].map((city) => post({ ...FORM, city })));
      expect(responses.map((r) => r.status).sort((a, b) => a - b)).toEqual([201, 409, 409]);
      expect(await counts()).toEqual({ bookings: 1, keys: 1 });
    });

    it('the booking and its key commit together: a failure after the insert leaves neither', async () => {
      await prisma.$executeRawUnsafe(`
        CREATE OR REPLACE FUNCTION test_fail_key_update() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'forced failure after the booking insert'; END $$ LANGUAGE plpgsql`);
      await prisma.$executeRawUnsafe('CREATE TRIGGER test_fail_key_update BEFORE UPDATE ON idempotency_keys FOR EACH ROW EXECUTE FUNCTION test_fail_key_update()');
      try {
        const res = await post().expect(500);
        expect(res.body.error.code).toBe('INTERNAL');
        expect(await counts()).toEqual({ bookings: 0, keys: 0 });
      } finally {
        await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS test_fail_key_update ON idempotency_keys');
        await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS test_fail_key_update()');
      }
      await post().expect(201);
    });
  });

  describe('guards', () => {
    it('no token, a bad token and an unverified email are refused before anything is written', async () => {
      const bare = await request(app.getHttpServer()).post('/v1/bookings').set('X-Firebase-AppCheck', SHAPED_APP_CHECK_TOKEN).set('Idempotency-Key', KEY_A).send(FORM);
      expect(bare.status).toBe(401);
      identityVerifier.willReturn(new IdentityRejectedError('expired'));
      const bad = await post().expect(401);
      expect(bad.body.error.code).toBe('UNAUTHENTICATED');
      identityVerifier.willReturn({ ...IDENTITY, emailVerified: false });
      const unverified = await post().expect(403);
      expect(unverified.body.error.code).toBe('EMAIL_NOT_VERIFIED');
      expect(await counts()).toEqual({ bookings: 0, keys: 0 });
      expect(await prisma.user.count()).toBe(0);
    });

    it('a missing or rejected App Check token is 403 APP_CHECK_FAILED and the login token is not even checked', async () => {
      const missing = await request(app.getHttpServer()).post('/v1/bookings').set('Authorization', `Bearer ${SHAPED_TOKEN}`).set('Idempotency-Key', KEY_A).send(FORM);
      expect(missing.status).toBe(403);
      expect(missing.body.error.code).toBe('APP_CHECK_FAILED');
      appCheckVerifier.willReturn(new AppCheckRejectedError('bad'));
      expect((await post().expect(403)).body.error.code).toBe('APP_CHECK_FAILED');
      expect(identityVerifier.calls).toHaveLength(0);
      expect((await counts()).bookings).toBe(0);
    });

    it('Google unreachable is 503 AUTH_UNAVAILABLE, never a silent pass', async () => {
      identityVerifier.willReturn(new IdentityUnavailableError('down'));
      expect((await post().expect(503)).body.error.code).toBe('AUTH_UNAVAILABLE');
      expect((await counts()).bookings).toBe(0);
    });

    it('requests refused by an earlier guard spend nobody hourly budget', async () => {
      identityVerifier.willReturn(new IdentityRejectedError('expired'));
      for (let i = 0; i < 15; i++) await post().expect(401);
      identityVerifier.willReturn(IDENTITY);
      for (let i = 0; i < BOOKING_CREATE_LIMIT_PER_HOUR; i++) await post(FORM, crypto.randomUUID()).expect(201);
    });
  });

  describe('rate limit: 10 an hour per person', () => {
    const fresh = () => post(FORM, crypto.randomUUID());

    it('allows 10 and refuses the 11th with the standard 429 envelope and Retry-After, creating nothing', async () => {
      for (let i = 0; i < 10; i++) await fresh().expect(201);
      const res = await fresh().expect(429);
      expect(res.body.error).toEqual({ code: 'RATE_LIMITED', message: 'Too many requests', details: { retryAfterSeconds: 3600 }, requestId: expect.any(String) });
      expect(res.headers['retry-after']).toBe('3600');
      expect((await counts()).bookings).toBe(10);
    });

    it('is per person: user B is unaffected by user A reaching the limit', async () => {
      as('uid-a');
      for (let i = 0; i < 10; i++) await fresh().expect(201);
      await fresh().expect(429);
      as('uid-b');
      await fresh().expect(201);
    });

    it('slides: the budget returns after the window, and Retry-After counts down', async () => {
      for (let i = 0; i < 10; i++) await fresh().expect(201);
      now += 600_000;
      expect((await fresh().expect(429)).headers['retry-after']).toBe('3000');
      now += 3_000_000;
      await fresh().expect(201);
    });

    it('a replay of an earlier request still spends one of the 10', async () => {
      await post().expect(201);
      for (let i = 0; i < 9; i++) await post().expect(201);
      await post().expect(429);
    });
  });

  describe('privacy', () => {
    it('no log line carries the form details, the token or the key', async () => {
      await post().expect(201);
      await post({ ...FORM, age: 0 }).expect(400);
      await post({ ...FORM, packageId: '11111111-1111-4111-8111-111111111111' }, KEY_B).expect(404);
      identityVerifier.willReturn(new IdentityRejectedError('expired'));
      await post().expect(401);
      const logs = loggedText();
      for (const secret of ['Priya Sharma', 'priya@example.com', 'Priya@Example.com', '98765', '9876543210', 'Bengaluru', 'Bloating', SHAPED_TOKEN, KEY_A, KEY_B]) {
        expect(logs).not.toContain(secret);
      }
    });
  });

  describe('Swagger', () => {
    it('documents the route with its headers and every answer', async () => {
      const doc = (await request(app.getHttpServer()).get('/docs-json').expect(200)).body;
      const operation = doc.paths['/v1/bookings'].post;
      expect(Object.keys(operation.responses).sort()).toEqual(['201', '400', '401', '403', '404', '409', '429', '503']);
      const headers = operation.parameters.map((p: { name: string }) => p.name);
      expect(headers).toEqual(expect.arrayContaining(['X-Firebase-AppCheck', 'Idempotency-Key']));
      expect(operation.security).toEqual([{ 'firebase-id-token': [] }]);
      expect(operation.requestBody.content['application/json'].schema.$ref).toContain('CreateBookingRequestDto');
    });
  });
});

describe('idempotency_keys table', () => {
  let prisma: PrismaClient;
  beforeAll(() => {
    prisma = createTestPrisma();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await truncateAll(prisma);
  });

  const userId = async () => (await prisma.user.create({ data: { firebaseUid: 'u1', email: 'u1@example.com', authProvider: 'google.com', lastAuthProvider: 'google.com' } })).id;
  const HASH = 'a'.repeat(64);
  const insert = (user: string, over: Partial<{ key: string; endpoint: string; hash: string }> = {}) =>
    prisma.$executeRaw`INSERT INTO idempotency_keys (key, user_id, endpoint, request_hash)
      VALUES (${over.key ?? KEY_A}::uuid, ${user}::uuid, ${over.endpoint ?? 'POST /v1/bookings'}, ${over.hash ?? HASH})`;

  it('round-trips a row and defaults its time to now', async () => {
    const user = await userId();
    await insert(user);
    const row = await prisma.idempotencyKey.findFirstOrThrow();
    expect(row).toMatchObject({ key: KEY_A, userId: user, endpoint: 'POST /v1/bookings', requestHash: HASH, response: null });
    expect(Math.abs(row.createdAt.getTime() - Date.now())).toBeLessThan(60_000);
  });

  it('the same key may exist for another endpoint or another person', async () => {
    const user = await userId();
    const other = (await prisma.user.create({ data: { firebaseUid: 'u2', email: 'u2@example.com', authProvider: 'google.com', lastAuthProvider: 'google.com' } })).id;
    await insert(user);
    await insert(user, { endpoint: 'POST /v1/bookings/checkout' });
    await insert(other);
    expect(await prisma.idempotencyKey.count()).toBe(3);
  });

  it.each([
    ['a duplicate (key, person, endpoint)', {}],
    ['an upper-case hash', { key: KEY_B, hash: 'A'.repeat(64) }],
    ['a short hash', { key: KEY_B, hash: 'a'.repeat(63) }],
    ['a long hash', { key: KEY_B, hash: 'a'.repeat(65) }],
    ['a non-hex hash', { key: KEY_B, hash: 'g'.repeat(64) }],
    ['an empty endpoint', { key: KEY_B, endpoint: '' }],
    ['an over-long endpoint', { key: KEY_B, endpoint: 'e'.repeat(101) }],
  ])('rejects %s', async (_label, over) => {
    const user = await userId();
    await insert(user);
    await expect(insert(user, over)).rejects.toThrow();
  });

  it('rejects a person that does not exist', async () => {
    await expect(insert('99999999-9999-4999-8999-999999999999')).rejects.toThrow();
  });
});
