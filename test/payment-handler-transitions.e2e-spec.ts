import { AppException } from '../src/common/exceptions/app.exception.js';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { PaymentHandlerService, type HandleResult } from '../src/payments/payment-handler.service.js';
import { PayuClient, PayuGatewayError, type PayuVerifyResult } from '../src/payments/payu/payu-client.js';
import type { PayuCredentialsProvider } from '../src/payments/payu/payu-credentials.provider.js';
import { AMOUNT_PAISE, CREDS, REFERENCE, TXNID, createCheckoutFixture, signedPayload, type CheckoutFixtureOptions } from './helpers/payu-fixtures.js';
import { createTestPrisma, truncateAll } from './helpers/test-db.js';

/**
 * P4c: what the handler does with PayU's answer. PayU is faked; the database is the real `_test` Postgres.
 * Rules under test: PayU's verified answer (never the payload) decides; success -> CONFIRMED, failure -> FAILED,
 * pending changes no booking; every change is a guarded update, so replays and races write nothing twice.
 */
describe('PaymentHandlerService: transitions (real Postgres, PayU faked)', () => {
  let prisma: PrismaClient;
  let handler: PaymentHandlerService;
  let payu: { verifyPayment: ReturnType<typeof vi.fn> };
  const NOTES = 'Private symptom notes: bloating after meals';

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

  const fixture = (options?: CheckoutFixtureOptions) => createCheckoutFixture(prisma, { notes: NOTES, ...options });
  const handle = (payload: unknown = signedPayload(), source: 'RETURN' | 'WEBHOOK' | 'RECONCILE' = 'WEBHOOK'): Promise<HandleResult> =>
    handler.handle({ source, payload, sourceIp: '203.0.113.7' });
  const state = async () => ({
    booking: await prisma.booking.findFirstOrThrow(),
    tx: await prisma.transaction.findFirstOrThrow(),
    outbox: await prisma.outbox.findMany({ orderBy: { type: 'asc' } }),
    events: await prisma.paymentEvent.findMany({ orderBy: { receivedAt: 'asc' } }),
  });

  describe('success', () => {
    it('confirms the booking, records the payment, and queues exactly the two alerts', async () => {
      await fixture();

      const result = await handle();

      expect(result).toEqual({ outcome: 'applied', bookingReference: REFERENCE });
      const { booking, tx, outbox, events } = await state();
      expect(booking.status).toBe('CONFIRMED');
      expect(booking.holdExpiresAt).toBeNull();
      expect(tx).toMatchObject({
        status: 'SUCCESS',
        paymentMode: 'UPI',
        pgTxnId: '21564143078',
        bankRefNum: '431998369241',
        errorCode: null,
        errorMessage: null,
      });
      expect(tx.completedAt).toBeInstanceOf(Date);
      expect(outbox.map((o) => o.type)).toEqual(['BOOKING_CONFIRMATION', 'EXPERT_ALERT']);
      for (const row of outbox) {
        expect(row).toMatchObject({ status: 'PENDING', attempts: 0 });
        expect(row.payload).toEqual({ bookingId: booking.id, reference: REFERENCE, packageTitle: 'One-Time Consult', amountPaise: AMOUNT_PAISE });
      }
      expect(events).toHaveLength(1);
      expect(events[0]!.verification).toMatchObject({
        hash: { valid: true },
        payuVerify: { outcome: 'found', status: 'success', unmappedStatus: 'captured', amountPaise: AMOUNT_PAISE },
        checks: { referenceMatches: true, amountMatches: true },
        result: 'applied',
      });
    });

    it('never copies the patient notes (or any contact detail) into an outbox payload', async () => {
      await fixture();
      await handle();
      const text = JSON.stringify((await state()).outbox);
      expect(text).not.toContain('bloating');
      expect(text).not.toContain('notes');
      expect(text).not.toContain('priya@example.com');
    });

    it('works with the additional_charges hash variant', async () => {
      await fixture();
      expect((await handle(signedPayload({ additional_charges: '0.00' }))).outcome).toBe('applied');
      expect((await state()).booking.status).toBe('CONFIRMED');
    });

    it('asks PayU about the transaction named in the payload', async () => {
      await fixture();
      await handle();
      expect(payu.verifyPayment).toHaveBeenCalledExactlyOnceWith(TXNID);
    });

    it('uses PayU\'s answer, not the payload: a payload claiming failure still confirms when PayU says success', async () => {
      await fixture();
      expect((await handle(signedPayload({ status: 'failure' }))).outcome).toBe('applied');
      expect((await state()).tx.status).toBe('SUCCESS');
    });

    it('uses PayU\'s answer, not the payload: a payload claiming success changes nothing when PayU says failure', async () => {
      await fixture();
      payuSays(found({ status: 'failure', rawStatus: 'failure', errorCode: 'E4936', errorMessage: 'Bank was unable to authenticate.' }));
      expect((await handle(signedPayload({ status: 'success' }))).outcome).toBe('failed_payment');
      expect((await state()).booking.status).toBe('FAILED');
    });

    it('revives an EXPIRED booking: with no slots there is nothing to lose', async () => {
      await fixture({ bookingStatus: 'EXPIRED' });
      expect((await handle()).outcome).toBe('applied');
      const { booking, outbox } = await state();
      expect(booking.status).toBe('CONFIRMED');
      expect(outbox).toHaveLength(2);
    });

    it('confirms a booking that had been marked FAILED when PayU later reports success', async () => {
      await fixture({ bookingStatus: 'FAILED', transactionStatus: 'FAILURE' });
      expect((await handle()).outcome).toBe('applied');
      const { booking, tx, outbox } = await state();
      expect(booking.status).toBe('CONFIRMED');
      expect(tx.status).toBe('SUCCESS');
      expect(outbox).toHaveLength(2);
    });

    it('flags a payment that arrives for a CANCELLED booking for a human, with one admin alert', async () => {
      await fixture({ bookingStatus: 'CANCELLED' });
      expect((await handle()).outcome).toBe('applied');
      const { booking, tx, outbox } = await state();
      expect(tx.status).toBe('SUCCESS'); // the money did move
      expect(booking.status).toBe('NEEDS_ATTENTION');
      expect(outbox.map((o) => o.type)).toEqual(['ADMIN_ALERT']);
      expect(outbox[0]!.payload).toMatchObject({ reason: 'PAID_ON_CLOSED_BOOKING', bookingStatus: 'CANCELLED', reference: REFERENCE });

      // and a replay adds nothing
      expect((await handle()).outcome).toBe('duplicate');
      expect((await state()).outbox).toHaveLength(1);
    });
  });

  describe.each([
    ['failure', 'FAILURE'],
    ['cancelled', 'CANCELLED'],
  ] as const)('PayU says %s', (status, transactionStatus) => {
    it(`marks the transaction ${transactionStatus} and the booking FAILED, queues nothing`, async () => {
      await fixture();
      payuSays(found({ status, rawStatus: status, errorCode: 'E4936', errorMessage: 'Bank was unable to authenticate.', mihpayid: '99' }));

      const result = await handle();

      expect(result).toEqual({ outcome: 'failed_payment', bookingReference: REFERENCE });
      const { booking, tx, outbox } = await state();
      expect(booking.status).toBe('FAILED');
      expect(tx).toMatchObject({ status: transactionStatus, errorCode: 'E4936', errorMessage: 'Bank was unable to authenticate.', pgTxnId: '99' });
      expect(tx.completedAt).toBeInstanceOf(Date);
      expect(outbox).toHaveLength(0);
    });

    it('is a no-op when replayed', async () => {
      await fixture();
      payuSays(found({ status, rawStatus: status }));
      await handle();
      const first = await state();

      expect((await handle()).outcome).toBe('duplicate');
      const second = await state();

      expect(second.tx).toEqual(first.tx);
      expect(second.booking).toEqual(first.booking);
    });

    it('is not escalated when the failure carries a different amount (nothing was charged)', async () => {
      await fixture();
      payuSays(found({ status, rawStatus: status, amountPaise: 100 }));
      expect((await handle()).outcome).toBe('failed_payment');
      const { booking, outbox } = await state();
      expect(booking.status).toBe('FAILED');
      expect(outbox).toHaveLength(0);
    });
  });

  it('a late failure never undoes a success', async () => {
    await fixture();
    await handle();
    payuSays(found({ status: 'failure', rawStatus: 'failure' }));

    expect((await handle()).outcome).toBe('duplicate');

    const { booking, tx, outbox } = await state();
    expect(tx.status).toBe('SUCCESS');
    expect(booking.status).toBe('CONFIRMED');
    expect(outbox).toHaveLength(2);
  });

  describe('pending', () => {
    it('marks only the transaction PENDING; the booking is untouched', async () => {
      await fixture();
      payuSays(found({ status: 'pending', rawStatus: 'pending' }));

      expect(await handle()).toEqual({ outcome: 'pending', bookingReference: REFERENCE });

      const { booking, tx, outbox } = await state();
      expect(tx.status).toBe('PENDING');
      expect(booking.status).toBe('PENDING_PAYMENT');
      expect(outbox).toHaveLength(0);
    });

    it('a later success completes it, and a later pending cannot undo that', async () => {
      await fixture();
      payuSays(found({ status: 'pending', rawStatus: 'pending' }));
      await handle();
      payuSays(found());
      expect((await handle()).outcome).toBe('applied');
      payuSays(found({ status: 'pending', rawStatus: 'pending' }));
      await handle();

      const { booking, tx, outbox } = await state();
      expect(tx.status).toBe('SUCCESS');
      expect(booking.status).toBe('CONFIRMED');
      expect(outbox).toHaveLength(2);
    });

    it('a later failure after pending marks the booking FAILED', async () => {
      await fixture();
      payuSays(found({ status: 'pending', rawStatus: 'pending' }));
      await handle();
      payuSays(found({ status: 'failure', rawStatus: 'failure' }));
      expect((await handle()).outcome).toBe('failed_payment');
      expect((await state()).booking.status).toBe('FAILED');
    });
  });

  describe('amount mismatch (only matters for success)', () => {
    it('PayU success for a different amount: FAILURE + NEEDS_ATTENTION + one admin alert, refund reference kept', async () => {
      await fixture();
      payuSays(found({ amountPaise: 100, mihpayid: '777' }));

      const result = await handle();

      expect(result).toEqual({ outcome: 'mismatch', bookingReference: REFERENCE });
      const { booking, tx, outbox, events } = await state();
      expect(tx).toMatchObject({ status: 'FAILURE', errorCode: 'AMOUNT_MISMATCH', pgTxnId: '777' });
      expect(booking.status).toBe('NEEDS_ATTENTION');
      expect(outbox.map((o) => o.type)).toEqual(['ADMIN_ALERT']);
      expect(outbox[0]!.payload).toMatchObject({ reason: 'AMOUNT_MISMATCH', expectedPaise: AMOUNT_PAISE, paidPaise: 100 });
      expect(events[0]!.verification).toMatchObject({ checks: { referenceMatches: true, amountMatches: false }, result: 'mismatch' });
    });

    it('the signed payload amount differing from ours is a mismatch even if PayU reports our amount', async () => {
      await fixture();
      expect((await handle(signedPayload({ amount: '1.00' }))).outcome).toBe('mismatch');
      expect((await state()).booking.status).toBe('NEEDS_ATTENTION');
    });

    it('a malformed payload amount is a mismatch', async () => {
      await fixture();
      expect((await handle(signedPayload({ amount: 'lots' }))).outcome).toBe('mismatch');
    });

    it('a replayed mismatch writes no second alert and leaves the rows alone', async () => {
      await fixture();
      payuSays(found({ amountPaise: 100 }));
      await handle();
      const first = await state();

      expect((await handle()).outcome).toBe('duplicate');
      const second = await state();

      expect(second.outbox).toHaveLength(1);
      expect(second.tx).toEqual(first.tx);
      expect(second.booking).toEqual(first.booking);
    });

    it('a mismatch cannot unconfirm a booking that is already confirmed', async () => {
      await fixture();
      await handle();
      payuSays(found({ amountPaise: 100 }));
      expect((await handle()).outcome).toBe('duplicate');
      const { booking, tx } = await state();
      expect(booking.status).toBe('CONFIRMED');
      expect(tx.status).toBe('SUCCESS');
    });
  });

  describe('PayU cannot give a trustworthy answer: nothing changes, never confirms', () => {
    it.each([
      ['not found', async () => payuSays({ outcome: 'not_found' }), 'not_found_at_payu', { outcome: 'not_found' }],
      [
        'an unrecognised status',
        async () => payuSays(found({ status: 'unknown', rawStatus: 'somethingNew' })),
        'not_found_at_payu',
        { outcome: 'found', status: 'unknown', rawStatus: 'somethingNew' },
      ],
      [
        'a gateway error',
        async () => payu.verifyPayment.mockRejectedValue(new PayuGatewayError('verify_payment returned HTTP 503')),
        'gateway_error',
        { outcome: 'error', error: 'verify_payment returned HTTP 503' },
      ],
      [
        'credentials becoming unavailable inside the client',
        async () => payu.verifyPayment.mockRejectedValue(new AppException('PAYMENT_GATEWAY_UNAVAILABLE', 'Payment gateway is not configured', 503)),
        'gateway_error',
        { outcome: 'error', error: 'Payment gateway is not configured' },
      ],
    ])('%s', async (_name, arrange, expectedOutcome, expectedVerify) => {
      await fixture();
      await arrange();

      const result = await handle();

      expect(result).toEqual({ outcome: expectedOutcome, bookingReference: REFERENCE });
      const { booking, tx, outbox, events } = await state();
      expect(booking.status).toBe('PENDING_PAYMENT');
      expect(tx.status).toBe('INITIATED');
      expect(outbox).toHaveLength(0);
      expect(events).toHaveLength(1);
      expect(events[0]!.verification).toMatchObject({ payuVerify: expectedVerify, result: expectedOutcome });
    });

    it('lets an unexpected programming error surface instead of hiding it', async () => {
      await fixture();
      payu.verifyPayment.mockRejectedValue(new TypeError('bug'));
      await expect(handle()).rejects.toThrow('bug');
      const { booking, tx, events } = await state();
      expect(booking.status).toBe('PENDING_PAYMENT');
      expect(tx.status).toBe('INITIATED');
      expect(events).toHaveLength(1); // the event was stored before anything else happened
    });

    it('a signal that could not be processed can simply be retried and then succeeds', async () => {
      await fixture();
      payu.verifyPayment.mockRejectedValueOnce(new PayuGatewayError('timeout'));
      expect((await handle()).outcome).toBe('gateway_error');
      expect((await handle()).outcome).toBe('applied');
      expect((await state()).booking.status).toBe('CONFIRMED');
    });
  });

  describe('PayU is only asked about validly signed signals for transactions we know', () => {
    it.each([
      ['an unknown txnid', () => signedPayload({ txnid: 'EDTX01JBUNKNOWNTXN00001' })],
      ['a malformed payload', () => 'nope'],
      ['a tampered amount', () => ({ ...signedPayload(), amount: '1.00' })],
      ['a different booking reference', () => signedPayload({ udf1: 'ED-OTHER1' })],
    ])('is not called for %s', async (_name, payload) => {
      await fixture();
      await handle(payload());
      expect(payu.verifyPayment).not.toHaveBeenCalled();
    });

    it('is not called when credentials are unavailable', async () => {
      await fixture();
      const unconfigured = new PaymentHandlerService(
        prisma,
        {
          get: () => {
            throw new AppException('PAYMENT_GATEWAY_UNAVAILABLE', 'not configured', 503);
          },
        } as unknown as PayuCredentialsProvider,
        payu,
      );
      await unconfigured.handle({ source: 'WEBHOOK', payload: signedPayload(), sourceIp: null });
      expect(payu.verifyPayment).not.toHaveBeenCalled();
    });

    it('is called for every valid signal, duplicates included', async () => {
      await fixture();
      await handle(signedPayload(), 'RETURN');
      await handle(signedPayload(), 'WEBHOOK');
      await handle(signedPayload(), 'WEBHOOK');
      expect(payu.verifyPayment).toHaveBeenCalledTimes(3);
      expect(payu.verifyPayment).toHaveBeenCalledWith(TXNID);
    });
  });

  describe('replay and concurrency (the idempotency proof)', () => {
    it('handling the same successful signal again and again changes nothing after the first time', async () => {
      await fixture();
      expect((await handle()).outcome).toBe('applied');
      const first = await state();

      for (let i = 0; i < 3; i++) expect((await handle()).outcome).toBe('duplicate');
      const after = await state();

      expect(after.outbox).toHaveLength(2);
      expect(after.tx).toEqual(first.tx);
      expect(after.booking).toEqual(first.booking);
      expect(after.events).toHaveLength(4); // every signal is still logged
      for (const event of after.events) expect(event.verification).not.toBeNull();
    });

    it('eight parallel signals (browser return and webhook mixed) produce exactly one confirmation', async () => {
      await fixture();

      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) => handle(signedPayload(), i % 2 === 0 ? 'RETURN' : 'WEBHOOK')),
      );

      const outcomes = results.map((r) => r.outcome).sort();
      expect(outcomes.filter((o) => o === 'applied')).toHaveLength(1);
      expect(outcomes.filter((o) => o === 'duplicate')).toHaveLength(7);
      const { booking, tx, outbox, events } = await state();
      expect(booking.status).toBe('CONFIRMED');
      expect(tx.status).toBe('SUCCESS');
      expect(outbox.map((o) => o.type)).toEqual(['BOOKING_CONFIRMATION', 'EXPERT_ALERT']);
      expect(events).toHaveLength(8);
      for (const event of events) expect(event.verification).not.toBeNull();
    });

    it('eight parallel mismatches produce exactly one admin alert', async () => {
      await fixture();
      payuSays(found({ amountPaise: 100 }));

      const results = await Promise.all(Array.from({ length: 8 }, () => handle()));

      expect(results.filter((r) => r.outcome === 'mismatch')).toHaveLength(1);
      const { booking, outbox } = await state();
      expect(booking.status).toBe('NEEDS_ATTENTION');
      expect(outbox).toHaveLength(1);
    });

    it('a failure racing a success always ends as a confirmed booking: a success wins whatever the interleaving', async () => {
      await fixture();
      let call = 0;
      payu.verifyPayment.mockImplementation(async () =>
        call++ % 2 === 0 ? found({ status: 'failure', rawStatus: 'failure' }) : found(),
      );

      await Promise.all(Array.from({ length: 8 }, () => handle()));

      const { booking, tx, outbox } = await state();
      expect(tx.status).toBe('SUCCESS');
      expect(booking.status).toBe('CONFIRMED');
      expect(outbox.map((o) => o.type)).toEqual(['BOOKING_CONFIRMATION', 'EXPERT_ALERT']);
    });
  });

  describe('hostile PayU-side data is stored as data', () => {
    it('SQL text in PayU\'s own fields is bound as a parameter, never executed', async () => {
      await fixture();
      const sql = "'; DROP TABLE transactions; --";
      payuSays(found({ mode: sql, bankRefNum: sql, mihpayid: sql }));

      expect((await handle()).outcome).toBe('applied');

      const { tx } = await state();
      expect(tx).toMatchObject({ paymentMode: sql, bankRefNum: sql, pgTxnId: sql });
      expect(await prisma.transaction.count()).toBe(1);
    });
  });

  describe('with the real PayuClient and PayU-shaped JSON (the exact wire format, not our normalised result)', () => {
    const wire = (entry: Record<string, unknown>) => ({
      status: 1,
      msg: '1 out of 1 Transactions Fetched Successfully',
      transaction_details: {
        [TXNID]: { mihpayid: '21564143078', bank_ref_num: '431998369241', amt: '2499.00', txnid: TXNID, mode: 'UPI', error_code: 'E000', error_Message: 'NO ERROR', ...entry },
      },
    });
    const handlerWithWire = (entry: Record<string, unknown>) => {
      const client = new PayuClient(
        () => CREDS,
        async () => ({ status: 200, text: JSON.stringify(wire(entry)) }),
      );
      return new PaymentHandlerService(prisma, { get: () => CREDS } as unknown as PayuCredentialsProvider, client);
    };
    const run = (entry: Record<string, unknown>) =>
      handlerWithWire(entry).handle({ source: 'WEBHOOK', payload: signedPayload(), sourceIp: null });

    it.each([
      ['failed', 'failed'],
      ['failure', 'failed'],
      ['Failed', 'bounced'],
      ['failed', 'dropped'],
    ])('PayU status %j / unmappedstatus %j marks the transaction FAILURE and the booking FAILED', async (status, unmappedstatus) => {
      await fixture();
      const result = await run({ status, unmappedstatus });
      expect(result.outcome).toBe('failed_payment');
      const { booking, tx, outbox, events } = await state();
      expect(booking.status).toBe('FAILED');
      expect(tx.status).toBe('FAILURE');
      expect(outbox).toHaveLength(0);
      expect(events[0]!.verification).toMatchObject({ payuVerify: { status: 'failure', rawStatus: status, unmappedStatus: unmappedstatus } });
    });

    it('a user-cancelled payment reported as failed marks the transaction CANCELLED and the booking FAILED', async () => {
      await fixture();
      expect((await run({ status: 'failed', unmappedstatus: 'userCancelled' })).outcome).toBe('failed_payment');
      const { booking, tx } = await state();
      expect(tx.status).toBe('CANCELLED');
      expect(booking.status).toBe('FAILED');
    });

    it.each(['captured', 'auth'])('success with unmappedstatus %s confirms the booking and records it for audit', async (unmappedstatus) => {
      await fixture();
      expect((await run({ status: 'success', unmappedstatus })).outcome).toBe('applied');
      const { booking, events } = await state();
      expect(booking.status).toBe('CONFIRMED');
      expect(events[0]!.verification).toMatchObject({ payuVerify: { status: 'success', unmappedStatus: unmappedstatus } });
    });

    it('an unrecognised status still changes nothing', async () => {
      await fixture();
      expect((await run({ status: 'somethingNew', unmappedstatus: 'whatever' })).outcome).toBe('not_found_at_payu');
      const { booking, tx } = await state();
      expect(booking.status).toBe('PENDING_PAYMENT');
      expect(tx.status).toBe('INITIATED');
    });
  });

  describe('confirmed_at (the daily cap counts it)', () => {
    it('is set when a payment confirms the booking, and stays null before', async () => {
      await fixture();
      expect((await state()).booking.confirmedAt).toBeNull();
      await handle();
      const { booking, tx } = await state();
      expect(booking.confirmedAt).not.toBeNull();
      expect(booking.confirmedAt!.getTime()).toBe(tx.completedAt!.getTime());
    });

    it('is not moved by a replay or by the webhook after the browser return', async () => {
      await fixture();
      await handle(signedPayload(), 'RETURN');
      const first = (await state()).booking.confirmedAt;
      await new Promise((resolve) => setTimeout(resolve, 15));
      await handle(signedPayload(), 'WEBHOOK');
      await handle(signedPayload(), 'WEBHOOK');
      expect((await state()).booking.confirmedAt).toEqual(first);
    });

    it('is set when a late success revives a FAILED booking', async () => {
      await fixture({ bookingStatus: 'FAILED' });
      await handle();
      expect((await state()).booking.confirmedAt).not.toBeNull();
    });

    it.each([
      ['a failed payment', () => payuSays(found({ status: 'failure', rawStatus: 'failure' }))],
      ['an amount mismatch', () => payuSays(found({ amountPaise: AMOUNT_PAISE + 100 }))],
      ['a pending payment', () => payuSays(found({ status: 'pending', rawStatus: 'pending' }))],
    ])('stays null after %s', async (_label, arrange) => {
      await fixture();
      arrange();
      await handle();
      expect((await state()).booking.confirmedAt).toBeNull();
    });

    it('stays null when a payment arrives for a closed (CANCELLED) booking: it goes to NEEDS_ATTENTION', async () => {
      await fixture({ bookingStatus: 'CANCELLED' });
      await handle();
      const { booking } = await state();
      expect(booking.status).toBe('NEEDS_ATTENTION');
      expect(booking.confirmedAt).toBeNull();
    });
  });

});
