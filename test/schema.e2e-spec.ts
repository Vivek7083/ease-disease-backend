import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { SEED_PACKAGE, SEED_PACKAGE_ID, seedPackage } from '../src/seed/seed-package.js';
import { CONSULTEE } from './helpers/booking-contact.js';
import { createTestPrisma, testDatabaseUrl, truncateAll } from './helpers/test-db.js';

/**
 * Runs against the real `_test` Postgres (migrated by test/global-setup.ts). These tests prove the
 * database itself enforces the rules the payment handler relies on, not just that Prisma accepts the models.
 */
describe('PayU spike schema (real Postgres)', () => {
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

  const makeUser = () =>
    prisma.user.create({ data: { firebaseUid: `fb_${randomUUID()}`, email: 'p@example.com', authProvider: 'google.com', lastAuthProvider: 'google.com' } });
  const makePackage = () =>
    prisma.package.create({ data: { title: 'Pkg', description: ['a'], pricePaise: 150000 } });
  const bookingData = (userId: string, packageId: string, reference = 'ED-AAAAAA') => ({
    reference,
    userId,
    packageId,
    packageTitle: 'Pkg',
    amountPaise: 150000,
    ...CONSULTEE,
    consentAt: new Date(),
  });
  const makeBooking = async (reference?: string) => {
    const [user, pkg] = await Promise.all([makeUser(), makePackage()]);
    return prisma.booking.create({ data: bookingData(user.id, pkg.id, reference) });
  };
  const transactionData = (bookingId: string, userId: string, orderId = 'EDTX01JBTESTTXN000000001') => ({
    orderId,
    bookingId,
    userId,
    amountPaise: 150000,
  });

  describe('uniqueness', () => {
    it('rejects a duplicate booking reference', async () => {
      const booking = await makeBooking('ED-DUPLIC');
      await expect(prisma.booking.create({ data: bookingData(booking.userId, booking.packageId, 'ED-DUPLIC') })).rejects.toThrow();
      expect(await prisma.booking.count()).toBe(1);
    });

    it('rejects a duplicate transaction order_id (PayU txnid)', async () => {
      // Two different bookings, so only the order_id can be the reason for the rejection.
      const first = await makeBooking('ED-FIRST01');
      const second = await makeBooking('ED-SECOND1');
      await prisma.transaction.create({ data: transactionData(first.id, first.userId) });
      await expect(prisma.transaction.create({ data: transactionData(second.id, second.userId) })).rejects.toThrow();
      expect(await prisma.transaction.count()).toBe(1);
    });
  });

  describe('foreign keys', () => {
    it('rejects a booking for a missing package or user', async () => {
      const user = await makeUser();
      const pkg = await makePackage();
      await expect(prisma.booking.create({ data: bookingData(user.id, randomUUID()) })).rejects.toThrow();
      await expect(prisma.booking.create({ data: bookingData(randomUUID(), pkg.id) })).rejects.toThrow();
    });

    it('rejects a transaction for a missing booking', async () => {
      const user = await makeUser();
      await expect(prisma.transaction.create({ data: transactionData(randomUUID(), user.id) })).rejects.toThrow();
    });

    it('refuses to delete a booking that has a transaction', async () => {
      const booking = await makeBooking();
      await prisma.transaction.create({ data: transactionData(booking.id, booking.userId) });
      await expect(prisma.booking.delete({ where: { id: booking.id } })).rejects.toThrow();
    });
  });

  describe('CHECK constraints', () => {
    it('rejects negative amounts and prices', async () => {
      const booking = await makeBooking();
      await expect(prisma.package.create({ data: { title: 'x', description: [], pricePaise: -1 } })).rejects.toThrow();
      await expect(
        prisma.booking.create({ data: { ...bookingData(booking.userId, booking.packageId, 'ED-NEG001'), amountPaise: -1 } }),
      ).rejects.toThrow();
      await expect(
        prisma.transaction.create({ data: { ...transactionData(booking.id, booking.userId), amountPaise: -1 } }),
      ).rejects.toThrow();
    });

    it('accepts zero amounts', async () => {
      const booking = await makeBooking();
      await prisma.transaction.create({ data: { ...transactionData(booking.id, booking.userId), amountPaise: 0 } });
    });

    it.each([
      ['an object', { a: 1 }],
      ['a string', 'point'],
      ['a number', 5],
    ])('rejects a package description that is %s (must be an array)', async (_name, description) => {
      await expect(prisma.package.create({ data: { title: 'x', description, pricePaise: 1 } })).rejects.toThrow();
    });

    it('accepts an empty array and an array of strings, and returns it unchanged', async () => {
      const empty = await prisma.package.create({ data: { title: 'e', description: [], pricePaise: 1 } });
      const points = await prisma.package.create({ data: { title: 'p', description: ['one', 'two'], pricePaise: 1 } });
      expect(empty.description).toEqual([]);
      expect(points.description).toEqual(['one', 'two']);
    });
  });

  describe('enums', () => {
    it('rejects an unknown booking or transaction status at the database level', async () => {
      const booking = await makeBooking();
      await expect(
        prisma.$executeRaw`UPDATE bookings SET status = 'BOGUS'::booking_status WHERE id = ${booking.id}::uuid`,
      ).rejects.toThrow();
      await expect(
        prisma.$executeRaw`INSERT INTO transactions (id, order_id, booking_id, user_id, amount_paise, status, updated_at)
          VALUES (${randomUUID()}::uuid, 'EDTXBOGUS', ${booking.id}::uuid, ${booking.userId}::uuid, 1, 'BOGUS'::transaction_status, now())`,
      ).rejects.toThrow();
    });

    it('defaults: booking PENDING_PAYMENT, transaction CREATED, package active', async () => {
      const booking = await makeBooking();
      const tx = await prisma.transaction.create({ data: transactionData(booking.id, booking.userId) });
      expect(booking.status).toBe('PENDING_PAYMENT');
      expect(tx.status).toBe('CREATED');
      expect((await makePackage()).isActive).toBe(true);
    });
  });

  describe('payment_events', () => {
    it('accepts a null transaction (unknown txnid) and round-trips the raw payload', async () => {
      const payload = { txnid: 'EDTXUNKNOWN', status: 'success', nested: { a: [1, 2] } };
      const event = await prisma.paymentEvent.create({ data: { source: 'WEBHOOK', hashValid: false, payload } });
      expect(event.transactionId).toBeNull();
      expect(event.payload).toEqual(payload);
    });
  });

  describe('seed', () => {
    it('creates exactly one package, even when run repeatedly', async () => {
      await seedPackage(prisma);
      await seedPackage(prisma);
      const all = await prisma.package.findMany();
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({
        id: SEED_PACKAGE_ID,
        title: SEED_PACKAGE.title,
        description: ['3-week plan.', 'Understand your underlying root cause.'],
        pricePaise: 249900,
        isActive: true,
      });
    });

    it('does not overwrite later edits when re-run', async () => {
      await seedPackage(prisma);
      await prisma.package.update({ where: { id: SEED_PACKAGE_ID }, data: { title: 'Edited', pricePaise: 99900 } });
      await seedPackage(prisma);
      expect(await prisma.package.findUniqueOrThrow({ where: { id: SEED_PACKAGE_ID } })).toMatchObject({
        title: 'Edited',
        pricePaise: 99900,
      });
    });
  });

  describe('timestamps are timestamptz and keep the exact instant', () => {
    it('no column in the public schema is a zone-less timestamp', async () => {
      const rows = await prisma.$queryRaw<{ table_name: string; column_name: string }[]>`
        SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND data_type = 'timestamp without time zone'`;
      expect(rows).toEqual([]);
    });

    it('round-trips a Date to the same instant', async () => {
      const when = new Date('2026-10-17T01:30:00.123Z');
      const user = await makeUser();
      const pkg = await makePackage();
      const booking = await prisma.booking.create({
        data: { ...bookingData(user.id, pkg.id), consentAt: when, holdExpiresAt: when, scheduledAt: when },
      });
      const read = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
      expect(read.consentAt.toISOString()).toBe('2026-10-17T01:30:00.123Z');
      expect(read.holdExpiresAt?.toISOString()).toBe('2026-10-17T01:30:00.123Z');
      expect(read.scheduledAt?.toISOString()).toBe('2026-10-17T01:30:00.123Z');
    });

    it('reads as the same instant from a session set to Asia/Kolkata or UTC', async () => {
      const when = new Date('2026-10-17T23:59:59.999Z');
      const user = await makeUser();
      const pkg = await makePackage();
      await prisma.booking.create({ data: { ...bookingData(user.id, pkg.id), consentAt: when } });

      const client = new pg.Client({ connectionString: testDatabaseUrl() });
      await client.connect();
      try {
        for (const zone of ['Asia/Kolkata', 'UTC', 'America/Los_Angeles']) {
          await client.query(`SET TIME ZONE '${zone}'`);
          const { rows } = await client.query<{ ms: string }>(
            'SELECT (extract(epoch FROM consent_at) * 1000)::bigint AS ms FROM bookings',
          );
          expect(Number(rows[0]!.ms)).toBe(when.getTime());
        }
      } finally {
        await client.end();
      }
    });

    it('keeps a calendar date of birth as a plain date (no shifting by zone)', async () => {
      const user = await makeUser();
      const pkg = await makePackage();
      const booking = await prisma.booking.create({
        data: { ...bookingData(user.id, pkg.id), consulteeDob: new Date('1990-04-12') },
      });
      const read = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
      expect(read.consulteeDob?.toISOString().slice(0, 10)).toBe('1990-04-12');
    });
  });

  it('has applied every migration cleanly', async () => {
    const rows = await prisma.$queryRaw<{ migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }[]>`
      SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY migration_name`;
    expect(rows.map((r) => r.migration_name)).toEqual(
      expect.arrayContaining(['20261016184453_init_users', '20261016201711_payu_spike_schema']),
    );
    expect(rows.every((r) => r.finished_at !== null && r.rolled_back_at === null)).toBe(true);
  });
});
