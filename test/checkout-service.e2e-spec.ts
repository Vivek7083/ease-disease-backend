import { createHash } from 'node:crypto';
import { AppException } from '../src/common/exceptions/app.exception.js';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { CheckoutService } from '../src/payments/checkout.service.js';
import { PaymentHandlerService } from '../src/payments/payment-handler.service.js';
import type { PayuVerifyResult } from '../src/payments/payu/payu-client.js';
import type { PayuCredentialsProvider } from '../src/payments/payu/payu-credentials.provider.js';
import { TXNID_PATTERN, generateTxnid } from '../src/payments/payu/payu-txnid.js';
import { AMOUNT_PAISE, CREDS, REFERENCE, createBookingFixture, createCheckoutFixture, snapshot } from './helpers/payu-fixtures.js';
import { createTestPrisma, truncateAll } from './helpers/test-db.js';

/**
 * P6b: checkout against the real `_test` Postgres. Proves the money-relevant behaviour: the amount comes from the
 * booking, a repeat or double-click never creates a second transaction, and what we send can be confirmed by the
 * payment handler. Credentials are fake.
 */
describe('CheckoutService (real Postgres)', () => {
  let prisma: PrismaClient;
  let service: CheckoutService;
  let credentials: { get: () => unknown };
  let config: Record<string, unknown>;
  let nextTxnids: string[] | null;

  const sha512 = (text: string) => createHash('sha512').update(text, 'utf8').digest('hex');

  const makeService = () =>
    new CheckoutService(
      prisma,
      credentials as PayuCredentialsProvider,
      { get: (name: string) => config[name] } as never,
      () => (nextTxnids && nextTxnids.length > 0 ? nextTxnids.shift()! : generateTxnid()),
    );

  beforeAll(() => {
    prisma = createTestPrisma();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await truncateAll(prisma);
    credentials = { get: () => CREDS };
    config = { API_PUBLIC_URL: 'https://api.easedisease.in' };
    nextTxnids = null;
    service = makeService();
  });

  const checkout = (userId: string, bookingReference = REFERENCE) => service.createCheckout({ userId, bookingReference });
  const errorOf = async (promise: Promise<unknown>): Promise<AppException> => {
    try {
      await promise;
    } catch (error) {
      expect(error).toBeInstanceOf(AppException);
      return error as AppException;
    }
    throw new Error('expected the call to fail');
  };

  describe('first checkout', () => {
    it('creates exactly one INITIATED transaction with the booking\'s amount, and returns the PayU form', async () => {
      const { user, booking } = await createBookingFixture(prisma);

      const form = await checkout(user.id);

      const transactions = await prisma.transaction.findMany();
      expect(transactions).toHaveLength(1);
      expect(transactions[0]).toMatchObject({ status: 'INITIATED', bookingId: booking.id, userId: user.id, amountPaise: AMOUNT_PAISE, gateway: 'PAYU' });
      expect(transactions[0]!.orderId).toMatch(TXNID_PATTERN);
      expect(form.method).toBe('POST');
      expect(form.gatewayUrl).toBe('https://test.payu.in/_payment');
      expect(form.fields).toMatchObject({
        key: 'test_key',
        txnid: transactions[0]!.orderId,
        amount: '2499.00',
        productinfo: 'One-Time Consult',
        firstname: 'Priya',
        email: 'priya@example.com',
        phone: '9876543210',
        surl: 'https://api.easedisease.in/v1/payments/payu/callback',
        udf1: REFERENCE,
      });
    });

    it('the hash is the request hash over exactly what is sent', async () => {
      const { user } = await createBookingFixture(prisma);
      const { fields } = await checkout(user.id);
      const text = `test_key|${fields.txnid}|${fields.amount}|${fields.productinfo}|${fields.firstname}|${fields.email}|${fields.udf1}||||||||||test_salt`;
      expect(fields.hash).toBe(sha512(text));
    });

    it('changes nothing else: the booking stays PENDING_PAYMENT, no outbox, no events', async () => {
      const { user } = await createBookingFixture(prisma);
      const before = await snapshot(prisma);
      await checkout(user.id);
      const after = await snapshot(prisma);
      expect(after.bookingRows).toEqual(before.bookingRows);
      expect(after.users).toBe(before.users);
      expect(after.outbox).toBe(0);
      expect(await prisma.paymentEvent.count()).toBe(0);
    });

    it('takes the amount from the booking snapshot, not from the package price', async () => {
      const { user, pkg } = await createBookingFixture(prisma);
      await prisma.package.update({ where: { id: pkg.id }, data: { pricePaise: 100 } }); // price edited after booking
      const { fields } = await checkout(user.id);
      expect(fields.amount).toBe('2499.00');
      expect((await prisma.transaction.findFirstOrThrow()).amountPaise).toBe(AMOUNT_PAISE);
    });

    it('uses the booking\'s own package title, even if the package is renamed later', async () => {
      const { user, pkg } = await createBookingFixture(prisma);
      await prisma.package.update({ where: { id: pkg.id }, data: { title: 'Renamed Package' } });
      expect((await checkout(user.id)).fields.productinfo).toBe('One-Time Consult');
    });

    it('never puts the salt in the result', async () => {
      const { user } = await createBookingFixture(prisma);
      credentials.get = () => ({ ...CREDS, salt: 'TOP_SECRET_SALT_9' });
      expect(JSON.stringify(await checkout(user.id))).not.toContain('TOP_SECRET_SALT_9');
    });

    it('uses the live endpoint only when configured for live', async () => {
      const { user } = await createBookingFixture(prisma);
      credentials.get = () => ({ ...CREDS, env: 'live' });
      expect((await checkout(user.id)).gatewayUrl).toBe('https://secure.payu.in/_payment');
    });

    it('reports PayU\'s documented limits it may exceed (our production callback URL is 52 characters)', async () => {
      const { user } = await createBookingFixture(prisma);
      expect((await checkout(user.id)).warnings).toEqual([expect.stringContaining('52 characters')]);
    });

    it('falls back to the development API URL when none is configured', async () => {
      const { user } = await createBookingFixture(prisma);
      config = {};
      const form = await checkout(user.id);
      expect(form.fields.surl).toBe('http://localhost:3000/v1/payments/payu/callback');
    });
  });

  describe('repeat and double-click (idempotency)', () => {
    it('a repeat returns the identical form and creates no second transaction', async () => {
      const { user } = await createBookingFixture(prisma);
      const first = await checkout(user.id);
      const before = await prisma.transaction.findFirstOrThrow();

      const second = await checkout(user.id);
      const third = await checkout(user.id);

      expect(second).toEqual(first);
      expect(third).toEqual(first);
      expect(await prisma.transaction.count()).toBe(1);
      expect(await prisma.transaction.findFirstOrThrow()).toEqual(before); // untouched, not even updated_at
    });

    it('eight simultaneous first checkouts end with one transaction and the same txnid and form everywhere', async () => {
      const { user } = await createBookingFixture(prisma);

      const forms = await Promise.all(Array.from({ length: 8 }, () => checkout(user.id)));

      expect(await prisma.transaction.count()).toBe(1);
      const stored = await prisma.transaction.findFirstOrThrow();
      for (const form of forms) {
        expect(form.fields.txnid).toBe(stored.orderId);
        expect(form).toEqual(forms[0]);
      }
    });

    it('reuses a transaction that already exists in CREATED state', async () => {
      const { user, transaction } = await createCheckoutFixture(prisma, { txnid: 'EDTX_PU_1792200600123K7Q2', transactionStatus: 'CREATED' });
      expect((await checkout(user.id)).fields.txnid).toBe(transaction.orderId);
      expect(await prisma.transaction.count()).toBe(1);
    });

    it('reuses the stored txnid and amount even if a different generator would now give another id', async () => {
      const { user, transaction } = await createCheckoutFixture(prisma, { txnid: 'EDTX_PU_1792200600123K7Q2' });
      nextTxnids = ['EDTX_PU_1792200600999AAAA'];
      expect((await checkout(user.id)).fields.txnid).toBe(transaction.orderId);
      expect(nextTxnids).toHaveLength(1); // the generator was never consulted
    });
  });

  describe('txnid collisions', () => {
    it('retries with a fresh id when the generated one is already used by another booking', async () => {
      await createCheckoutFixture(prisma, { reference: 'ED-OTHER01', txnid: 'EDTX_PU_1792200600123AAAA' });
      const { user } = await createBookingFixture(prisma, { reference: REFERENCE });
      nextTxnids = ['EDTX_PU_1792200600123AAAA', 'EDTX_PU_1792200600124BBBB'];

      const form = await checkout(user.id);

      expect(form.fields.txnid).toBe('EDTX_PU_1792200600124BBBB');
      expect(await prisma.transaction.count()).toBe(2);
    });

    it('gives up with a plain error (not a hang or a duplicate) after five collisions', async () => {
      await createCheckoutFixture(prisma, { reference: 'ED-OTHER01', txnid: 'EDTX_PU_1792200600123AAAA' });
      const { user } = await createBookingFixture(prisma, { reference: REFERENCE });
      nextTxnids = Array.from({ length: 5 }, () => 'EDTX_PU_1792200600123AAAA');
      await expect(checkout(user.id)).rejects.toThrow(/unique txnid/);
      expect(await prisma.transaction.count()).toBe(1);
    });
  });

  describe('who may pay for what', () => {
    it('another user\'s booking and a non-existent reference give the identical 404, and create nothing', async () => {
      const { user: owner } = await createBookingFixture(prisma);
      const { user: stranger } = await createBookingFixture(prisma, { reference: 'ED-STRNGR1', userEmail: 'other@example.com' });

      const notYours = await errorOf(checkout(stranger.id, REFERENCE));
      const missing = await errorOf(checkout(owner.id, 'ED-NOSUCH1'));

      for (const error of [notYours, missing]) {
        expect(error).toMatchObject({ code: 'BOOKING_NOT_FOUND' });
        expect(error.getStatus()).toBe(404);
      }
      expect(notYours.message).toBe(missing.message);
      expect(await prisma.transaction.count()).toBe(0);
    });

    it.each(['CONFIRMED', 'FAILED', 'CANCELLED', 'EXPIRED', 'COMPLETED', 'NEEDS_ATTENTION', 'NO_SHOW'] as const)(
      'a %s booking is not payable (409), and nothing is created',
      async (bookingStatus) => {
        const { user } = await createBookingFixture(prisma, { bookingStatus });
        const error = await errorOf(checkout(user.id));
        expect(error).toMatchObject({ code: 'BOOKING_NOT_PAYABLE' });
        expect(error.getStatus()).toBe(409);
        expect(await prisma.transaction.count()).toBe(0);
      },
    );

    it.each(['SUCCESS', 'FAILURE', 'CANCELLED', 'PENDING', 'EXPIRED'] as const)(
      'a booking whose payment is already %s is not payable again, and its transaction is untouched',
      async (transactionStatus) => {
        const { user } = await createCheckoutFixture(prisma, { transactionStatus });
        const before = await prisma.transaction.findFirstOrThrow();
        const error = await errorOf(checkout(user.id));
        expect(error).toMatchObject({ code: 'BOOKING_NOT_PAYABLE', details: { reason: 'PAYMENT_ALREADY_STARTED', status: transactionStatus } });
        expect(await prisma.transaction.findFirstOrThrow()).toEqual(before);
      },
    );
  });

  describe('data that cannot be sent to PayU is refused before anything is written', () => {
    it('no phone: 409 PROFILE_INCOMPLETE', async () => {
      const { user } = await createBookingFixture(prisma, { userPhone: null });
      const error = await errorOf(checkout(user.id));
      expect(error).toMatchObject({ code: 'PROFILE_INCOMPLETE' });
      expect(error.getStatus()).toBe(409);
      expect(await prisma.transaction.count()).toBe(0);
    });

    it.each([
      ['a phone that is not an Indian mobile', { userPhone: '+14155550100' }, 'phone'],
      ['an email longer than PayU\'s 50 characters', { userEmail: `${'a'.repeat(45)}@example.com` }, 'email'],
      ['an email PayU cannot take', { userEmail: 'a|b@example.com' }, 'email'],
    ])('%s: 400 VALIDATION_FAILED naming the field', async (_name, options, field) => {
      const { user } = await createBookingFixture(prisma, options);
      const error = await errorOf(checkout(user.id));
      expect(error).toMatchObject({ code: 'VALIDATION_FAILED' });
      expect(error.getStatus()).toBe(400);
      expect((error.details as { fields: Record<string, string> }).fields).toHaveProperty(field);
      expect(await prisma.transaction.count()).toBe(0);
    });

    it('reports both problems at once', async () => {
      const { user } = await createBookingFixture(prisma, { userPhone: '12345', userEmail: 'nope' });
      const error = await errorOf(checkout(user.id));
      expect(Object.keys((error.details as { fields: object }).fields).sort()).toEqual(['email', 'phone']);
    });

    it('payments not configured: 503, and no transaction left behind', async () => {
      const { user } = await createBookingFixture(prisma);
      credentials.get = () => {
        throw new AppException('PAYMENT_GATEWAY_UNAVAILABLE', 'Payment gateway is not configured', 503);
      };
      const error = await errorOf(checkout(user.id));
      expect(error).toMatchObject({ code: 'PAYMENT_GATEWAY_UNAVAILABLE' });
      expect(error.getStatus()).toBe(503);
      expect(await prisma.transaction.count()).toBe(0);
    });

    it('a database failure while creating the transaction surfaces as an error and leaves nothing half-done', async () => {
      const { user } = await createBookingFixture(prisma);
      vi.spyOn(prisma.transaction, 'create').mockRejectedValueOnce(new Error('connection terminated'));
      await expect(checkout(user.id)).rejects.toThrow('connection terminated');
      vi.restoreAllMocks();
      expect(await prisma.transaction.count()).toBe(0);
      expect((await checkout(user.id)).fields.txnid).toMatch(TXNID_PATTERN); // and a retry works
    });
  });

  describe('hostile data', () => {
    it('a name and package title full of markup, pipes and SQL are cleaned, and the hash still verifies', async () => {
      const { user } = await createBookingFixture(prisma, {
        userName: "<script>alert(1)</script>'; DROP TABLE bookings; --",
        packageTitle: 'Consult | Plan <img src=x onerror=alert(1)>',
      });
      const { fields } = await checkout(user.id);
      expect(fields.firstname).toBe('script');
      expect(fields.productinfo).not.toMatch(/[|<>]/);
      const text = `test_key|${fields.txnid}|${fields.amount}|${fields.productinfo}|${fields.firstname}|${fields.email}|${fields.udf1}||||||||||test_salt`;
      expect(fields.hash).toBe(sha512(text));
      expect(await prisma.booking.count()).toBe(1);
    });

    it('a SQL-looking booking reference is just a reference that does not exist', async () => {
      const { user } = await createBookingFixture(prisma);
      for (const reference of ["' OR '1'='1", 'x"; DROP TABLE bookings;--', 'ED-1\u0000X', '%', '']) {
        expect(await errorOf(checkout(user.id, reference))).toMatchObject({ code: 'BOOKING_NOT_FOUND' });
      }
      expect(await prisma.booking.count()).toBe(1);
    });
  });

  describe('round trip with the payment handler (checkout -> PayU -> callback -> confirmed)', () => {
    const found = (txnid: string, status: 'success' | 'failure'): PayuVerifyResult => ({
      outcome: 'found',
      txnid,
      status,
      rawStatus: status,
      unmappedStatus: status === 'success' ? 'captured' : 'failed',
      amountPaise: AMOUNT_PAISE,
      mihpayid: '21564143078',
      mode: 'UPI',
      bankRefNum: '431998369241',
      errorCode: status === 'success' ? 'E000' : 'E4936',
      errorMessage: status === 'success' ? 'NO ERROR' : 'Bank was unable to authenticate.',
    });

    /** What PayU posts back: our own fields plus a status, signed the way PayU documents the reverse hash. */
    const payuResponse = (fields: Record<string, string>, status: string) => {
      const reverse = ['test_salt', status, '', '', '', '', '', '', '', '', '', fields.udf1, fields.email, fields.firstname, fields.productinfo, fields.amount, fields.txnid, fields.key].join('|');
      return { ...fields, status, hash: sha512(reverse) };
    };
    const handlerFor = (result: PayuVerifyResult) =>
      new PaymentHandlerService(prisma, { get: () => CREDS } as unknown as PayuCredentialsProvider, { verifyPayment: vi.fn().mockResolvedValue(result) });

    it('a successful payment confirms the booking and queues the two alerts', async () => {
      const { user } = await createBookingFixture(prisma);
      const { fields } = await checkout(user.id);

      const result = await handlerFor(found(fields.txnid!, 'success')).handle({
        source: 'RETURN',
        payload: payuResponse(fields, 'success'),
        sourceIp: null,
      });

      expect(result).toEqual({ outcome: 'applied', bookingReference: REFERENCE });
      expect((await prisma.booking.findFirstOrThrow()).status).toBe('CONFIRMED');
      expect((await prisma.transaction.findFirstOrThrow()).status).toBe('SUCCESS');
      expect(await prisma.outbox.count()).toBe(2);
    });

    it('a failed payment marks the booking FAILED, and the booking can then no longer be checked out', async () => {
      const { user } = await createBookingFixture(prisma);
      const { fields } = await checkout(user.id);

      await handlerFor(found(fields.txnid!, 'failure')).handle({ source: 'WEBHOOK', payload: payuResponse(fields, 'failure'), sourceIp: null });

      expect((await prisma.booking.findFirstOrThrow()).status).toBe('FAILED');
      expect(await errorOf(checkout(user.id))).toMatchObject({ code: 'BOOKING_NOT_PAYABLE' });
    });

    it('after a confirmed payment, checkout is refused', async () => {
      const { user } = await createBookingFixture(prisma);
      const { fields } = await checkout(user.id);
      await handlerFor(found(fields.txnid!, 'success')).handle({ source: 'RETURN', payload: payuResponse(fields, 'success'), sourceIp: null });
      expect(await errorOf(checkout(user.id))).toMatchObject({ code: 'BOOKING_NOT_PAYABLE' });
    });

    it('the same form submitted twice (double-click) is confirmed once', async () => {
      const { user } = await createBookingFixture(prisma);
      const [a, b] = await Promise.all([checkout(user.id), checkout(user.id)]);
      expect(b.fields.txnid).toBe(a.fields.txnid);
      const handler = handlerFor(found(a.fields.txnid!, 'success'));
      await handler.handle({ source: 'RETURN', payload: payuResponse(a.fields, 'success'), sourceIp: null });
      await handler.handle({ source: 'WEBHOOK', payload: payuResponse(b.fields, 'success'), sourceIp: null });
      expect(await prisma.outbox.count()).toBe(2);
    });
  });
});
