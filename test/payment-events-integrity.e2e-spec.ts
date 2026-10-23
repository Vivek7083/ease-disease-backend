import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { CONSULTEE } from './helpers/booking-contact.js';
import { createTestPrisma, truncateAll } from './helpers/test-db.js';

/**
 * P4a: the database itself enforces the payment-events audit log rules, the one-transaction-per-booking
 * rule, and knows the FAILED booking status. Real `_test` Postgres, no mocks.
 */
describe('payment events integrity and booking/transaction rules (real Postgres)', () => {
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

  const makeBooking = async (reference = 'ED-AAAAAA') => {
    const user = await prisma.user.create({
      data: { firebaseUid: `fb_${randomUUID()}`, email: 'p@example.com', authProvider: 'google.com', lastAuthProvider: 'google.com' },
    });
    const pkg = await prisma.package.create({ data: { title: 'Pkg', description: ['a'], pricePaise: 249900, durationMinutes: 30 } });
    return prisma.booking.create({
      data: { reference, userId: user.id, packageId: pkg.id, packageTitle: 'Pkg', amountPaise: 249900, ...CONSULTEE, consentAt: new Date() },
    });
  };
  const makeTransaction = (bookingId: string, userId: string, orderId = 'EDTX01JBTESTTXN000000001') =>
    prisma.transaction.create({ data: { orderId, bookingId, userId, amountPaise: 249900 } });
  const makeEvent = (transactionId: string | null = null) =>
    prisma.paymentEvent.create({
      data: { transactionId, source: 'WEBHOOK', hashValid: true, payload: { txnid: 'EDTX01JBTESTTXN000000001', status: 'success' } },
    });

  const verification = { hash: { valid: true, variant: 'standard' }, result: 'applied' };

  describe('one booking, one transaction', () => {
    it('rejects a second transaction for the same booking', async () => {
      const booking = await makeBooking();
      await makeTransaction(booking.id, booking.userId, 'EDTX01JBTESTTXN000000001');
      await expect(makeTransaction(booking.id, booking.userId, 'EDTX01JBTESTTXN000000002')).rejects.toThrow();
      expect(await prisma.transaction.count()).toBe(1);
    });

    it('lets two different bookings each have their own transaction', async () => {
      const a = await makeBooking('ED-AAAAAA');
      const b = await makeBooking('ED-BBBBBB');
      await makeTransaction(a.id, a.userId, 'EDTX01JBTESTTXN000000001');
      await makeTransaction(b.id, b.userId, 'EDTX01JBTESTTXN000000002');
      expect(await prisma.transaction.count()).toBe(2);
    });
  });

  describe('booking status FAILED', () => {
    it('is accepted and read back', async () => {
      const booking = await makeBooking();
      const updated = await prisma.booking.update({ where: { id: booking.id }, data: { status: 'FAILED' } });
      expect(updated.status).toBe('FAILED');
    });
  });

  describe('payment_events is append-only', () => {
    it('starts with verification null', async () => {
      expect((await makeEvent()).verification).toBeNull();
    });

    it('allows verification to be set once, and returns it unchanged', async () => {
      const event = await makeEvent();
      const updated = await prisma.paymentEvent.update({ where: { id: event.id }, data: { verification } });
      expect(updated.verification).toEqual(verification);
      expect(updated.payload).toEqual(event.payload);
    });

    it('rejects setting verification a second time, and clearing it', async () => {
      const event = await makeEvent();
      await prisma.paymentEvent.update({ where: { id: event.id }, data: { verification } });
      await expect(
        prisma.paymentEvent.update({ where: { id: event.id }, data: { verification: { result: 'changed' } } }),
      ).rejects.toThrow(/append-only/);
      await expect(
        prisma.paymentEvent.update({ where: { id: event.id }, data: { verification: { set: null } as never } }),
      ).rejects.toThrow(/append-only/);
      expect((await prisma.paymentEvent.findUniqueOrThrow({ where: { id: event.id } })).verification).toEqual(verification);
    });

    it.each([
      ['payload', { payload: { txnid: 'tampered' } }],
      ['source', { source: 'RETURN' }],
      ['hashValid', { hashValid: false }],
      ['receivedAt', { receivedAt: new Date('2020-01-01T00:00:00Z') }],
    ])('rejects changing %s, even together with a valid verification', async (_field, change) => {
      const event = await makeEvent();
      await expect(
        prisma.paymentEvent.update({ where: { id: event.id }, data: { ...change, verification } }),
      ).rejects.toThrow(/append-only/);
      const read = await prisma.paymentEvent.findUniqueOrThrow({ where: { id: event.id } });
      expect(read.payload).toEqual(event.payload);
      expect(read.source).toBe(event.source);
      expect(read.hashValid).toBe(event.hashValid);
      expect(read.verification).toBeNull();
    });

    describe('hash_valid is NULL only for RECONCILE events (unsigned source)', () => {
      const unsigned = (source: string) => prisma.paymentEvent.create({ data: { source, hashValid: null, payload: { txnid: 'T1' } } });

      it('accepts a RECONCILE event with no hash result, and lets its verification be set', async () => {
        const event = await unsigned('RECONCILE');
        expect(event.hashValid).toBeNull();
        const updated = await prisma.paymentEvent.update({ where: { id: event.id }, data: { verification } });
        expect(updated.hashValid).toBeNull();
        expect(updated.verification).toEqual(verification);
      });

      it.each(['RETURN', 'WEBHOOK', 'ANYTHING_ELSE'])('rejects a %s event with no hash result', async (source) => {
        await expect(unsigned(source)).rejects.toThrow();
        expect(await prisma.paymentEvent.count()).toBe(0);
      });

      it.each([true, false])('rejects turning a NULL hash result into %s after the fact', async (value) => {
        const event = await unsigned('RECONCILE');
        await expect(
          prisma.paymentEvent.update({ where: { id: event.id }, data: { hashValid: value, verification } }),
        ).rejects.toThrow(/append-only/);
        expect((await prisma.paymentEvent.findUniqueOrThrow({ where: { id: event.id } })).hashValid).toBeNull();
      });

      it('rejects blanking a recorded hash result to NULL', async () => {
        const event = await prisma.paymentEvent.create({ data: { source: 'RECONCILE', hashValid: true, payload: { txnid: 'T1' } } });
        await expect(
          prisma.paymentEvent.update({ where: { id: event.id }, data: { hashValid: null, verification } }),
        ).rejects.toThrow(/append-only/);
      });
    });

    it('rejects an update that changes only the payload', async () => {
      const event = await makeEvent();
      await expect(
        prisma.paymentEvent.update({ where: { id: event.id }, data: { payload: { txnid: 'tampered' } } }),
      ).rejects.toThrow(/append-only/);
    });

    it('rejects re-pointing an event at another transaction', async () => {
      const a = await makeBooking('ED-AAAAAA');
      const b = await makeBooking('ED-BBBBBB');
      const ta = await makeTransaction(a.id, a.userId, 'EDTX01JBTESTTXN000000001');
      const tb = await makeTransaction(b.id, b.userId, 'EDTX01JBTESTTXN000000002');
      const event = await makeEvent(ta.id);
      await expect(
        prisma.paymentEvent.update({ where: { id: event.id }, data: { transactionId: tb.id, verification } }),
      ).rejects.toThrow(/append-only/);
    });

    it('rejects DELETE', async () => {
      const event = await makeEvent();
      await expect(prisma.paymentEvent.delete({ where: { id: event.id } })).rejects.toThrow(/append-only/);
      expect(await prisma.paymentEvent.count()).toBe(1);
    });

    it('rejects a raw SQL UPDATE or DELETE as well (the rule is in the database, not in Prisma)', async () => {
      const event = await makeEvent();
      await expect(
        prisma.$executeRaw`UPDATE payment_events SET payload = '{"x":1}'::jsonb WHERE id = ${event.id}::uuid`,
      ).rejects.toThrow(/append-only/);
      await expect(prisma.$executeRaw`DELETE FROM payment_events WHERE id = ${event.id}::uuid`).rejects.toThrow(/append-only/);
      await expect(prisma.$executeRaw`DELETE FROM payment_events`).rejects.toThrow(/append-only/);
    });

    it('refuses to delete a transaction that has events (they are never detached)', async () => {
      const booking = await makeBooking();
      const tx = await makeTransaction(booking.id, booking.userId);
      await makeEvent(tx.id);
      await expect(prisma.transaction.delete({ where: { id: tx.id } })).rejects.toThrow();
      expect(await prisma.paymentEvent.count()).toBe(1);
    });

    describe('source IP of the inbound request', () => {
      const withIp = (sourceIp: string | null) =>
        prisma.paymentEvent.create({
          data: { source: 'WEBHOOK', hashValid: true, payload: { txnid: 'EDTX01JBTESTTXN000000001' }, sourceIp },
        });

      it.each(['203.0.113.7', '2001:db8::8a2e:370:7334', '::ffff:203.0.113.7', '2001:0db8:85a3:0000:0000:8a2e:0370:7334'])(
        'stores %s exactly',
        async (ip) => {
          const event = await withIp(ip);
          expect((await prisma.paymentEvent.findUniqueOrThrow({ where: { id: event.id } })).sourceIp).toBe(ip);
        },
      );

      it('allows null (reconcile events have no inbound request) and defaults to null', async () => {
        expect((await withIp(null)).sourceIp).toBeNull();
        expect((await makeEvent()).sourceIp).toBeNull();
      });

      it('rejects an empty or over-long value (45 characters is the longest IPv6 text form)', async () => {
        await expect(withIp('')).rejects.toThrow();
        await expect(withIp('1'.repeat(46))).rejects.toThrow();
        await withIp('1'.repeat(45));
      });

      it('stores hostile-looking text as plain data', async () => {
        const hostile = "'; DROP TABLE x;--";
        expect((await withIp(hostile)).sourceIp).toBe(hostile);
        expect(await prisma.paymentEvent.count()).toBe(1);
      });

      it('cannot be altered after the fact, nor filled in later, even with a valid verification', async () => {
        const stored = await withIp('203.0.113.7');
        await expect(
          prisma.paymentEvent.update({ where: { id: stored.id }, data: { sourceIp: '198.51.100.9', verification } }),
        ).rejects.toThrow(/append-only/);
        const unset = await withIp(null);
        await expect(
          prisma.paymentEvent.update({ where: { id: unset.id }, data: { sourceIp: '198.51.100.9', verification } }),
        ).rejects.toThrow(/append-only/);
        expect((await prisma.paymentEvent.findUniqueOrThrow({ where: { id: stored.id } })).sourceIp).toBe('203.0.113.7');
      });
    });

    it('still accepts events for unknown transactions (transaction_id null)', async () => {
      const event = await makeEvent(null);
      expect(event.transactionId).toBeNull();
    });
  });
});
