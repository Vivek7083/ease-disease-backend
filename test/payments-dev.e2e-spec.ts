import { createHash } from 'node:crypto';
import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppException } from '../src/common/exceptions/app.exception.js';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter.js';
import { RequestIdMiddleware } from '../src/common/middleware/request-id.middleware.js';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { PaymentsModule } from '../src/payments/payments.module.js';
import { PayuClient, PayuGatewayError, type PayuVerifyResult } from '../src/payments/payu/payu-client.js';
import { PayuCredentialsProvider } from '../src/payments/payu/payu-credentials.provider.js';
import { TXNID_PATTERN } from '../src/payments/payu/payu-txnid.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { seedPackage } from '../src/seed/seed-package.js';
import { setupSwaggerIfAllowed } from '../src/swagger.js';
import { AMOUNT_PAISE, CREDS } from './helpers/payu-fixtures.js';
import { createTestPrisma, truncateAll } from './helpers/test-db.js';

/**
 * P6c: the development-only PayU tooling over real HTTP, on the real `_test` Postgres. Only PayU is faked.
 */
const BASE = '/dev/payu';
const CALLBACK = '/v1/payments/payu/callback';
const sha512 = (text: string) => createHash('sha512').update(text, 'utf8').digest('hex');

describe('dev PayU tooling', () => {
  let prisma: PrismaClient;
  let app: NestExpressApplication;
  let payu: { verifyPayment: ReturnType<typeof vi.fn> };
  let credentials: { get: () => unknown };

  async function createApp(nodeEnv: string, swagger = false): Promise<void> {
    const values: Record<string, unknown> = {
      NODE_ENV: nodeEnv,
      FRONTEND_BASE_URL: 'https://easedisease.in',
      API_PUBLIC_URL: 'https://api.easedisease.in',
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

    const moduleRef = await Test.createTestingModule({ imports: [FakeInfraModule, PaymentsModule] })
      .overrideProvider(PayuClient)
      .useValue(payu)
      .overrideProvider(PayuCredentialsProvider)
      .useValue({ get: () => credentials.get(), status: () => ({ source: 'env', env: 'test', keyHint: '***' }) })
      .compile();

    app = moduleRef.createNestApplication<NestExpressApplication>();
    const requestId = new RequestIdMiddleware();
    app.use((req: never, res: never, next: never) => requestId.use(req, res, next));
    app.useGlobalFilters(new AllExceptionsFilter());
    if (swagger) setupSwaggerIfAllowed(app, 'development');
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
    await seedPackage(prisma);
    credentials = { get: () => CREDS };
    payu = { verifyPayment: vi.fn() };
  });
  afterEach(async () => {
    await app?.close();
  });

  const http = () => request(app.getHttpServer());
  const fixtureBooking = async (body: object = {}) => (await http().post(`${BASE}/fixture-booking`).send(body).expect(201)).body;

  describe.each(['production', 'staging', 'test'])('outside development (%s)', (nodeEnv) => {
    beforeEach(() => createApp(nodeEnv));

    it('every route is a 404 and nothing is created', async () => {
      const calls = [
        () => http().post(`${BASE}/fixture-booking`).send({}),
        () => http().post(`${BASE}/checkout-fields/ED-ABCDEF`),
        () => http().get(`${BASE}/checkout-page/ED-ABCDEF`),
        () => http().get(`${BASE}/bookings/ED-ABCDEF`),
        () => http().post(`${BASE}/verify/ED-ABCDEF`),
      ];
      for (const call of calls) {
        const res = await call().expect(404);
        expect(res.body.error.code).toBe('NOT_FOUND');
      }
      expect(await prisma.user.count()).toBe(0);
      expect(await prisma.booking.count()).toBe(0);
    });
  });

  describe('in development', () => {
    beforeEach(() => createApp('development', true));

    describe('POST /dev/payu/fixture-booking', () => {
      it('creates an unpaid booking priced from the launch package, for a user with a phone', async () => {
        const body = await fixtureBooking();

        expect(body).toMatchObject({ status: 'PENDING_PAYMENT', amountPaise: AMOUNT_PAISE, packageTitle: 'One-Time Consult' });
        expect(body.reference).toMatch(/^ED-[0-9A-HJKMNP-TV-Z]{6}$/);
        expect(body.next).toEqual([`POST ${BASE}/checkout-fields/${body.reference}`, `GET ${BASE}/checkout-page/${body.reference}`]);
        const booking = await prisma.booking.findUniqueOrThrow({ where: { reference: body.reference }, include: { user: true } });
        expect(booking.user.phone).toBe('+919876543210');
        expect(booking.user.email).toMatch(/^dev-[0-9a-hjkmnp-tv-z]{6}@example\.com$/);
        expect(booking.consentAt).toBeInstanceOf(Date);
      });

      it('accepts your own name, email and phone', async () => {
        const body = await fixtureBooking({ name: 'Asha Rao', email: 'asha@example.com', phone: '+919123456789' });
        const booking = await prisma.booking.findUniqueOrThrow({ where: { reference: body.reference }, include: { user: true } });
        expect(booking.user).toMatchObject({ name: 'Asha Rao', email: 'asha@example.com', phone: '+919123456789' });
        expect(booking).toMatchObject({
          consulteeName: 'Asha Rao',
          consulteeWhatsappNumber: '+919123456789',
          consulteeEmail: 'asha@example.com',
        });
      });

      it('every call is a separate user and booking with its own reference', async () => {
        const a = await fixtureBooking();
        const b = await fixtureBooking();
        expect(a.reference).not.toBe(b.reference);
        expect(a.userId).not.toBe(b.userId);
        expect(await prisma.user.count()).toBe(2);
      });

      it.each([
        ['an unknown key', { nope: 1 }],
        ['a too-short email', { email: 'a' }],
        ['an email longer than PayU allows', { email: `${'a'.repeat(45)}@example.com` }],
        ['an email PayU would reject', { email: 'not an email@example.com' }],
        ['a phone without a country code', { phone: '9876543210' }],
        ['a phone with spaces', { phone: '+91 98765 43210' }],
        ['an over-long name', { name: 'x'.repeat(101) }],
        ['a non-string phone', { phone: 123456 }],
      ])('rejects %s with a 400 naming the problem, and creates nothing', async (_name, body) => {
        const res = await http().post(`${BASE}/fixture-booking`).send(body).expect(400);
        expect(res.body.error).toMatchObject({ code: 'VALIDATION_FAILED', requestId: expect.any(String) });
        expect(await prisma.user.count()).toBe(0);
      });

      it('says what to do when there is no package yet (409)', async () => {
        await prisma.package.deleteMany();
        const res = await http().post(`${BASE}/fixture-booking`).send({}).expect(409);
        expect(res.body.error).toMatchObject({ code: 'NO_PACKAGE', message: expect.stringContaining('npm run seed') });
      });

      it('stores hostile text as plain data', async () => {
        const name = "'; DROP TABLE bookings; --";
        const body = await fixtureBooking({ name });
        expect((await prisma.booking.findUniqueOrThrow({ where: { reference: body.reference } })).consulteeName).toBe(name);
        expect(await prisma.booking.count()).toBe(1);
      });
    });

    describe('POST /dev/payu/checkout-fields/:reference', () => {
      it('returns the PayU form as JSON and creates the one transaction; repeating gives the identical form', async () => {
        const { reference } = await fixtureBooking();

        const first = (await http().post(`${BASE}/checkout-fields/${reference}`).expect(201)).body;
        const second = (await http().post(`${BASE}/checkout-fields/${reference}`).expect(201)).body;

        expect(second).toEqual(first);
        expect(first).toMatchObject({ method: 'POST', gatewayUrl: 'https://test.payu.in/_payment' });
        expect(first.fields).toMatchObject({ udf1: reference, amount: '2499.00', phone: '9876543210', key: 'test_key' });
        expect(first.fields.txnid).toMatch(TXNID_PATTERN);
        expect(await prisma.transaction.count()).toBe(1);
      });

      it('never returns the salt', async () => {
        const { reference } = await fixtureBooking();
        credentials.get = () => ({ ...CREDS, salt: 'TOP_SECRET_SALT_77' });
        const res = await http().post(`${BASE}/checkout-fields/${reference}`).expect(201);
        expect(res.text).not.toContain('TOP_SECRET_SALT_77');
      });

      it.each(['ED-NOSUCH1', 'x%00y', "'%20OR%20'1'='1", '%27%3B%20DROP%20TABLE%20bookings%3B--', 'A'.repeat(40)])(
        'an unknown or malformed reference (%s) is a plain 404',
        async (reference) => {
          const res = await http().post(`${BASE}/checkout-fields/${reference}`).expect(404);
          expect(res.body.error.code).toBe('BOOKING_NOT_FOUND');
        },
      );

      it('tells you when payments are not configured (503)', async () => {
        const { reference } = await fixtureBooking();
        credentials.get = () => {
          throw new AppException('PAYMENT_GATEWAY_UNAVAILABLE', 'Payment gateway is not configured', 503);
        };
        const res = await http().post(`${BASE}/checkout-fields/${reference}`).expect(503);
        expect(res.body.error.code).toBe('PAYMENT_GATEWAY_UNAVAILABLE');
        expect(await prisma.transaction.count()).toBe(0);
      });
    });

    describe('GET /dev/payu/checkout-page/:reference', () => {
      it('serves a page that posts the form to PayU, with a strict CSP whose nonce matches the script', async () => {
        const { reference } = await fixtureBooking();

        const res = await http().get(`${BASE}/checkout-page/${reference}`).expect(200);

        expect(res.headers['content-type']).toMatch(/^text\/html/);
        expect(res.headers['cache-control']).toBe('no-store');
        expect(res.headers['referrer-policy']).toBe('no-referrer');
        expect(res.headers['x-content-type-options']).toBe('nosniff');
        const transaction = await prisma.transaction.findFirstOrThrow();
        expect(res.text).toContain('<form id="payu" method="POST" action="https://test.payu.in/_payment">');
        expect(res.text).toContain(`<input type="hidden" name="txnid" value="${transaction.orderId}">`);
        expect(res.text).toContain(`<input type="hidden" name="udf1" value="${reference}">`);
        const nonce = /nonce="([^"]+)"/.exec(res.text)![1]!;
        expect(res.headers['content-security-policy']).toContain(`script-src 'nonce-${nonce}'`);
        expect(res.text).toContain(`<script nonce="${nonce}">document.getElementById('payu').submit();</script>`);
      });

      it('uses a fresh nonce on every response', async () => {
        const { reference } = await fixtureBooking();
        const nonceOf = async () => /nonce="([^"]+)"/.exec((await http().get(`${BASE}/checkout-page/${reference}`)).text)![1];
        expect(await nonceOf()).not.toBe(await nonceOf());
      });

      it('never contains the salt, and the page and the JSON form agree', async () => {
        const { reference } = await fixtureBooking();
        credentials.get = () => ({ ...CREDS, salt: 'TOP_SECRET_SALT_77' });
        const page = (await http().get(`${BASE}/checkout-page/${reference}`).expect(200)).text;
        const json = (await http().post(`${BASE}/checkout-fields/${reference}`).expect(201)).body;
        expect(page).not.toContain('TOP_SECRET_SALT_77');
        expect(page).toContain(`name="hash" value="${json.fields.hash}"`);
        expect(await prisma.transaction.count()).toBe(1);
      });

      it('shows PayU limit warnings to the developer', async () => {
        const { reference } = await fixtureBooking();
        const res = await http().get(`${BASE}/checkout-page/${reference}`).expect(200);
        expect(res.text).toContain('Heads-up');
        expect(res.text).toContain('52 characters');
      });

      it('an unknown reference is a JSON 404, not a blank page', async () => {
        const res = await http().get(`${BASE}/checkout-page/ED-NOSUCH1`).expect(404);
        expect(res.body.error.code).toBe('BOOKING_NOT_FOUND');
      });
    });

    describe('GET /dev/payu/bookings/:reference', () => {
      it('shows an untouched booking with no transaction yet', async () => {
        const { reference } = await fixtureBooking();
        const res = await http().get(`${BASE}/bookings/${reference}`).expect(200);
        expect(res.body.booking).toMatchObject({ reference, status: 'PENDING_PAYMENT', amountPaise: 249900 });
        expect(res.body.transaction).toBeNull();
        expect(res.body.outbox).toEqual([]);
      });

      it('an unknown or malformed reference is a 404', async () => {
        await http().get(`${BASE}/bookings/ED-NOSUCH1`).expect(404);
        await http().get(`${BASE}/bookings/x%00y`).expect(404);
      });

      it('tells the whole story of a payment: checkout, PayU\'s callback over HTTP, then the result', async () => {
        const { reference } = await fixtureBooking();
        const { fields } = (await http().post(`${BASE}/checkout-fields/${reference}`).expect(201)).body;

        // What PayU would post back, signed with the documented reverse hash.
        const reverse = ['test_salt', 'success', '', '', '', '', '', '', '', '', '', fields.udf1, fields.email, fields.firstname, fields.productinfo, fields.amount, fields.txnid, fields.key].join('|');
        const found: PayuVerifyResult = {
          outcome: 'found',
          txnid: fields.txnid,
          status: 'success',
          rawStatus: 'success',
          unmappedStatus: 'captured',
          amountPaise: 249900,
          mihpayid: '21564143078',
          mode: 'UPI',
          bankRefNum: '431998369241',
          errorCode: 'E000',
          errorMessage: 'NO ERROR',
        };
        payu.verifyPayment.mockResolvedValue(found);
        const callback = await http().post(CALLBACK).type('form').send({ ...fields, status: 'success', hash: sha512(reverse) }).expect(303);
        expect(callback.headers['location']).toBe(`https://easedisease.in/booking/${reference}`);

        const res = await http().get(`${BASE}/bookings/${reference}`).expect(200);
        expect(res.body.booking.status).toBe('CONFIRMED');
        expect(res.body.transaction).toMatchObject({ status: 'SUCCESS', orderId: fields.txnid, paymentMode: 'UPI', pgTxnId: '21564143078' });
        expect(res.body.transaction.events).toHaveLength(1);
        expect(res.body.transaction.events[0]).toMatchObject({ source: 'RETURN', hashValid: true, verification: { result: 'applied' } });
        expect(res.body.outbox.map((o: { type: string }) => o.type).sort()).toEqual(['BOOKING_CONFIRMATION', 'EXPERT_ALERT']);
      });
    });

    describe('POST /dev/payu/verify/:reference (read-only: what does PayU say right now?)', () => {
      const pending: PayuVerifyResult = {
        outcome: 'found',
        txnid: 'EDTX_PU_1792189780572ABCD',
        status: 'pending',
        rawStatus: 'pending',
        unmappedStatus: 'pending',
        amountPaise: 100,
        mihpayid: '20000059999',
        mode: 'UPI',
        bankRefNum: null,
        errorCode: null,
        errorMessage: null,
      };
      const checkedOut = async () => {
        const { reference } = await fixtureBooking();
        await http().post(`${BASE}/checkout-fields/${reference}`).expect(201);
        return { reference, orderId: (await prisma.transaction.findFirstOrThrow()).orderId };
      };

      it("returns PayU's answer for the booking's transaction and asks about exactly that txnid", async () => {
        const { reference, orderId } = await checkedOut();
        payu.verifyPayment.mockResolvedValue(pending);

        const res = await http().post(`${BASE}/verify/${reference}`).expect(200);

        expect(payu.verifyPayment).toHaveBeenCalledExactlyOnceWith(orderId);
        expect(res.body).toMatchObject({
          reference,
          orderId,
          ourTransactionStatus: 'INITIATED',
          ourBookingStatus: 'PENDING_PAYMENT',
          payu: { outcome: 'found', status: 'pending', unmappedStatus: 'pending', mihpayid: '20000059999' },
        });
      });

      it.each([
        ['a success', { ...pending, status: 'success', rawStatus: 'success', unmappedStatus: 'captured' }],
        ['a failure', { ...pending, status: 'failure', rawStatus: 'failure', unmappedStatus: 'failed' }],
        ['not found', { outcome: 'not_found' }],
      ] as const)('changes nothing, even when PayU says %s', async (_name, answer) => {
        const { reference } = await checkedOut();
        payu.verifyPayment.mockResolvedValue(answer);
        const before = { booking: await prisma.booking.findFirstOrThrow(), tx: await prisma.transaction.findFirstOrThrow() };

        await http().post(`${BASE}/verify/${reference}`).expect(200);

        expect(await prisma.booking.findFirstOrThrow()).toEqual(before.booking);
        expect(await prisma.transaction.findFirstOrThrow()).toEqual(before.tx);
        expect(await prisma.paymentEvent.count()).toBe(0);
        expect(await prisma.outbox.count()).toBe(0);
      });

      it('a booking with no transaction yet is a 409 that says what to do', async () => {
        const { reference } = await fixtureBooking();
        const res = await http().post(`${BASE}/verify/${reference}`).expect(409);
        expect(res.body.error).toMatchObject({ code: 'NO_TRANSACTION' });
        expect(payu.verifyPayment).not.toHaveBeenCalled();
      });

      it('PayU being unreachable is a 503, not a hang or a 500', async () => {
        const { reference } = await checkedOut();
        payu.verifyPayment.mockRejectedValue(new PayuGatewayError('verify_payment returned HTTP 503'));
        const res = await http().post(`${BASE}/verify/${reference}`).expect(503);
        expect(res.body.error).toMatchObject({ code: 'PAYMENT_GATEWAY_UNAVAILABLE', message: 'verify_payment returned HTTP 503' });
      });

      it('payments not configured is a 503 too', async () => {
        const { reference } = await checkedOut();
        payu.verifyPayment.mockRejectedValue(new AppException('PAYMENT_GATEWAY_UNAVAILABLE', 'Payment gateway is not configured', 503));
        await http().post(`${BASE}/verify/${reference}`).expect(503);
      });

      it.each(['ED-NOSUCH1', 'x%00y', "'%20OR%20'1'='1"])('an unknown or malformed reference (%s) is a 404 and PayU is not asked', async (reference) => {
        const res = await http().post(`${BASE}/verify/${reference}`).expect(404);
        expect(res.body.error.code).toBe('BOOKING_NOT_FOUND');
        expect(payu.verifyPayment).not.toHaveBeenCalled();
      });

      it('lets an unexpected error surface as an error instead of hiding it', async () => {
        const { reference } = await checkedOut();
        payu.verifyPayment.mockRejectedValue(new TypeError('bug'));
        await http().post(`${BASE}/verify/${reference}`).expect(500);
      });
    });

    it('lists the dev routes in Swagger, and none of them asks for a secret', async () => {
      const doc = (await http().get('/docs-json').expect(200)).body;
      expect(Object.keys(doc.paths)).toEqual(
        expect.arrayContaining([`${BASE}/fixture-booking`, `${BASE}/checkout-fields/{reference}`, `${BASE}/checkout-page/{reference}`, `${BASE}/bookings/{reference}`]),
      );
      const fixtureProps = Object.keys(doc.paths[`${BASE}/fixture-booking`].post.requestBody.content['application/json'].schema.properties);
      expect(fixtureProps).toEqual(['name', 'email', 'phone']);
    });
  });
});
