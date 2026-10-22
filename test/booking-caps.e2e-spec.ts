import { randomUUID } from 'node:crypto';
import type { VerifiedIdentity } from '../src/auth/identity-verifier.js';
import { istDayStart } from '../src/bookings/booking-day.js';
import { BookingsService, DAILY_CONFIRMED_LIMIT, PENDING_BOOKING_LIMIT } from '../src/bookings/bookings.service.js';
import { AppException } from '../src/common/exceptions/app.exception.js';
import type { BookingStatus, PrismaClient } from '../src/generated/prisma/client.js';
import { UsersService } from '../src/users/users.service.js';
import { CONSULTEE } from './helpers/booking-contact.js';
import { createTestPrisma, truncateAll } from './helpers/test-db.js';

const ORIGIN = { ip: null, userAgent: null };
/** 15:30 on 22 Oct 2026 in India. */
const NOON_IST = new Date('2026-10-22T10:00:00.000Z');

/**
 * B2: the two caps on creating a booking, against real Postgres. The service is driven directly with a fixed clock (so
 * "today in India" is exactly what each test says) and, for the concurrency tests, with many calls at once.
 */
describe('booking caps (real Postgres)', () => {
  let prisma: PrismaClient;
  let clock: Date;
  let packageId: string;
  let sequence: number;

  beforeAll(() => {
    prisma = createTestPrisma();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await truncateAll(prisma);
    clock = NOON_IST;
    sequence = 0;
    packageId = (await prisma.package.create({ data: { title: 'One-Time Consult', description: ['x'], pricePaise: 249900 } })).id;
  });

  const service = () => new BookingsService(prisma as never, new UsersService(prisma as never), () => clock);
  const newUser = (uid: string) => prisma.user.create({ data: { firebaseUid: uid, email: `${uid}@example.com`, authProvider: 'google.com', lastAuthProvider: 'google.com' } });
  const identityOf = (user: { firebaseUid: string; email: string }): VerifiedIdentity => ({ uid: user.firebaseUid, email: user.email, emailVerified: true, name: undefined, signInProvider: 'google.com' });
  const form = (over: Record<string, unknown> = {}) => ({ packageId, name: 'Priya Sharma', whatsappNumber: '+919876543210', email: 'priya@example.com', age: 34, city: 'Bengaluru', consent: true, ...over });
  const create = (user: { firebaseUid: string; email: string }, key = randomUUID()) => service().create(identityOf(user), key, form(), ORIGIN);

  /** Direct rows, as if earlier requests and payments had happened. */
  const seed = async (userId: string, count: number, status: BookingStatus, extra: { confirmedAt?: Date; createdAt?: Date } = {}) => {
    for (let i = 0; i < count; i++) {
      sequence += 1;
      await prisma.booking.create({
        data: { reference: `ED-S${String(sequence).padStart(5, '0')}`, userId, packageId, status, packageTitle: 'One-Time Consult', amountPaise: 249900, ...CONSULTEE, consentAt: new Date(), ...extra },
      });
    }
  };
  const errorOf = async (promise: Promise<unknown>): Promise<AppException> => {
    try {
      await promise;
    } catch (error) {
      expect(error).toBeInstanceOf(AppException);
      return error as AppException;
    }
    throw new Error('expected the call to be refused');
  };
  const rows = (userId?: string) => prisma.booking.count(userId ? { where: { userId } } : undefined);

  describe('pending cap: 5 unpaid bookings', () => {
    it('allows up to 5 pending and refuses the 6th with 409 TOO_MANY_PENDING_BOOKINGS (limit in details)', async () => {
      const user = await newUser('u1');
      for (let i = 0; i < PENDING_BOOKING_LIMIT; i++) await create(user);
      const error = await errorOf(create(user));
      expect(error).toMatchObject({ code: 'TOO_MANY_PENDING_BOOKINGS', details: { limit: 5 } });
      expect(error.getStatus()).toBe(409);
      expect(await rows()).toBe(5);
    });

    it('the 5th succeeds when 4 already exist', async () => {
      const user = await newUser('u1');
      await seed(user.id, 4, 'PENDING_PAYMENT');
      await create(user);
      expect(await rows()).toBe(5);
    });

    it.each(['CONFIRMED', 'FAILED', 'CANCELLED', 'EXPIRED', 'COMPLETED', 'NO_SHOW', 'NEEDS_ATTENTION'] as const)('a pending booking that becomes %s frees a slot', async (status) => {
      const user = await newUser('u1');
      await seed(user.id, 5, 'PENDING_PAYMENT');
      await errorOf(create(user));
      await prisma.booking.updateMany({ where: { reference: 'ED-S00001' }, data: { status } });
      await create(user);
      expect(await rows()).toBe(6);
    });

    it('has no time window: pending bookings months old still count', async () => {
      const user = await newUser('u1');
      await seed(user.id, 5, 'PENDING_PAYMENT', { createdAt: new Date('2026-07-01T00:00:00.000Z') });
      expect(await errorOf(create(user))).toMatchObject({ code: 'TOO_MANY_PENDING_BOOKINGS' });
    });

    it('is per person: another person is unaffected', async () => {
      const a = await newUser('a');
      const b = await newUser('b');
      await seed(a.id, 5, 'PENDING_PAYMENT');
      await errorOf(create(a));
      await create(b);
      expect(await rows(b.id)).toBe(1);
    });

    it('a refused create stores neither a booking nor a key, so the same key works once a slot frees', async () => {
      const user = await newUser('u1');
      await seed(user.id, 5, 'PENDING_PAYMENT');
      const key = randomUUID();
      await errorOf(create(user, key));
      expect(await prisma.idempotencyKey.count()).toBe(0);
      await prisma.booking.updateMany({ where: { reference: 'ED-S00001' }, data: { status: 'FAILED' } });
      const result = await create(user, key);
      expect(result.replayed).toBe(false);
    });

    it('a replay of a request that already created a booking is answered even when the person is now at the cap', async () => {
      const user = await newUser('u1');
      await seed(user.id, 4, 'PENDING_PAYMENT');
      const key = randomUUID();
      const first = await create(user, key);
      expect(await rows(user.id)).toBe(5);
      const again = await create(user, key);
      expect(again.replayed).toBe(true);
      expect(again.response).toEqual(first.response);
      expect(await errorOf(create(user))).toMatchObject({ code: 'TOO_MANY_PENDING_BOOKINGS' });
    });
  });

  describe('daily cap: 5 bookings confirmed today (India)', () => {
    const today = () => new Date(clock.getTime() - 3_600_000);

    it('allows the 5th creation after 4 confirmed today and refuses once 5 are confirmed (409 DAILY_BOOKING_LIMIT)', async () => {
      const user = await newUser('u1');
      await seed(user.id, 4, 'CONFIRMED', { confirmedAt: today() });
      await create(user);
      await seed(user.id, 1, 'CONFIRMED', { confirmedAt: today() });
      const error = await errorOf(create(user));
      expect(error).toMatchObject({ code: 'DAILY_BOOKING_LIMIT', details: { limit: DAILY_CONFIRMED_LIMIT } });
      expect(error.getStatus()).toBe(409);
    });

    it('bookings confirmed yesterday do not count', async () => {
      const user = await newUser('u1');
      await seed(user.id, 5, 'CONFIRMED', { confirmedAt: new Date(clock.getTime() - 24 * 3_600_000) });
      await create(user);
    });

    it.each(['COMPLETED', 'CANCELLED', 'NO_SHOW'] as const)('a booking confirmed today and later %s still counts for today', async (status) => {
      const user = await newUser('u1');
      await seed(user.id, 5, status, { confirmedAt: today() });
      expect(await errorOf(create(user))).toMatchObject({ code: 'DAILY_BOOKING_LIMIT' });
    });

    it('bookings that never reached CONFIRMED count toward neither cap (NEEDS_ATTENTION, FAILED, EXPIRED, CANCELLED before payment)', async () => {
      const user = await newUser('u1');
      await seed(user.id, 5, 'NEEDS_ATTENTION');
      await seed(user.id, 5, 'FAILED');
      await seed(user.id, 5, 'EXPIRED');
      await seed(user.id, 5, 'CANCELLED');
      await create(user);
    });

    it('is per person', async () => {
      const a = await newUser('a');
      const b = await newUser('b');
      await seed(a.id, 5, 'CONFIRMED', { confirmedAt: today() });
      await errorOf(create(a));
      await create(b);
    });

    it('the day resets at India midnight, not UTC midnight', async () => {
      const user = await newUser('u1');
      // 19:00 UTC on the 21st is 00:30 IST on the 22nd; 22:30 IST on the 21st is not "today".
      clock = new Date('2026-10-21T19:00:00.000Z');
      await seed(user.id, 5, 'CONFIRMED', { confirmedAt: new Date('2026-10-21T17:00:00.000Z') });
      await create(user);
      await seed(user.id, 5, 'CONFIRMED', { confirmedAt: new Date('2026-10-21T18:45:00.000Z') });
      expect(await errorOf(create(user))).toMatchObject({ code: 'DAILY_BOOKING_LIMIT' });
    });

    it.each([
      ['the last millisecond of yesterday (IST)', '2026-10-21T18:29:59.999Z', false],
      ['exactly 00:00 IST today', '2026-10-21T18:30:00.000Z', true],
      ['the last millisecond of today (IST)', '2026-10-22T18:29:59.999Z', true],
      ['exactly 00:00 IST tomorrow', '2026-10-22T18:30:00.000Z', false],
    ])('%s (%s) counts for today: %s', async (_label, confirmedAt, counts) => {
      const user = await newUser('u1');
      await seed(user.id, 5, 'CONFIRMED', { confirmedAt: new Date(confirmedAt) });
      if (counts) expect(await errorOf(create(user))).toMatchObject({ code: 'DAILY_BOOKING_LIMIT' });
      else await create(user);
    });

    it('the test clock and the day helper agree about what today is', () => {
      expect(istDayStart(NOON_IST).toISOString()).toBe('2026-10-21T18:30:00.000Z');
    });
  });

  describe('the two caps together', () => {
    it('are independent: 4 confirmed today do not stop pending bookings up to the pending cap', async () => {
      const user = await newUser('u1');
      await seed(user.id, 4, 'CONFIRMED', { confirmedAt: new Date(clock.getTime() - 3_600_000) });
      for (let i = 0; i < PENDING_BOOKING_LIMIT; i++) await create(user);
      expect(await errorOf(create(user))).toMatchObject({ code: 'TOO_MANY_PENDING_BOOKINGS' });
    });

    it('the pending cap is reported first when both are exceeded', async () => {
      const user = await newUser('u1');
      await seed(user.id, 5, 'PENDING_PAYMENT');
      await seed(user.id, 5, 'CONFIRMED', { confirmedAt: new Date(clock.getTime() - 3_600_000) });
      expect(await errorOf(create(user))).toMatchObject({ code: 'TOO_MANY_PENDING_BOOKINGS' });
    });

    it('the daily cap is reported when only it is exceeded, even with some pending', async () => {
      const user = await newUser('u1');
      await seed(user.id, 4, 'PENDING_PAYMENT');
      await seed(user.id, 5, 'CONFIRMED', { confirmedAt: new Date(clock.getTime() - 3_600_000) });
      expect(await errorOf(create(user))).toMatchObject({ code: 'DAILY_BOOKING_LIMIT' });
    });
  });

  describe('many requests at the same instant', () => {
    it('10 parallel creates at 4 pending give exactly one success and nine refusals, total 5', async () => {
      const user = await newUser('u1');
      await seed(user.id, 4, 'PENDING_PAYMENT');
      const results = await Promise.allSettled(Array.from({ length: 10 }, () => create(user)));
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const refused = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(refused).toHaveLength(9);
      for (const r of refused) expect(r.reason).toMatchObject({ code: 'TOO_MANY_PENDING_BOOKINGS' });
      expect(await rows(user.id)).toBe(5);
      expect(await prisma.idempotencyKey.count()).toBe(1);
    });

    it('10 parallel creates from nothing give exactly 5 successes and 5 refusals', async () => {
      const user = await newUser('u1');
      const results = await Promise.allSettled(Array.from({ length: 10 }, () => create(user)));
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(5);
      expect(await rows(user.id)).toBe(5);
    });

    it('two people at once do not block or count each other', async () => {
      const a = await newUser('a');
      const b = await newUser('b');
      const results = await Promise.allSettled([...Array.from({ length: 5 }, () => create(a)), ...Array.from({ length: 5 }, () => create(b))]);
      expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
      expect([await rows(a.id), await rows(b.id)]).toEqual([5, 5]);
    });

    it('parallel replays of one key never trip the cap and never duplicate', async () => {
      const user = await newUser('u1');
      await seed(user.id, 4, 'PENDING_PAYMENT');
      const key = randomUUID();
      const results = await Promise.all(Array.from({ length: 6 }, () => create(user, key)));
      expect(results.filter((r) => !r.replayed)).toHaveLength(1);
      expect(await rows(user.id)).toBe(5);
    });
  });
});
