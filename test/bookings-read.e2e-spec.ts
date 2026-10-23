import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { APP_CHECK_VERIFIER } from '../src/auth/app-check-verifier.js';
import { IDENTITY_VERIFIER, IdentityRejectedError, IdentityUnavailableError, type VerifiedIdentity } from '../src/auth/identity-verifier.js';
import { BookingsModule } from '../src/bookings/bookings.module.js';
import { AppException } from '../src/common/exceptions/app.exception.js';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter.js';
import { configureTrustProxy } from '../src/common/http/trust-proxy.js';
import { RequestIdMiddleware } from '../src/common/middleware/request-id.middleware.js';
import {
  READ_IP_LIMIT_PER_MINUTE,
  READ_IP_RATE_LIMITER,
  READ_LIMIT_PER_MINUTE,
  READ_RATE_LIMITER,
  RATE_LIMIT_WINDOW_MS,
} from '../src/common/rate-limit/rate-limit.guards.js';
import { SlidingWindowLimiter } from '../src/common/rate-limit/sliding-window-limiter.js';
import type { BookingStatus, PrismaClient, TransactionStatus } from '../src/generated/prisma/client.js';
import { CheckoutService } from '../src/payments/checkout.service.js';
import { PaymentHandlerService } from '../src/payments/payment-handler.service.js';
import type { PayuClient, PayuVerifyResult } from '../src/payments/payu/payu-client.js';
import type { PayuCredentialsProvider } from '../src/payments/payu/payu-credentials.provider.js';
import { generateTxnid } from '../src/payments/payu/payu-txnid.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { setupSwaggerIfAllowed } from '../src/swagger.js';
import { FakeAppCheckVerifier } from './helpers/app-check-kit.js';
import { CONSULTEE } from './helpers/booking-contact.js';
import { FakeIdentityVerifier, IDENTITY, SHAPED_TOKEN } from './helpers/identity-kit.js';
import { AMOUNT_PAISE, CREDS, REFERENCE, TXNID, createBookingFixture, createCheckoutFixture, signedPayload } from './helpers/payu-fixtures.js';
import { createTestPrisma, truncateAll } from './helpers/test-db.js';

const ALL_STATUSES: BookingStatus[] = ['PENDING_PAYMENT', 'CONFIRMED', 'COMPLETED', 'CANCELLED', 'NO_SHOW', 'EXPIRED', 'NEEDS_ATTENTION', 'FAILED'];
const ACTIVE: BookingStatus[] = ['PENDING_PAYMENT', 'CONFIRMED', 'NEEDS_ATTENTION'];
const PAYMENT_STATUSES: TransactionStatus[] = ['CREATED', 'INITIATED', 'SUCCESS', 'FAILURE', 'PENDING', 'CANCELLED', 'EXPIRED'];

/**
 * B4 + B5: My Bookings and the booking detail over real HTTP on the real `_test` Postgres. Identity is a scripted fake;
 * the read limiters are the REAL ones driven by a fake clock.
 */
