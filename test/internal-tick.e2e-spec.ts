import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter.js';
import { IdempotencyCleanupService } from '../src/common/idempotency/idempotency-cleanup.service.js';
import { RequestIdMiddleware } from '../src/common/middleware/request-id.middleware.js';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { InternalModule } from '../src/internal/internal.module.js';
import { OIDC_VERIFIER } from '../src/internal/oidc-verifier.js';
import { PaymentsModule } from '../src/payments/payments.module.js';
import { PayuClient, PayuGatewayError, type PayuVerifyResult } from '../src/payments/payu/payu-client.js';
import { PayuCredentialsProvider } from '../src/payments/payu/payu-credentials.provider.js';
import { ReconcileService } from '../src/payments/reconcile.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { setupSwaggerIfAllowed } from '../src/swagger.js';
import { AUDIENCE, SCHEDULER_ACCOUNT, createOidcKit } from './helpers/oidc-kit.js';
import { AMOUNT_PAISE, CREDS, REFERENCE, TXNID, createCheckoutFixture, snapshot } from './helpers/payu-fixtures.js';
import { createTestPrisma, truncateAll } from './helpers/test-db.js';

/**
 * R4: POST /v1/internal/tick over real HTTP with the real guard, real Google token verification (local key), the real
 * reconcile sweep and the real `_test` Postgres. Only PayU is faked.
 */
