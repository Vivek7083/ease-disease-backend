import { AppException } from '../src/common/exceptions/app.exception.js';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { PaymentHandlerService } from '../src/payments/payment-handler.service.js';
import { PayuGatewayError, type PayuVerifyResult } from '../src/payments/payu/payu-client.js';
import type { PayuCredentialsProvider } from '../src/payments/payu/payu-credentials.provider.js';
import { AMOUNT_PAISE, CREDS, REFERENCE, TXNID, createCheckoutFixture, signedPayload, snapshot, type CheckoutFixtureOptions } from './helpers/payu-fixtures.js';
import { createTestPrisma, truncateAll } from './helpers/test-db.js';

/**
 * R1: the reconcile entry point. PayU's own (unsigned) verify_payment answer is the only input. It must end in
 * exactly the same database state as the signed paths for the same answer, and be just as replay- and race-safe.
 * PayU is faked; the database is the real `_test` Postgres.
 */
describe('PaymentHandlerService.reconcile (real Postgres, PayU faked)', () => {
  let prisma: PrismaClient;
  let handler: PaymentHandlerService;
  let payu: { verifyPayment: ReturnType<typeof vi.fn> };

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
  const payuSays = (result: PayuVerifyResult) => payu.verifyPayment.mockResolvedValue(result);

  beforeAll(() => {
    prisma = createTestPrisma();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await truncateAll(prisma);
    payu = { verifyPayment: vi.fn().mockResolvedValue(found()) };
    handler = new PaymentHandlerService(prisma, { get: () => CREDS } as unknown as PayuCredentialsProvider, payu);
  });

  const fixture = (options?: CheckoutFixtureOptions) => createCheckoutFixture(prisma, options);
  const events = () => prisma.paymentEvent.findMany({ orderBy: { receivedAt: 'asc' } });

  /** Business state only (no ids or timestamps), so two runs on freshly built fixtures can be compared. */
  const endState = async () => {
    const booking = await prisma.booking.findFirstOrThrow();
    const tx = await prisma.transaction.findFirstOrThrow();
    const outbox = await prisma.outbox.findMany({ orderBy: { type: 'asc' } });
    return {
      booking: { status: booking.status, holdExpiresAt: booking.holdExpiresAt },
      tx: {
        status: tx.status,
        paymentMode: tx.paymentMode,
        pgTxnId: tx.pgTxnId,
        bankRefNum: tx.bankRefNum,
        errorCode: tx.errorCode,
        errorMessage: tx.errorMessage,
        completed: tx.completedAt !== null,
      },
      outbox: outbox.map((o) => ({ type: o.type, status: o.status, payload: { ...(o.payload as object), bookingId: undefined } })),
    };
  };

  describe('same end state as the signed path, for every kind of PayU answer', () => {
    it.each<[string, PayuVerifyResult, string, string]>([
      ['success', found(), 'applied', 'applied'],
      ['failure', found({ status: 'failure', rawStatus: 'failure', errorCode: 'E4936', errorMessage: 'Bank was unable to authenticate.' }), 'failed_payment', 'failed_payment'],
      ['cancelled', found({ status: 'cancelled', rawStatus: 'failure', unmappedStatus: 'userCancelled', errorCode: 'E1206', errorMessage: 'Transaction interrupted by pressing back button' }), 'failed_payment', 'failed_payment'],
      ['pending', found({ status: 'pending', rawStatus: 'pending', unmappedStatus: 'pending' }), 'pending', 'pending'],
      ['amount mismatch', found({ amountPaise: 100 }), 'mismatch', 'mismatch'],
      ['unrecognised status', found({ status: 'unknown', rawStatus: 'weird' }), 'not_found_at_payu', 'not_found_at_payu'],
      ['unknown to PayU', { outcome: 'not_found' }, 'not_found_at_payu', 'not_found_at_payu'],
    ])('%s', async (_name, answer, viaHandle, viaReconcile) => {
      payuSays(answer);

      await fixture();
      expect((await handler.handle({ source: 'WEBHOOK', payload: signedPayload(), sourceIp: '203.0.113.7' })).outcome).toBe(viaHandle);
      const signed = await endState();

      await truncateAll(prisma);
      await fixture();
      const result = await handler.reconcile(TXNID);

      expect(result).toEqual({ outcome: viaReconcile, bookingReference: REFERENCE });
      expect(await endState()).toEqual(signed);
    });
  });

  describe('the stored event', () => {
    it('is an unsigned RECONCILE event: no hash result, no IP, only allowlisted answer fields, verification written once', async () => {
      await fixture();

      await handler.reconcile(TXNID);

      const [event, ...rest] = await events();
      expect(rest).toHaveLength(0);
      expect(event).toMatchObject({ source: 'RECONCILE', hashValid: null, sourceIp: null });
      expect(event!.transactionId).not.toBeNull();
      expect(event!.payload).toEqual({
        txnid: TXNID,
        mihpayid: '21564143078',
        status: 'success',
        unmappedstatus: 'captured',
        amount: '2499.00',
        mode: 'UPI',
        bank_ref_num: '431998369241',
        error: 'E000',
        error_Message: 'NO ERROR',
        _receivedFields: ['txnid', 'mihpayid', 'status', 'unmappedstatus', 'amount', 'mode', 'bank_ref_num', 'error', 'error_Message'],
      });
      expect(event!.verification).toMatchObject({
        hash: { valid: null, variant: null, reason: 'unsigned_source' },
        payuVerify: { outcome: 'found', status: 'success', unmappedStatus: 'captured', amountPaise: AMOUNT_PAISE },
        checks: { amountMatches: true },
        result: 'applied',
        handledAt: expect.any(String),
      });
      expect(event!.verification).not.toHaveProperty('checks.referenceMatches');
    });

    it('records PayU not knowing the transaction, with just the txnid', async () => {
      await fixture();
      payuSays({ outcome: 'not_found' });
      await handler.reconcile(TXNID);
      const [event] = await events();
      expect(event!.payload).toEqual({ txnid: TXNID, _receivedFields: ['txnid'] });
      expect(event!.verification).toMatchObject({ payuVerify: { outcome: 'not_found' }, result: 'not_found_at_payu' });
    });

    it('leaves out answer fields PayU did not send', async () => {
      await fixture();
      payuSays(found({ mihpayid: null, mode: null, bankRefNum: null, errorCode: null, errorMessage: null, unmappedStatus: null }));
      await handler.reconcile(TXNID);
      expect((await events())[0]!.payload).toEqual({ txnid: TXNID, status: 'success', amount: '2499.00', _receivedFields: ['txnid', 'status', 'amount'] });
    });
  });

  describe('what it asks PayU', () => {
    it('asks about exactly the transaction id it was given, once', async () => {
      await fixture();
      await handler.reconcile(TXNID);
      expect(payu.verifyPayment).toHaveBeenCalledExactlyOnceWith(TXNID);
    });

    it.each([
      ['an empty id', ''],
      ['a pipe (PayU multi-lookup)', 'EDTX01|EDTX02'],
      ['26 characters', 'E'.repeat(26)],
      ['a space', 'EDTX 01'],
      ['SQL text', "x'; DROP TABLE transactions; --"],
      ['a NUL character', 'EDTX01\u0000X'],
      ['a number', 5],
      ['null', null],
      ['undefined', undefined],
      ['an object', { $ne: TXNID }],
    ])('never calls PayU, writes nothing and reports unknown for %s', async (_name, bad) => {
      await fixture();
      const before = await snapshot(prisma);

      const result = await handler.reconcile(bad as string);

      expect(result).toEqual({ outcome: 'unknown_transaction', bookingReference: null });
      expect(payu.verifyPayment).not.toHaveBeenCalled();
      expect(await snapshot(prisma)).toEqual(before);
      expect(await prisma.paymentEvent.count()).toBe(0);
    });

    it('never calls PayU for a well-formed id that is not ours', async () => {
      await fixture();
      const result = await handler.reconcile('EDTX01JBUNKNOWNTXN00001');
      expect(result).toEqual({ outcome: 'unknown_transaction', bookingReference: null });
      expect(payu.verifyPayment).not.toHaveBeenCalled();
      expect(await prisma.paymentEvent.count()).toBe(0);
    });
  });

  describe('no trustworthy answer: nothing changes, nothing is written', () => {
    it.each([
      ['PayU unreachable', () => Promise.reject(new PayuGatewayError('timeout'))],
      ['credentials not configured', () => Promise.reject(new AppException('PAYMENT_GATEWAY_UNAVAILABLE', 'not configured', 503))],
    ])('%s', async (_name, fail) => {
      await fixture();
      const before = await snapshot(prisma);
      payu.verifyPayment.mockImplementation(fail);

      const result = await handler.reconcile(TXNID);

      expect(result).toEqual({ outcome: 'gateway_error', bookingReference: REFERENCE });
      expect(await snapshot(prisma)).toEqual(before);
      expect(await prisma.paymentEvent.count()).toBe(0);
    });

    it('lets an unexpected error (a bug) surface instead of hiding it as a gateway problem', async () => {
      await fixture();
      const before = await snapshot(prisma);
      payu.verifyPayment.mockRejectedValue(new TypeError('boom'));
      await expect(handler.reconcile(TXNID)).rejects.toThrow('boom');
      expect(await snapshot(prisma)).toEqual(before);
    });
  });

  describe('amount check (PayU\'s amount is the only amount available)', () => {
    it('escalates a success for a different amount: transaction FAILURE, booking NEEDS_ATTENTION, one admin alert, PayU id kept', async () => {
      await fixture();
      payuSays(found({ amountPaise: 100 }));

      expect((await handler.reconcile(TXNID)).outcome).toBe('mismatch');

      const tx = await prisma.transaction.findFirstOrThrow();
      expect(tx).toMatchObject({ status: 'FAILURE', errorCode: 'AMOUNT_MISMATCH', pgTxnId: '21564143078' });
      expect((await prisma.booking.findFirstOrThrow()).status).toBe('NEEDS_ATTENTION');
      const outbox = await prisma.outbox.findMany();
      expect(outbox.map((o) => o.type)).toEqual(['ADMIN_ALERT']);
      expect(outbox[0]!.payload).toMatchObject({ reason: 'AMOUNT_MISMATCH', expectedPaise: AMOUNT_PAISE, paidPaise: 100 });
    });
  });

  describe('replays and races', () => {
    it('a replay changes nothing more: one set of alerts, every answer logged', async () => {
      await fixture();
      const outcomes = [];
      for (let i = 0; i < 3; i++) outcomes.push((await handler.reconcile(TXNID)).outcome);

      expect(outcomes).toEqual(['applied', 'duplicate', 'duplicate']);
      expect((await prisma.outbox.findMany()).map((o) => o.type).sort()).toEqual(['BOOKING_CONFIRMATION', 'EXPERT_ALERT']);
      const logged = await events();
      expect(logged).toHaveLength(3);
      for (const event of logged) expect(event.verification).not.toBeNull();
    });

    it('8 parallel reconciles: exactly one applies, exactly one set of alerts', async () => {
      await fixture();
      const results = await Promise.all(Array.from({ length: 8 }, () => handler.reconcile(TXNID)));

      expect(results.filter((r) => r.outcome === 'applied')).toHaveLength(1);
      expect(results.filter((r) => r.outcome === 'duplicate')).toHaveLength(7);
      expect(await prisma.outbox.count()).toBe(2);
      expect((await prisma.booking.findFirstOrThrow()).status).toBe('CONFIRMED');
    });

    it('4 reconciles racing 4 webhooks: still exactly one set of alerts', async () => {
      await fixture();
      const results = await Promise.all([
        ...Array.from({ length: 4 }, () => handler.reconcile(TXNID)),
        ...Array.from({ length: 4 }, () => handler.handle({ source: 'WEBHOOK', payload: signedPayload(), sourceIp: '203.0.113.7' })),
      ]);

      expect(results.filter((r) => r.outcome === 'applied')).toHaveLength(1);
      expect(await prisma.outbox.count()).toBe(2);
      expect((await prisma.transaction.findFirstOrThrow()).status).toBe('SUCCESS');
    });

    it('8 parallel mismatches: exactly one admin alert', async () => {
      await fixture();
      payuSays(found({ amountPaise: 100 }));
      const results = await Promise.all(Array.from({ length: 8 }, () => handler.reconcile(TXNID)));
      expect(results.filter((r) => r.outcome === 'mismatch')).toHaveLength(1);
      expect(await prisma.outbox.count()).toBe(1);
    });

    it('a later failure answer never undoes a recorded success', async () => {
      await fixture();
      await handler.reconcile(TXNID);
      payuSays(found({ status: 'failure', rawStatus: 'failure' }));

      expect((await handler.reconcile(TXNID)).outcome).toBe('duplicate');

      expect((await prisma.transaction.findFirstOrThrow()).status).toBe('SUCCESS');
      expect((await prisma.booking.findFirstOrThrow()).status).toBe('CONFIRMED');
    });

    it('a pending answer is re-checked later and then settles: PENDING -> SUCCESS confirms the booking', async () => {
      await fixture();
      payuSays(found({ status: 'pending', rawStatus: 'pending' }));
      expect((await handler.reconcile(TXNID)).outcome).toBe('pending');
      expect((await prisma.transaction.findFirstOrThrow()).status).toBe('PENDING');
      expect((await prisma.booking.findFirstOrThrow()).status).toBe('PENDING_PAYMENT');

      payuSays(found());
      expect((await handler.reconcile(TXNID)).outcome).toBe('applied');
      expect((await prisma.transaction.findFirstOrThrow()).status).toBe('SUCCESS');
      expect((await prisma.booking.findFirstOrThrow()).status).toBe('CONFIRMED');
    });

    it.each(['CANCELLED', 'NEEDS_ATTENTION', 'EXPIRED'] as const)(
      'a failure answer records the failed payment but leaves a %s booking exactly as it is',
      async (bookingStatus) => {
        await fixture({ bookingStatus });
        payuSays(found({ status: 'failure', rawStatus: 'failure', errorCode: 'E4936', errorMessage: 'declined' }));

        expect((await handler.reconcile(TXNID)).outcome).toBe('failed_payment');

        expect((await prisma.transaction.findFirstOrThrow()).status).toBe('FAILURE');
        expect((await prisma.booking.findFirstOrThrow()).status).toBe(bookingStatus);
        expect(await prisma.outbox.count()).toBe(0);
      },
    );

    it('a failure answer settles a PENDING transaction: transaction FAILURE, booking FAILED', async () => {
      await fixture({ transactionStatus: 'PENDING' });
      payuSays(found({ status: 'failure', rawStatus: 'failure', errorCode: 'E4936', errorMessage: 'declined' }));
      expect((await handler.reconcile(TXNID)).outcome).toBe('failed_payment');
      expect((await prisma.transaction.findFirstOrThrow()).status).toBe('FAILURE');
      expect((await prisma.booking.findFirstOrThrow()).status).toBe('FAILED');
    });
  });
});