describe('GET /v1/bookings and GET /v1/bookings/{reference}', () => {
  let prisma: PrismaClient;
  let app: NestExpressApplication;
  let now: number;
  let packageId: string;
  let sequence: number;
  const identityVerifier = new FakeIdentityVerifier();
  const appCheckVerifier = new FakeAppCheckVerifier();

  async function createApp() {
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
      .overrideProvider(READ_RATE_LIMITER)
      .useValue(new SlidingWindowLimiter(READ_LIMIT_PER_MINUTE, RATE_LIMIT_WINDOW_MS, () => now))
      .overrideProvider(READ_IP_RATE_LIMITER)
      .useValue(new SlidingWindowLimiter(READ_IP_LIMIT_PER_MINUTE, RATE_LIMIT_WINDOW_MS, () => now))
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureTrustProxy(app, 0);
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
    sequence = 0;
    packageId = (await prisma.package.create({ data: { title: 'One-Time Consult', description: ['x'], pricePaise: AMOUNT_PAISE, durationMinutes: 30 } })).id;
    identityVerifier.calls.length = 0;
    identityVerifier.willReturn(IDENTITY);
    appCheckVerifier.calls.length = 0;
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
      logSpies.push(vi.spyOn(Logger.prototype, level).mockImplementation(() => undefined));
    }
    await createApp();
  });
  afterEach(() => {
    for (const spy of logSpies.splice(0)) spy.mockRestore();
  });

  const get = (path: string, token: string = SHAPED_TOKEN) => request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${token}`);
  const list = (query = '') => get(`/v1/bookings${query}`);
  const as = (user: { firebaseUid: string }) => identityVerifier.willReturn({ ...IDENTITY, uid: user.firebaseUid } satisfies VerifiedIdentity);
  const newUser = async (uid: string) => {
    const user = await prisma.user.create({ data: { firebaseUid: uid, email: `${uid}@example.com`, authProvider: 'google.com', lastAuthProvider: 'google.com' } });
    return user;
  };
  /** The signed-in test person, with an account row. */
  const me = async () => {
    const user = await newUser(IDENTITY.uid);
    as(user);
    return user;
  };
  const seed = async (
    userId: string,
    options: { status?: BookingStatus; createdAt?: Date; reference?: string; id?: string; payment?: TransactionStatus; completedAt?: Date; paymentMode?: string; extra?: Record<string, unknown> } = {},
  ) => {
    sequence += 1;
    const reference = options.reference ?? `ED-R${String(sequence).padStart(5, '0')}`;
    const booking = await prisma.booking.create({
      data: {
        ...(options.id ? { id: options.id } : {}),
        reference,
        userId,
        packageId,
        status: options.status ?? 'PENDING_PAYMENT',
        packageTitle: 'One-Time Consult',
        amountPaise: AMOUNT_PAISE,
        ...CONSULTEE,
        consentAt: new Date(),
        ...(options.createdAt ? { createdAt: options.createdAt } : {}),
        ...options.extra,
      },
    });
    if (options.payment) {
      await prisma.transaction.create({
        data: {
          orderId: `EDTX${String(sequence).padStart(20, '0')}`,
          bookingId: booking.id,
          userId,
          amountPaise: AMOUNT_PAISE,
          status: options.payment,
          paymentMode: options.paymentMode ?? null,
          completedAt: options.completedAt ?? null,
        },
      });
    }
    return booking;
  };
  const refs = (res: request.Response) => (res.body.items as { reference: string }[]).map((item) => item.reference);

  describe('list', () => {
    it('groups statuses: active = pending, confirmed, held; past = everything else; all = everything', async () => {
      const user = await me();
      for (const status of ALL_STATUSES) await seed(user.id, { status, reference: `ED-${status.slice(0, 6)}${status.length}` });
      const statusesOf = async (query: string) => ((await list(query).expect(200)).body.items as { status: BookingStatus }[]).map((item) => item.status).sort();
      expect(await statusesOf('?status=active')).toEqual([...ACTIVE].sort());
      expect(await statusesOf('?status=past')).toEqual(ALL_STATUSES.filter((s) => !ACTIVE.includes(s)).sort());
      expect(await statusesOf('?status=all')).toEqual([...ALL_STATUSES].sort());
    });

    it('defaults to active', async () => {
      const user = await me();
      await seed(user.id, { status: 'PENDING_PAYMENT' });
      await seed(user.id, { status: 'FAILED' });
      const res = await list().expect(200);
      expect(res.body.items.map((item: { status: string }) => item.status)).toEqual(['PENDING_PAYMENT']);
    });

    it('each item has exactly the documented fields', async () => {
      const user = await me();
      await seed(user.id, { payment: 'INITIATED' });
      const res = await list().expect(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(Object.keys(res.body).sort()).toEqual(['items', 'nextCursor']);
      expect(res.body.items[0]).toEqual({
        reference: expect.stringMatching(/^ED-/),
        status: 'PENDING_PAYMENT',
        packageTitle: 'One-Time Consult',
        amountPaise: AMOUNT_PAISE,
        paymentStatus: 'INITIATED',
        canPay: true,
        createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
      });
    });

    it('is newest first', async () => {
      const user = await me();
      await seed(user.id, { reference: 'ED-OLDEST', createdAt: new Date('2026-10-01T00:00:00Z') });
      await seed(user.id, { reference: 'ED-NEWEST', createdAt: new Date('2026-10-03T00:00:00Z') });
      await seed(user.id, { reference: 'ED-MIDDLE', createdAt: new Date('2026-10-02T00:00:00Z') });
      expect(refs(await list().expect(200))).toEqual(['ED-NEWEST', 'ED-MIDDLE', 'ED-OLDEST']);
    });

    it('pages to the end, with a stable order even when every row has the same creation time', async () => {
      const user = await me();
      const same = new Date('2026-10-01T00:00:00.000Z');
      const ids = [1, 2, 3, 4, 5].map((n) => `00000000-0000-4000-8000-00000000000${n}`);
      for (const [n, id] of ids.entries()) await seed(user.id, { id, createdAt: same, reference: `ED-TIE${n}` });
      const seen: string[] = [];
      let cursor: string | null = null;
      const sizes: number[] = [];
      for (let page = 0; page < 5; page++) {
        const res: request.Response = await list(`?limit=2${cursor ? `&cursor=${cursor}` : ''}`).expect(200);
        sizes.push(res.body.items.length);
        seen.push(...refs(res));
        cursor = res.body.nextCursor;
        if (!cursor) break;
      }
      expect(sizes).toEqual([2, 2, 1]);
      expect(cursor).toBeNull();
      expect(seen).toEqual(['ED-TIE4', 'ED-TIE3', 'ED-TIE2', 'ED-TIE1', 'ED-TIE0']); // id descending inside the tie
      expect(new Set(seen).size).toBe(5);
    });

    it('asks the database for creation time then id, the same order the cursor uses (the index could hide a missing tie-break on small tables)', async () => {
      const user = await me();
      await seed(user.id);
      const spy = vi.spyOn(prisma.booking, 'findMany');
      await list().expect(200);
      expect(spy.mock.calls[0]?.[0]?.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
      spy.mockRestore();
    });

    it('a booking created between two pages neither repeats nor skips a row', async () => {
      const user = await me();
      for (let n = 1; n <= 4; n++) await seed(user.id, { reference: `ED-P${n}`, createdAt: new Date(`2026-10-0${n}T00:00:00Z`) });
      const first = await list('?limit=2').expect(200);
      expect(refs(first)).toEqual(['ED-P4', 'ED-P3']);
      await seed(user.id, { reference: 'ED-NEWER', createdAt: new Date('2026-10-09T00:00:00Z') });
      const second = await list(`?limit=2&cursor=${first.body.nextCursor}`).expect(200);
      expect(refs(second)).toEqual(['ED-P2', 'ED-P1']);
      expect(second.body.nextCursor).toBeNull();
    });

    it('an exact multiple of the page size ends with a null cursor, not an empty extra page', async () => {
      const user = await me();
      for (let n = 1; n <= 4; n++) await seed(user.id, { createdAt: new Date(`2026-10-0${n}T00:00:00Z`) });
      const first = await list('?limit=2').expect(200);
      const second = await list(`?limit=2&cursor=${first.body.nextCursor}`).expect(200);
      expect(second.body.items).toHaveLength(2);
      expect(second.body.nextCursor).toBeNull();
    });

    it.each([['limit=1', 1], ['limit=50', 50]])('accepts %s', async (query) => {
      await me();
      await list(`?${query}`).expect(200);
    });

    it.each([['limit=0'], ['limit=51'], ['limit=abc'], ['limit=1.5'], ['limit=-1'], ['limit=1&limit=2'], ['status=archived'], ['status=ACTIVE'], ['cursor=nonsense'], ['cursor=']])('refuses ?%s with 400 naming the parameter', async (query) => {
      await me();
      const res = await list(`?${query}`).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(Object.keys(res.body.error.details.fields)).toHaveLength(1);
    });

    it('a tampered cursor is refused, not guessed at', async () => {
      const user = await me();
      for (let n = 1; n <= 3; n++) await seed(user.id, { createdAt: new Date(`2026-10-0${n}T00:00:00Z`) });
      const { nextCursor } = (await list('?limit=1').expect(200)).body;
      const decoded = JSON.parse(Buffer.from(nextCursor, 'base64url').toString('utf8'));
      const forged = Buffer.from(JSON.stringify({ ...decoded, i: '00000000-0000-4000-8000-000000000000', x: 1 })).toString('base64url');
      await list(`?cursor=${forged}`).expect(400);
      await list(`?cursor=${nextCursor}A`).expect(400);
    });

    it('never shows another person\'s bookings, even interleaved in time', async () => {
      const mine = await me();
      const other = await newUser('someone-else');
      for (let n = 1; n <= 3; n++) {
        await seed(mine.id, { reference: `ED-MINE${n}`, createdAt: new Date(`2026-10-0${n}T00:00:00Z`) });
        await seed(other.id, { reference: `ED-THEIRS${n}`, createdAt: new Date(`2026-10-0${n}T12:00:00Z`) });
      }
      expect(refs(await list('?status=all&limit=50').expect(200))).toEqual(['ED-MINE3', 'ED-MINE2', 'ED-MINE1']);
      as(other);
      expect(refs(await list('?status=all').expect(200))).toEqual(['ED-THEIRS3', 'ED-THEIRS2', 'ED-THEIRS1']);
    });

    it('is an empty list when there is nothing, and for a person with no account row (which is not created)', async () => {
      await me();
      expect((await list().expect(200)).body).toEqual({ items: [], nextCursor: null });
      identityVerifier.willReturn({ ...IDENTITY, uid: 'never-signed-in' });
      expect((await list().expect(200)).body).toEqual({ items: [], nextCursor: null });
      expect(await prisma.user.count()).toBe(1);
    });

    it('shows paymentStatus and canPay per row', async () => {
      const user = await me();
      await seed(user.id, { reference: 'ED-NOPAY', createdAt: new Date('2026-10-01T00:00:00Z') });
      await seed(user.id, { reference: 'ED-INIT', createdAt: new Date('2026-10-02T00:00:00Z'), payment: 'INITIATED' });
      await seed(user.id, { reference: 'ED-PEND', createdAt: new Date('2026-10-03T00:00:00Z'), payment: 'PENDING' });
      await seed(user.id, { reference: 'ED-PAID', createdAt: new Date('2026-10-04T00:00:00Z'), status: 'CONFIRMED', payment: 'SUCCESS' });
      const items = Object.fromEntries(((await list('?status=all').expect(200)).body.items as { reference: string; paymentStatus: string | null; canPay: boolean }[]).map((i) => [i.reference, [i.paymentStatus, i.canPay]]));
      expect(items).toEqual({ 'ED-NOPAY': [null, true], 'ED-INIT': ['INITIATED', true], 'ED-PEND': ['PENDING', false], 'ED-PAID': ['SUCCESS', false] });
    });
  });

  describe('detail', () => {
    it('returns the full booking, with the details typed on the form and not the account\'s', async () => {
      const user = await me();
      await prisma.user.update({ where: { id: user.id }, data: { name: 'Account Holder', phone: '+919000000001' } });
      await seed(user.id, { reference: REFERENCE, extra: { consulteeGender: 'Female', notes: 'Bloating after meals' } });
      const res = await get(`/v1/bookings/${REFERENCE}`).expect(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toEqual({
        booking: {
          reference: REFERENCE,
          status: 'PENDING_PAYMENT',
          packageTitle: 'One-Time Consult',
          amountPaise: AMOUNT_PAISE,
          currency: 'INR',
          name: 'Priya Sharma',
          whatsappNumber: '+919876543210',
          email: 'priya@example.com',
          age: 34,
          city: 'Bengaluru',
          gender: 'Female',
          notes: 'Bloating after meals',
          canPay: true,
          payment: null,
          createdAt: expect.stringMatching(/Z$/),
        },
      });
      expect(JSON.stringify(res.body)).not.toMatch(/Account Holder|9000000001/);
    });

    it('is the same data the create answer returned (plus notes)', async () => {
      await me();
      const created = await request(app.getHttpServer())
        .post('/v1/bookings')
        .set('X-Firebase-AppCheck', 'aaaa.bbbb.cccc')
        .set('Authorization', `Bearer ${SHAPED_TOKEN}`)
        .set('Idempotency-Key', 'f47ac10b-58cc-4372-a567-0e02b2c3d479')
        .send({ packageId, name: 'Meera Nair', whatsappNumber: '+91 98765 43210', email: 'Meera@Example.com', age: 41, city: 'Kochi', gender: 'Female', notes: 'Sleep trouble', consent: true })
        .expect(201);
      const detail = (await get(`/v1/bookings/${created.body.booking.reference}`).expect(200)).body.booking;
      expect(detail).toEqual({ ...created.body.booking, notes: 'Sleep trouble' });
    });

    it('shows the payment: started, paid (with time and mode), failed (no paid time)', async () => {
      const user = await me();
      await seed(user.id, { reference: 'ED-STARTED', payment: 'INITIATED' });
      await seed(user.id, { reference: 'ED-PAID', status: 'CONFIRMED', payment: 'SUCCESS', paymentMode: 'UPI', completedAt: new Date('2026-10-22T10:05:00.000Z') });
      await seed(user.id, { reference: 'ED-FAILED', status: 'FAILED', payment: 'FAILURE', completedAt: new Date('2026-10-22T10:06:00.000Z') });
      const payment = async (reference: string) => (await get(`/v1/bookings/${reference}`).expect(200)).body.booking.payment;
      expect(await payment('ED-STARTED')).toEqual({ orderId: expect.stringMatching(/^EDTX/), status: 'INITIATED', mode: null, paidAt: null });
      expect(await payment('ED-PAID')).toEqual({ orderId: expect.stringMatching(/^EDTX/), status: 'SUCCESS', mode: 'UPI', paidAt: '2026-10-22T10:05:00.000Z' });
      expect(await payment('ED-FAILED')).toMatchObject({ status: 'FAILURE', paidAt: null });
    });

    it('a paid-but-held (amount mismatch) payment has no paid time either', async () => {
      const user = await me();
      await seed(user.id, { reference: 'ED-HELD', status: 'NEEDS_ATTENTION', payment: 'FAILURE', completedAt: new Date('2026-10-22T10:06:00.000Z') });
      expect((await get('/v1/bookings/ED-HELD').expect(200)).body.booking).toMatchObject({ status: 'NEEDS_ATTENTION', canPay: false, payment: { paidAt: null } });
    });

    it('after a PayU success the detail shows CONFIRMED and the payment SUCCESS (what the status page polls)', async () => {
      const { user } = await createCheckoutFixture(prisma);
      as(user);
      const before = (await get(`/v1/bookings/${REFERENCE}`).expect(200)).body.booking;
      expect(before).toMatchObject({ status: 'PENDING_PAYMENT', canPay: true, payment: { status: 'INITIATED', paidAt: null } });

      const payu = {
        verifyPayment: vi.fn().mockResolvedValue({
          outcome: 'found', txnid: TXNID, status: 'success', rawStatus: 'success', unmappedStatus: 'captured', amountPaise: AMOUNT_PAISE,
          mihpayid: '21564143078', mode: 'UPI', bankRefNum: '431998369241', errorCode: 'E000', errorMessage: 'NO ERROR',
        } satisfies PayuVerifyResult),
      };
      const handler = new PaymentHandlerService(prisma, { get: () => CREDS } as unknown as PayuCredentialsProvider, payu as unknown as PayuClient);
      await handler.handle({ source: 'WEBHOOK', payload: signedPayload(), sourceIp: null });

      const after = (await get(`/v1/bookings/${REFERENCE}`).expect(200)).body.booking;
      expect(after).toMatchObject({ status: 'CONFIRMED', canPay: false, payment: { status: 'SUCCESS', mode: 'UPI', paidAt: expect.stringMatching(/Z$/) } });
    });

    it('someone else\'s booking, an unknown reference, a malformed one and a person with no account get the identical 404', async () => {
      const mine = await me();
      const other = await newUser('someone-else');
      await seed(other.id, { reference: 'ED-THEIRS' });
      await seed(mine.id, { reference: 'ED-MINE' });
      const bodies: unknown[] = [];
      for (const reference of ['ED-THEIRS', 'ED-NOSUCH', "' OR '1'='1", 'x'.repeat(40), 'ED-1%00X']) {
        const res = await get(`/v1/bookings/${encodeURIComponent(reference)}`).expect(404);
        expect(res.body.error.code).toBe('BOOKING_NOT_FOUND');
        bodies.push({ ...res.body.error, requestId: undefined });
      }
      identityVerifier.willReturn({ ...IDENTITY, uid: 'never-signed-in' });
      const nobody = await get('/v1/bookings/ED-MINE').expect(404);
      bodies.push({ ...nobody.body.error, requestId: undefined });
      for (const body of bodies) expect(body).toEqual(bodies[0]);
      expect(await prisma.user.count()).toBe(2);
    });

    it('never returns the sender address, user-agent, consent time, expert notes, scheduled time or internal ids', async () => {
      const user = await me();
      const booking = await seed(user.id, {
        reference: REFERENCE,
        payment: 'SUCCESS',
        extra: { createdIp: '203.0.113.77', createdUserAgent: 'SecretAgent/9.9', expertNotes: 'internal note xyz', scheduledAt: new Date('2031-05-05T05:05:05.000Z') },
      });
      const transaction = await prisma.transaction.findFirstOrThrow();
      await prisma.transaction.update({ where: { id: transaction.id }, data: { createdIp: '198.51.100.88', createdUserAgent: 'TxAgent/1.0', pgTxnId: 'MIHPAY123456', bankRefNum: 'BANKREF999' } });
      for (const body of [(await get(`/v1/bookings/${REFERENCE}`).expect(200)).body, (await list('?status=all').expect(200)).body]) {
        const text = JSON.stringify(body);
        for (const secret of ['203.0.113.77', 'SecretAgent', 'internal note xyz', '2031-05-05', '198.51.100.88', 'TxAgent', 'MIHPAY123456', 'BANKREF999', booking.id, user.id, user.firebaseUid, booking.consentAt.toISOString()]) {
          expect(text).not.toContain(secret);
        }
      }
    });
  });

  describe('canPay agrees with what checkout accepts', () => {
    it('is true exactly when the payment form can be requested, for every booking and payment status', async () => {
      const credentials = { get: () => CREDS } as unknown as PayuCredentialsProvider;
      const checkout = new CheckoutService(prisma as never, credentials, { get: () => undefined } as never);
      const cases: { bookingStatus: BookingStatus; payment: TransactionStatus | null }[] = [
        ...PAYMENT_STATUSES.map((payment) => ({ bookingStatus: 'PENDING_PAYMENT' as const, payment })),
        { bookingStatus: 'PENDING_PAYMENT', payment: null },
        ...ALL_STATUSES.filter((s) => s !== 'PENDING_PAYMENT').flatMap((bookingStatus) => [null, ...PAYMENT_STATUSES].map((payment) => ({ bookingStatus, payment }))),
      ];
      for (const [n, { bookingStatus, payment }] of cases.entries()) {
        await truncateAll(prisma);
        const made = payment
          ? await createCheckoutFixture(prisma, { bookingStatus, transactionStatus: payment, txnid: generateTxnid() })
          : await createBookingFixture(prisma, { bookingStatus });
        as(made.user);
        const reported = (await get(`/v1/bookings/${REFERENCE}`).expect(200)).body.booking.canPay as boolean;
        const listed = (await list('?status=all').expect(200)).body.items[0].canPay as boolean;
        let accepted = true;
        try {
          await checkout.createCheckout({ userId: made.user.id, bookingReference: REFERENCE });
        } catch (error) {
          if (!(error instanceof AppException) || error.code !== 'BOOKING_NOT_PAYABLE') throw error;
          accepted = false;
        }
        expect({ case: n, bookingStatus, payment, reported, listed }).toEqual({ case: n, bookingStatus, payment, reported: accepted, listed: accepted });
        // Reset the read budget: this test makes hundreds of calls.
        now += RATE_LIMIT_WINDOW_MS;
      }
    }, 60_000);
  });

  describe('guards and limits', () => {
    it('no token, a bad token, an unverified email and Google down are refused as for every other route', async () => {
      await me();
      expect((await request(app.getHttpServer()).get('/v1/bookings')).status).toBe(401);
      expect((await request(app.getHttpServer()).get(`/v1/bookings/${REFERENCE}`)).status).toBe(401);
      identityVerifier.willReturn(new IdentityRejectedError('expired'));
      expect((await list().expect(401)).body.error.code).toBe('UNAUTHENTICATED');
      identityVerifier.willReturn({ ...IDENTITY, emailVerified: false });
      expect((await list().expect(403)).body.error.code).toBe('EMAIL_NOT_VERIFIED');
      identityVerifier.willReturn(new IdentityUnavailableError('down'));
      expect((await list().expect(503)).body.error.code).toBe('AUTH_UNAVAILABLE');
    });

    it('needs no App Check token (reads are login only)', async () => {
      await me();
      await list().expect(200);
      expect(appCheckVerifier.calls).toHaveLength(0);
    });

    it('allows 120 reads a minute per person, then 429 with Retry-After; list and detail share the budget', async () => {
      const user = await me();
      await seed(user.id, { reference: REFERENCE });
      for (let i = 0; i < READ_LIMIT_PER_MINUTE / 2; i++) {
        await list().expect(200);
        await get(`/v1/bookings/${REFERENCE}`).expect(200);
      }
      const res = await list().expect(429);
      expect(res.body.error).toEqual({ code: 'RATE_LIMITED', message: 'Too many requests', details: { retryAfterSeconds: 60 }, requestId: expect.any(String) });
      expect(res.headers['retry-after']).toBe('60');
      await get(`/v1/bookings/${REFERENCE}`).expect(429);
    });

    it('is per person, and the window slides', async () => {
      const user = await me();
      for (let i = 0; i < READ_LIMIT_PER_MINUTE; i++) await list().expect(200);
      await list().expect(429);
      const other = await newUser('someone-else');
      as(other);
      await list().expect(200);
      as(user);
      now += RATE_LIMIT_WINDOW_MS + 1;
      await list().expect(200);
    });

    it('the status page polling every 2 seconds for a minute never trips the limit', async () => {
      const user = await me();
      await seed(user.id, { reference: REFERENCE });
      for (let second = 0; second <= 60; second += 2) {
        await get(`/v1/bookings/${REFERENCE}`).expect(200);
        now += 2_000;
      }
    });

    it('is not held back by the 120-a-minute address bucket of sign-in and payment: 130 refused requests from one address are all 401, none 429', async () => {
      identityVerifier.willReturn(new IdentityRejectedError('expired'));
      for (let i = 0; i < 130; i++) await list().expect(401);
    });

    it('has its own per-address limit of 600 a minute, counting refused requests too', async () => {
      identityVerifier.willReturn(new IdentityRejectedError('expired'));
      for (let i = 0; i < READ_IP_LIMIT_PER_MINUTE; i++) await get('/v1/bookings/ED-X').expect(401);
      const res = await get('/v1/bookings/ED-X').expect(429);
      expect(res.body.error.code).toBe('RATE_LIMITED');
      expect(res.headers['retry-after']).toBe('60');
    });

    it('requests refused by the login guard spend nobody\'s per-person budget', async () => {
      await me();
      identityVerifier.willReturn(new IdentityRejectedError('expired'));
      for (let i = 0; i < 20; i++) await list().expect(401);
      identityVerifier.willReturn({ ...IDENTITY });
      for (let i = 0; i < READ_LIMIT_PER_MINUTE; i++) await list().expect(200);
    });
  });

  describe('documentation and clean-up', () => {
    it('Swagger documents both routes with their parameters and every answer', async () => {
      const doc = (await request(app.getHttpServer()).get('/docs-json').expect(200)).body;
      const listOp = doc.paths['/v1/bookings'].get;
      expect(Object.keys(listOp.responses).sort()).toEqual(['200', '400', '401', '403', '429', '503']);
      expect(listOp.parameters.map((p: { name: string }) => p.name).sort()).toEqual(['cursor', 'limit', 'status']);
      const detailOp = doc.paths['/v1/bookings/{reference}'].get;
      expect(Object.keys(detailOp.responses).sort()).toEqual(['200', '401', '403', '404', '429', '503']);
      expect(detailOp.security).toEqual([{ 'firebase-id-token': [] }]);
    });

    it('the hold column is gone from the database', async () => {
      const rows = await prisma.$queryRaw<{ column_name: string }[]>`SELECT column_name FROM information_schema.columns WHERE table_name = 'bookings'`;
      const names = rows.map((r) => r.column_name);
      expect(names).not.toContain('hold_expires_at');
      expect(names).toContain('confirmed_at');
    });

    it('no code in src/ mentions holds or slot errors any more', () => {
      const files: string[] = [];
      const walk = (dir: string) => {
        for (const entry of readdirSync(dir)) {
          const path = join(dir, entry);
          if (statSync(path).isDirectory()) {
            if (entry !== 'generated') walk(path);
          } else if (path.endsWith('.ts')) files.push(path);
        }
      };
      walk(join(process.cwd(), 'src'));
      const offenders = files.filter((file) => /holdExpires|hold_expires|SLOT_[A-Z]/.test(readFileSync(file, 'utf8')));
      expect(offenders).toEqual([]);
    });
  });
});