describe('POST /v1/internal/tick', () => {
  const kit = createOidcKit();
  let prisma: PrismaClient;
  let app: NestExpressApplication;
  let payu: { verifyPayment: ReturnType<typeof vi.fn> };

  const TICK = '/v1/internal/tick';
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
  const FAILURE = found({ status: 'failure', rawStatus: 'failure', unmappedStatus: 'failed', errorCode: 'E4936', errorMessage: 'declined' });

  async function createApp(nodeEnv = 'production', override?: (builder: ReturnType<typeof Test.createTestingModule>) => void) {
    const values: Record<string, unknown> = {
      NODE_ENV: nodeEnv,
      FRONTEND_BASE_URL: 'https://easedisease.in',
      API_PUBLIC_URL: 'https://api.easedisease.in',
      TICK_AUDIENCE: AUDIENCE,
      TICK_SERVICE_ACCOUNT_EMAIL: SCHEDULER_ACCOUNT,
    };
    @Global()
    @Module({
      providers: [
        { provide: ConfigService, useValue: { get: (name: string) => values[name] } },
        { provide: PrismaService, useValue: prisma },
      ],
      exports: [ConfigService, PrismaService],
    })
    class FakeInfraModule {}

    const builder = Test.createTestingModule({ imports: [FakeInfraModule, PaymentsModule, InternalModule] })
      .overrideProvider(PayuClient)
      .useValue(payu)
      .overrideProvider(PayuCredentialsProvider)
      .useValue({ get: () => CREDS, status: () => ({ source: 'env', env: 'test', keyHint: '***' }) })
      .overrideProvider(OIDC_VERIFIER)
      .useValue(kit.verifier);
    override?.(builder);
    app = (await builder.compile()).createNestApplication<NestExpressApplication>();
    const requestId = new RequestIdMiddleware();
    app.use((req: never, res: never, next: never) => requestId.use(req, res, next));
    app.useGlobalFilters(new AllExceptionsFilter());
    if (nodeEnv === 'development') setupSwaggerIfAllowed(app, 'development');
    await app.init();
  }

  /** A payment that is due for reconciliation: INITIATED and 30 minutes old. */
  async function dueTransaction(options: Parameters<typeof createCheckoutFixture>[1] = {}) {
    const created = await createCheckoutFixture(prisma, options);
    await prisma.transaction.update({
      where: { id: created.transaction.id },
      data: { createdAt: new Date(Date.now() - 30 * 60_000), updatedAt: new Date(Date.now() - 30 * 60_000) },
    });
    return created;
  }

  const authed = () => `Bearer ${kit.mint()}`;
  const tick = (authorization?: string) => {
    const req = request(app.getHttpServer()).post(TICK);
    return authorization === undefined ? req : req.set('Authorization', authorization);
  };

  beforeAll(() => {
    prisma = createTestPrisma();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await truncateAll(prisma);
    payu = { verifyPayment: vi.fn().mockResolvedValue(found()) };
  });
  afterEach(async () => {
    await app?.close();
  });

  describe('who may call it', () => {
    beforeEach(() => createApp());

    it.each([
      ['no token', undefined],
      ['a token for the wrong audience', `Bearer ${kit.mint({ aud: 'https://evil.example.com' })}`],
      ['a token for another account', `Bearer ${kit.mint({ email: 'someone@example.com' })}`],
      ['an unsigned-by-Google token', `Bearer ${kit.mint({}, { signWith: 'evil' })}`],
      ['garbage', 'Bearer nonsense'],
    ])('%s: 401, PayU is never asked and nothing changes', async (_name, header) => {
      await dueTransaction();
      const before = await snapshot(prisma);

      const res = await tick(header).expect(401);

      expect(res.body.error).toMatchObject({ code: 'UNAUTHENTICATED' });
      expect(payu.verifyPayment).not.toHaveBeenCalled();
      expect(await snapshot(prisma)).toEqual(before);
      expect(await prisma.paymentEvent.count()).toBe(0);
    });

    it('only POST exists: other methods get a 404', async () => {
      const http = request(app.getHttpServer());
      for (const call of [() => http.get(TICK), () => http.put(TICK), () => http.delete(TICK), () => http.patch(TICK)]) {
        await call().set('Authorization', authed()).expect(404);
      }
      expect(payu.verifyPayment).not.toHaveBeenCalled();
    });
  });

  describe('what it does for the scheduler', () => {
    beforeEach(() => createApp());

    it('settles a due payment from PayU\'s answer and reports counts only', async () => {
      await dueTransaction();
      payu.verifyPayment.mockResolvedValue(FAILURE);

      const res = await tick(authed()).expect(200);

      expect(res.body).toEqual({
        reconcile: { checked: 1, applied: 0, failed: 1, pending: 0, mismatch: 0, duplicate: 0, notFound: 0, errors: 0, stoppedOnGatewayError: false },
        cleanup: { idempotencyKeysDeleted: 0 },
      });
      expect((await prisma.transaction.findFirstOrThrow()).status).toBe('FAILURE');
      expect((await prisma.booking.findFirstOrThrow()).status).toBe('FAILED');
      const text = JSON.stringify(res.body);
      for (const secret of [TXNID, REFERENCE, 'priya']) expect(text).not.toContain(secret);
    });

    it('confirms a paid booking with exactly the two alerts', async () => {
      await dueTransaction();
      const res = await tick(authed()).expect(200);
      expect(res.body.reconcile).toMatchObject({ checked: 1, applied: 1 });
      expect((await prisma.booking.findFirstOrThrow()).status).toBe('CONFIRMED');
      expect(await prisma.outbox.count()).toBe(2);
    });

    it('an empty queue is a plain 200 and PayU is not asked', async () => {
      const res = await tick(authed()).expect(200);
      expect(res.body.reconcile).toMatchObject({ checked: 0, stoppedOnGatewayError: false });
      expect(payu.verifyPayment).not.toHaveBeenCalled();
    });

    it('a payment that is too young is left alone', async () => {
      await createCheckoutFixture(prisma);
      await tick(authed()).expect(200);
      expect(payu.verifyPayment).not.toHaveBeenCalled();
    });

    it('PayU being down is still a 200 that says so, and changes nothing', async () => {
      await dueTransaction();
      payu.verifyPayment.mockRejectedValue(new PayuGatewayError('timeout'));
      const before = await snapshot(prisma);

      const res = await tick(authed()).expect(200);

      expect(res.body.reconcile).toMatchObject({ checked: 0, stoppedOnGatewayError: true });
      expect(await snapshot(prisma)).toEqual(before);
    });

    it('is safe to repeat and to overlap: two ticks at once, then a third, give one set of alerts', async () => {
      await dueTransaction();
      await Promise.all([tick(authed()).expect(200), tick(authed()).expect(200)]);
      await tick(authed()).expect(200);

      expect(await prisma.outbox.count()).toBe(2);
      expect((await prisma.transaction.findFirstOrThrow()).status).toBe('SUCCESS');
    });

    it('ignores whatever body is sent', async () => {
      await dueTransaction();
      payu.verifyPayment.mockResolvedValue(FAILURE);
      const res = await tick(authed()).send({ batchSize: 1, now: '2000-01-01', status: 'SUCCESS' }).expect(200);
      expect(res.body.reconcile).toMatchObject({ checked: 1, failed: 1 });
    });
  });

  describe('when the sweep breaks unexpectedly', () => {
    it('answers the standard 500 envelope with a request id and no internal detail', async () => {
      await createApp('production', (builder) => builder.overrideProvider(ReconcileService).useValue({ run: () => Promise.reject(new Error('secret db detail')) }));
      const res = await tick(authed()).expect(500);
      expect(res.body.error).toMatchObject({ code: 'INTERNAL', requestId: expect.any(String) });
      expect(JSON.stringify(res.body)).not.toContain('secret db detail');
    });
  });

  describe('idempotency key cleanup', () => {
    const KEY_OLD_1 = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
    const KEY_OLD_2 = '0b9f8c1e-3d2a-4b6c-9e5f-7a1d2c3b4e5f';
    const KEY_NEW = '9c1d3e5f-7a2b-4c4d-8e6f-1a2b3c4d5e6f';
    const seedKeys = async () => {
      const user = await prisma.user.create({ data: { firebaseUid: 'u1', email: 'u1@example.com', authProvider: 'google.com', lastAuthProvider: 'google.com' } });
      const make = (key: string, hoursAgo: number) =>
        prisma.idempotencyKey.create({ data: { key, userId: user.id, endpoint: 'POST /v1/bookings', requestHash: 'a'.repeat(64), createdAt: new Date(Date.now() - hoursAgo * 3_600_000) } });
      await make(KEY_OLD_1, 25);
      await make(KEY_OLD_2, 72);
      await make(KEY_NEW, 23);
    };

    it('deletes keys older than 24 hours, keeps newer ones, and reports the count', async () => {
      await createApp();
      await seedKeys();
      const res = await tick(authed()).expect(200);
      expect(res.body.cleanup).toEqual({ idempotencyKeysDeleted: 2 });
      expect((await prisma.idempotencyKey.findMany()).map((row) => row.key)).toEqual([KEY_NEW]);
    });

    it('runs together with the payment sweep, and an empty table is a plain zero', async () => {
      await createApp();
      await dueTransaction();
      payu.verifyPayment.mockResolvedValue(FAILURE);
      const res = await tick(authed()).expect(200);
      expect(res.body).toEqual({ reconcile: expect.objectContaining({ checked: 1, failed: 1 }), cleanup: { idempotencyKeysDeleted: 0 } });
    });

    it('a cleanup failure is the standard 500 (the scheduler reports it) and the payment sweep had already run', async () => {
      await createApp('production', (builder) => builder.overrideProvider(IdempotencyCleanupService).useValue({ run: () => Promise.reject(new Error('secret db detail')) }));
      await dueTransaction();
      payu.verifyPayment.mockResolvedValue(FAILURE);
      const res = await tick(authed()).expect(500);
      expect(res.body.error).toMatchObject({ code: 'INTERNAL', requestId: expect.any(String) });
      expect(JSON.stringify(res.body)).not.toContain('secret db detail');
      expect((await prisma.booking.findFirstOrThrow()).status).toBe('FAILED');
    });

    it('a request without the scheduler token deletes nothing', async () => {
      await createApp();
      await seedKeys();
      await tick().expect(401);
      expect(await prisma.idempotencyKey.count()).toBe(3);
    });

    it('the development tick cleans up too', async () => {
      await createApp('development');
      await seedKeys();
      const res = await request(app.getHttpServer()).post('/dev/tick').expect(200);
      expect(res.body.cleanup).toEqual({ idempotencyKeysDeleted: 2 });
    });
  });

  describe('POST /dev/tick (development only)', () => {
    it.each(['production', 'staging', 'test'])('is a 404 in %s and runs nothing', async (nodeEnv) => {
      await createApp(nodeEnv);
      await dueTransaction();
      const before = await snapshot(prisma);
      const res = await request(app.getHttpServer()).post('/dev/tick').expect(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
      expect(payu.verifyPayment).not.toHaveBeenCalled();
      expect(await snapshot(prisma)).toEqual(before);
    });

    describe('in development', () => {
      beforeEach(() => createApp('development'));

      it('runs the sweep once without a token', async () => {
        await dueTransaction();
        payu.verifyPayment.mockResolvedValue(FAILURE);
        const res = await request(app.getHttpServer()).post('/dev/tick').expect(200);
        expect(res.body.reconcile).toMatchObject({ checked: 1, failed: 1 });
        expect((await prisma.booking.findFirstOrThrow()).status).toBe('FAILED');
      });

      it('does not weaken the real endpoint: /v1/internal/tick still needs the scheduler token', async () => {
        await dueTransaction();
        await tick().expect(401);
        expect(payu.verifyPayment).not.toHaveBeenCalled();
      });

      it('both routes are documented in Swagger', async () => {
        const doc = (await request(app.getHttpServer()).get('/docs-json').expect(200)).body;
        expect(Object.keys(doc.paths)).toEqual(expect.arrayContaining([TICK, '/dev/tick']));
      });
    });
  });
});
