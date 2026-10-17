import type { PrismaClient, TransactionStatus } from '../src/generated/prisma/client.js';
import { PaymentHandlerService } from '../src/payments/payment-handler.service.js';
import { PayuGatewayError, type PayuVerifyResult } from '../src/payments/payu/payu-client.js';
import type { PayuCredentialsProvider } from '../src/payments/payu/payu-credentials.provider.js';
import { RECONCILE_DEFAULT_BATCH_SIZE, ReconcileService } from '../src/payments/reconcile.service.js';
import { AMOUNT_PAISE, CREDS, createCheckoutFixture, signedPayload, snapshot } from './helpers/payu-fixtures.js';
import { createTestPrisma, truncateAll } from './helpers/test-db.js';

/**
 * R2: the reconcile sweep. Policy under test (owner decisions, 2026-10-17): ask PayU only about INITIATED / PENDING
 * transactions created 20 minutes to 24 hours ago; PayU's answer alone changes anything; NOTHING is ever expired or
 * failed from our side; a row older than 24 hours is simply not asked about. PayU is faked, the database is real.
 */
describe('ReconcileService.run (real Postgres, PayU faked)', () => {
  let prisma: PrismaClient;
  let handler: PaymentHandlerService;
  let sweep: ReconcileService;
  let answers: Map<string, () => Promise<PayuVerifyResult>>;
  let payu: { verifyPayment: ReturnType<typeof vi.fn> };

  // Must be in the real past: a check stamps updated_at with the real clock, which has to sort AFTER the fixtures' stamps.
  const NOW = new Date('2026-01-15T12:00:00.000Z');
  const MIN = 60_000;
  const HOUR = 60 * MIN;

  const found = (overrides: Partial<Extract<PayuVerifyResult, { outcome: 'found' }>> = {}): PayuVerifyResult => ({
    outcome: 'found',
    txnid: 'x',
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
  const CANCELLED = found({ status: 'cancelled', rawStatus: 'failure', unmappedStatus: 'userCancelled', errorCode: 'E1206', errorMessage: 'back button' });
  const PENDING = found({ status: 'pending', rawStatus: 'pending', unmappedStatus: 'pending' });
  const NOT_FOUND: PayuVerifyResult = { outcome: 'not_found' };

  let counter = 0;
  /** One booking + transaction, `ageMs` old at NOW. PayU answers `answer` for it (default: not found, i.e. nothing to apply). */
  const make = async (ageMs: number, status: TransactionStatus = 'INITIATED', answer: PayuVerifyResult = NOT_FOUND, updatedAtOffsetMs = 0) => {
    counter++;
    const txnid = `EDTX_RC_${String(counter).padStart(8, '0')}`;
    const reference = `ED-RC${String(counter).padStart(4, '0')}`;
    const created = await createCheckoutFixture(prisma, { reference, txnid, transactionStatus: status });
    const createdAt = new Date(NOW.getTime() - ageMs);
    await prisma.transaction.update({
      where: { id: created.transaction.id },
      data: { createdAt, updatedAt: new Date(createdAt.getTime() + updatedAtOffsetMs) },
    });
    answers.set(txnid, () => Promise.resolve(answer.outcome === 'found' ? { ...answer, txnid } : answer));
    return { txnid, reference, bookingId: created.booking.id, transactionId: created.transaction.id };
  };
  const asked = () => payu.verifyPayment.mock.calls.map((c) => c[0] as string).sort();
  const txStatus = async (txnid: string) => (await prisma.transaction.findUniqueOrThrow({ where: { orderId: txnid } })).status;
  const bookingStatus = async (reference: string) => (await prisma.booking.findUniqueOrThrow({ where: { reference } })).status;

  beforeAll(() => {
    prisma = createTestPrisma();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await truncateAll(prisma);
    counter = 0;
    answers = new Map();
    payu = {
      verifyPayment: vi.fn((txnid: string) => {
        const answer = answers.get(txnid);
        if (!answer) throw new Error(`test setup: no fake answer for ${txnid}`);
        return answer();
      }),
    };
    handler = new PaymentHandlerService(prisma, { get: () => CREDS } as unknown as PayuCredentialsProvider, payu);
    sweep = new ReconcileService(prisma, handler);
  });

  describe('the 20-minute rule', () => {
    it('skips a payment 19m59s old and asks about one exactly 20m00s old', async () => {
      const young = await make(20 * MIN - 1000);
      const ripe = await make(20 * MIN);

      const summary = await sweep.run({ now: NOW });

      expect(asked()).toEqual([ripe.txnid]);
      expect(summary.checked).toBe(1);
      expect(await txStatus(young.txnid)).toBe('INITIATED');
    });

    it('asks about both INITIATED and PENDING payments', async () => {
      const a = await make(30 * MIN, 'INITIATED');
      const b = await make(30 * MIN, 'PENDING');
      await sweep.run({ now: NOW });
      expect(asked()).toEqual([a.txnid, b.txnid].sort());
    });

    it.each(['CREATED', 'SUCCESS', 'FAILURE', 'CANCELLED', 'EXPIRED'] as const)('never asks about a %s transaction', async (status) => {
      await make(2 * HOUR, status);
      const summary = await sweep.run({ now: NOW });
      expect(payu.verifyPayment).not.toHaveBeenCalled();
      expect(summary.checked).toBe(0);
    });

    it('uses the real clock when no time is given: a payment created just now is not asked about', async () => {
      await createCheckoutFixture(prisma, { transactionStatus: 'INITIATED' });
      expect((await sweep.run()).checked).toBe(0);
      expect(payu.verifyPayment).not.toHaveBeenCalled();
    });
  });

  describe('the 24-hour polling window, and no expiry from our side', () => {
    it('still asks at 23h59m59s', async () => {
      const row = await make(24 * HOUR - 1000);
      await sweep.run({ now: NOW });
      expect(asked()).toEqual([row.txnid]);
    });

    it.each([
      ['exactly 24h', 24 * HOUR],
      ['25h', 25 * HOUR],
      ['30 days', 30 * 24 * HOUR],
    ])('does not ask about a payment %s old and writes nothing at all', async (_name, age) => {
      await make(age, 'INITIATED');
      await make(age, 'PENDING');
      const before = await snapshot(prisma);

      const summary = await sweep.run({ now: NOW });

      expect(payu.verifyPayment).not.toHaveBeenCalled();
      expect(summary.checked).toBe(0);
      expect(await snapshot(prisma)).toEqual(before);
      expect(await prisma.paymentEvent.count()).toBe(0);
    });

    it('never writes EXPIRED to a transaction or a booking, whatever PayU answers', async () => {
      await make(2 * HOUR, 'INITIATED', NOT_FOUND);
      await make(2 * HOUR, 'INITIATED', PENDING);
      await make(23 * HOUR, 'PENDING', found({ status: 'unknown', rawStatus: 'weird' }));
      await make(2 * HOUR, 'INITIATED', FAILURE);
      await make(2 * HOUR, 'INITIATED', found());
      await make(30 * HOUR, 'INITIATED', FAILURE);

      await sweep.run({ now: NOW });
      await sweep.run({ now: new Date(NOW.getTime() + 48 * HOUR) });

      expect(await prisma.transaction.count({ where: { status: 'EXPIRED' } })).toBe(0);
      expect(await prisma.booking.count({ where: { status: 'EXPIRED' } })).toBe(0);
    });

    it('leaves a payment that PayU never resolves exactly as it was, through the whole window and after it', async () => {
      const row = await make(21 * MIN, 'INITIATED', NOT_FOUND);
      for (const hours of [0, 6, 23]) await sweep.run({ now: new Date(NOW.getTime() + hours * HOUR) });
      await sweep.run({ now: new Date(NOW.getTime() + 25 * HOUR) });

      expect(await txStatus(row.txnid)).toBe('INITIATED');
      expect(await bookingStatus(row.reference)).toBe('PENDING_PAYMENT');
    });

    it('a webhook after the window still settles the row (the window only limits polling)', async () => {
      const row = await make(40 * HOUR, 'INITIATED', found());

      await sweep.run({ now: NOW });
      expect(await txStatus(row.txnid)).toBe('INITIATED');

      const result = await handler.handle({ source: 'WEBHOOK', payload: signedPayload({ txnid: row.txnid, udf1: row.reference }), sourceIp: '203.0.113.7' });
      expect(result.outcome).toBe('applied');
      expect(await txStatus(row.txnid)).toBe('SUCCESS');
      expect(await bookingStatus(row.reference)).toBe('CONFIRMED');
    });
  });

  describe('PayU decides, as soon as it says so', () => {
    it('failure -> transaction FAILURE and booking FAILED, nothing queued', async () => {
      const row = await make(25 * MIN, 'INITIATED', FAILURE);
      const summary = await sweep.run({ now: NOW });
      expect(summary).toMatchObject({ checked: 1, failed: 1 });
      expect(await txStatus(row.txnid)).toBe('FAILURE');
      expect(await bookingStatus(row.reference)).toBe('FAILED');
      expect(await prisma.outbox.count()).toBe(0);
    });

    it('cancelled -> transaction CANCELLED and booking FAILED', async () => {
      const row = await make(25 * MIN, 'INITIATED', CANCELLED);
      await sweep.run({ now: NOW });
      expect(await txStatus(row.txnid)).toBe('CANCELLED');
      expect(await bookingStatus(row.reference)).toBe('FAILED');
    });

    it('success -> CONFIRMED with exactly the two alerts', async () => {
      const row = await make(25 * MIN, 'PENDING', found());
      const summary = await sweep.run({ now: NOW });
      expect(summary).toMatchObject({ checked: 1, applied: 1 });
      expect(await txStatus(row.txnid)).toBe('SUCCESS');
      expect(await bookingStatus(row.reference)).toBe('CONFIRMED');
      expect((await prisma.outbox.findMany()).map((o) => o.type).sort()).toEqual(['BOOKING_CONFIRMATION', 'EXPERT_ALERT']);
    });

    it('success for a different amount -> NEEDS_ATTENTION and one admin alert', async () => {
      const row = await make(25 * MIN, 'INITIATED', found({ amountPaise: 100 }));
      const summary = await sweep.run({ now: NOW });
      expect(summary).toMatchObject({ checked: 1, mismatch: 1 });
      expect(await bookingStatus(row.reference)).toBe('NEEDS_ATTENTION');
      expect((await prisma.outbox.findMany()).map((o) => o.type)).toEqual(['ADMIN_ALERT']);
    });

    it('pending -> INITIATED becomes PENDING, booking untouched, asked again next run', async () => {
      const row = await make(25 * MIN, 'INITIATED', PENDING);
      expect(await sweep.run({ now: NOW })).toMatchObject({ checked: 1, pending: 1 });
      expect(await txStatus(row.txnid)).toBe('PENDING');
      expect(await bookingStatus(row.reference)).toBe('PENDING_PAYMENT');

      answers.set(row.txnid, () => Promise.resolve(found({ txnid: row.txnid })));
      expect(await sweep.run({ now: NOW })).toMatchObject({ checked: 1, applied: 1 });
      expect(await bookingStatus(row.reference)).toBe('CONFIRMED');
    });

    it('PayU not knowing the payment, or an unrecognised status, changes nothing but the event log', async () => {
      const a = await make(25 * MIN, 'INITIATED', NOT_FOUND);
      const b = await make(25 * MIN, 'INITIATED', found({ status: 'unknown', rawStatus: 'weird' }));
      const summary = await sweep.run({ now: NOW });
      expect(summary).toMatchObject({ checked: 2, notFound: 2 });
      for (const row of [a, b]) {
        expect(await txStatus(row.txnid)).toBe('INITIATED');
        expect(await bookingStatus(row.reference)).toBe('PENDING_PAYMENT');
      }
      expect(await prisma.paymentEvent.count({ where: { source: 'RECONCILE' } })).toBe(2);
    });

    it('a second run over a settled batch asks about nothing', async () => {
      await make(25 * MIN, 'INITIATED', FAILURE);
      await make(25 * MIN, 'INITIATED', found());
      await sweep.run({ now: NOW });
      payu.verifyPayment.mockClear();

      const again = await sweep.run({ now: NOW });

      expect(again.checked).toBe(0);
      expect(payu.verifyPayment).not.toHaveBeenCalled();
    });
  });

  describe('batches and fairness', () => {
    it('never asks about more than batchSize payments, oldest-checked first', async () => {
      const rows = [];
      for (let i = 0; i < 5; i++) rows.push(await make(2 * HOUR, 'INITIATED', NOT_FOUND, i * 1000));

      const summary = await sweep.run({ now: NOW, batchSize: 2 });

      expect(summary.checked).toBe(2);
      expect(asked()).toEqual([rows[0]!.txnid, rows[1]!.txnid].sort());
    });

    it('rotates: unresolved rows go to the back, so every row is reached over several runs', async () => {
      const rows = [];
      for (let i = 0; i < 5; i++) rows.push(await make(2 * HOUR, 'INITIATED', NOT_FOUND, i * 1000));
      const seen: string[][] = [];
      for (let run = 0; run < 3; run++) {
        payu.verifyPayment.mockClear();
        await sweep.run({ now: NOW, batchSize: 2 });
        seen.push(asked());
      }
      const t = rows.map((r) => r.txnid);
      expect(seen[0]).toEqual([t[0]!, t[1]!].sort());
      expect(seen[1]).toEqual([t[2]!, t[3]!].sort());
      expect(seen[2]).toEqual([t[4]!, t[0]!].sort());
    });

    it('defaults to a batch of 50', async () => {
      expect(RECONCILE_DEFAULT_BATCH_SIZE).toBe(50);
      for (let i = 0; i < 52; i++) await make(2 * HOUR, 'INITIATED', NOT_FOUND, i);
      expect((await sweep.run({ now: NOW })).checked).toBe(50);
    });

    it.each([0, -1, 1.5, 501, Number.NaN, Number.POSITIVE_INFINITY])('rejects batchSize %s without asking PayU', async (batchSize) => {
      await make(2 * HOUR);
      await expect(sweep.run({ now: NOW, batchSize })).rejects.toThrow(RangeError);
      expect(payu.verifyPayment).not.toHaveBeenCalled();
    });

    it('an empty queue is fine', async () => {
      expect(await sweep.run({ now: NOW })).toEqual({
        checked: 0,
        applied: 0,
        failed: 0,
        pending: 0,
        mismatch: 0,
        duplicate: 0,
        notFound: 0,
        errors: 0,
        stoppedOnGatewayError: false,
      });
    });
  });

  describe('failures along the way', () => {
    it('stops the batch when PayU cannot answer: nothing changes, nothing is touched, the rest waits for the next run', async () => {
      const rows = [];
      for (let i = 0; i < 3; i++) rows.push(await make(2 * HOUR, 'INITIATED', FAILURE, i * 1000));
      answers.set(rows[0]!.txnid, () => Promise.reject(new PayuGatewayError('timeout')));
      const before = await snapshot(prisma);
      const touched = await prisma.transaction.findMany({ orderBy: { orderId: 'asc' }, select: { orderId: true, updatedAt: true } });

      const summary = await sweep.run({ now: NOW });

      expect(summary).toMatchObject({ checked: 0, stoppedOnGatewayError: true });
      expect(asked()).toEqual([rows[0]!.txnid]);
      expect(await snapshot(prisma)).toEqual(before);
      expect(await prisma.transaction.findMany({ orderBy: { orderId: 'asc' }, select: { orderId: true, updatedAt: true } })).toEqual(touched);
      expect(await prisma.paymentEvent.count()).toBe(0);
    });

    it('keeps what it already did when PayU fails part-way', async () => {
      const first = await make(2 * HOUR, 'INITIATED', FAILURE, 0);
      const second = await make(2 * HOUR, 'INITIATED', FAILURE, 1000);
      answers.set(second.txnid, () => Promise.reject(new PayuGatewayError('503')));

      const summary = await sweep.run({ now: NOW });

      expect(summary).toMatchObject({ checked: 1, failed: 1, stoppedOnGatewayError: true });
      expect(await txStatus(first.txnid)).toBe('FAILURE');
      expect(await txStatus(second.txnid)).toBe('INITIATED');
    });

    it('one broken payment does not stop the others', async () => {
      const a = await make(2 * HOUR, 'INITIATED', FAILURE, 0);
      const b = await make(2 * HOUR, 'INITIATED', FAILURE, 1000);
      const c = await make(2 * HOUR, 'INITIATED', found(), 2000);
      answers.set(b.txnid, () => Promise.reject(new TypeError('boom')));

      const summary = await sweep.run({ now: NOW });

      expect(summary).toMatchObject({ checked: 2, failed: 1, applied: 1, errors: 1, stoppedOnGatewayError: false });
      expect(await txStatus(a.txnid)).toBe('FAILURE');
      expect(await txStatus(b.txnid)).toBe('INITIATED');
      expect(await txStatus(c.txnid)).toBe('SUCCESS');
    });
  });

  describe('races', () => {
    it('two sweeps over the same payments at once: one set of alerts, each payment settled once', async () => {
      await make(25 * MIN, 'INITIATED', found());
      await make(25 * MIN, 'INITIATED', found());
      await make(25 * MIN, 'INITIATED', FAILURE);

      const [a, b] = await Promise.all([sweep.run({ now: NOW }), sweep.run({ now: NOW })]);

      expect(a.applied + b.applied).toBe(2);
      expect(a.failed + b.failed).toBe(1);
      expect(await prisma.outbox.count()).toBe(4);
      expect(await prisma.transaction.count({ where: { status: 'SUCCESS' } })).toBe(2);
      expect(await prisma.booking.count({ where: { status: 'CONFIRMED' } })).toBe(2);
      expect(await prisma.booking.count({ where: { status: 'FAILED' } })).toBe(1);
    });

    it('a sweep racing a webhook for the same payment: one set of alerts', async () => {
      const row = await make(25 * MIN, 'INITIATED', found());
      await Promise.all([
        sweep.run({ now: NOW }),
        handler.handle({ source: 'WEBHOOK', payload: signedPayload({ txnid: row.txnid, udf1: row.reference }), sourceIp: '203.0.113.7' }),
      ]);
      expect(await prisma.outbox.count()).toBe(2);
      expect(await bookingStatus(row.reference)).toBe('CONFIRMED');
    });
  });
});
