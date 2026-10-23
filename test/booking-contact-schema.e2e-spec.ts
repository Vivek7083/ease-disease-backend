import { randomUUID } from 'node:crypto';
import { inspect } from 'node:util';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { CONSULTEE } from './helpers/booking-contact.js';
import { createTestPrisma, truncateAll } from './helpers/test-db.js';

/**
 * B0: the database itself enforces the booking form's contact columns (`consultee_*`) and the request-origin
 * columns (`created_ip`, `created_user_agent`). Real `_test` Postgres, no mocks. Every negative case also
 * checks WHICH constraint fired, so a test cannot pass because of some unrelated error.
 */
describe('booking contact columns and request-origin columns (real Postgres)', () => {
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

  const makeUserAndPackage = async () => {
    const [user, pkg] = await Promise.all([
      prisma.user.create({ data: { firebaseUid: `fb_${randomUUID()}`, email: 'p@example.com', authProvider: 'google.com', lastAuthProvider: 'google.com' } }),
      prisma.package.create({ data: { title: 'Pkg', description: ['a'], pricePaise: 150000, durationMinutes: 30 } }),
    ]);
    return { user, pkg };
  };

  let counter = 0;
  const bookingData = (userId: string, packageId: string) => ({
    reference: `ED-T${String(++counter).padStart(5, '0')}`,
    userId,
    packageId,
    packageTitle: 'Pkg',
    amountPaise: 150000,
    ...CONSULTEE,
    consentAt: new Date(),
  });

  /** Creates a booking with the given overrides on top of a valid one. */
  const createBooking = async (overrides: Record<string, unknown> = {}) => {
    const { user, pkg } = await makeUserAndPackage();
    return prisma.booking.create({ data: { ...bookingData(user.id, pkg.id), ...overrides } as never });
  };

  const makeTransaction = async (overrides: Record<string, unknown> = {}) => {
    const { user, pkg } = await makeUserAndPackage();
    const booking = await prisma.booking.create({ data: bookingData(user.id, pkg.id) });
    return prisma.transaction.create({
      data: { orderId: `EDTX${randomUUID().replace(/-/g, '').slice(0, 20)}`, bookingId: booking.id, userId: user.id, amountPaise: 150000, ...overrides } as never,
    });
  };

  /** The error must be raised by the database and must name the given constraint (or NOT NULL column). */
  const expectRejectedBy = async (attempt: Promise<unknown>, needle: string) => {
    let thrown: unknown;
    try {
      await attempt;
    } catch (error) {
      thrown = error;
    }
    expect(thrown, `expected the database to reject this (needle: ${needle})`).toBeDefined();
    expect(inspect(thrown, { depth: 8 })).toContain(needle);
  };

  describe('positive: valid rows are stored exactly', () => {
    it('round-trips every contact field and both origin fields on a booking', async () => {
      const booking = await createBooking({
        consulteeName: 'Priya Sharma',
        consulteeWhatsappNumber: '+14155552671',
        consulteeEmail: 'priya.s+diet@example.com',
        consulteeAge: 34,
        consulteeCity: 'Navi Mumbai',
        consulteeGender: 'Non binary',
        createdIp: '2001:0db8:85a3:0000:0000:8a2e:0370:7334',
        createdUserAgent: 'Mozilla/5.0 (X11; Linux x86_64)',
      });
      const read = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
      expect(read).toMatchObject({
        consulteeName: 'Priya Sharma',
        consulteeWhatsappNumber: '+14155552671',
        consulteeEmail: 'priya.s+diet@example.com',
        consulteeAge: 34,
        consulteeCity: 'Navi Mumbai',
        consulteeGender: 'Non binary',
        createdIp: '2001:0db8:85a3:0000:0000:8a2e:0370:7334',
        createdUserAgent: 'Mozilla/5.0 (X11; Linux x86_64)',
      });
      expect(typeof read.consulteeAge).toBe('number');
    });

    it('treats gender, created_ip and created_user_agent as optional (read back as null)', async () => {
      const booking = await createBooking();
      const read = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
      expect(read.consulteeGender).toBeNull();
      expect(read.createdIp).toBeNull();
      expect(read.createdUserAgent).toBeNull();
    });

    it('stores the optional consultee_dob (renamed from patient_dob) as a calendar date', async () => {
      const booking = await createBooking({ consulteeDob: new Date('1990-04-12') });
      const read = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
      expect(read.consulteeDob?.toISOString().slice(0, 10)).toBe('1990-04-12');
    });

    it('round-trips the origin columns on a transaction, and they are optional', async () => {
      const bare = await makeTransaction();
      expect(bare.createdIp).toBeNull();
      expect(bare.createdUserAgent).toBeNull();
      const full = await makeTransaction({ createdIp: '203.0.113.7', createdUserAgent: 'curl/8.4.0' });
      const read = await prisma.transaction.findUniqueOrThrow({ where: { id: full.id } });
      expect(read).toMatchObject({ createdIp: '203.0.113.7', createdUserAgent: 'curl/8.4.0' });
    });

    it.each([
      ['age 1 (lowest)', { consulteeAge: 1 }],
      ['age 119 (highest)', { consulteeAge: 119 }],
      ['a 2-character city', { consulteeCity: 'Pu' }],
      ['a 100-character city', { consulteeCity: 'c'.repeat(100) }],
      ['a 1-character gender', { consulteeGender: 'F' }],
      ['a 50-character gender', { consulteeGender: 'g'.repeat(50) }],
      ['a 45-character IP (longest IPv6 text)', { createdIp: 'x'.repeat(45) }],
      ['a 512-character user-agent', { createdUserAgent: 'u'.repeat(512) }],
      ['an email of exactly 50 characters', { consulteeEmail: `${'a'.repeat(38)}@example.com` }],
      ['an 8-digit international number (lowest)', { consulteeWhatsappNumber: '+12345678' }],
      ['a 15-digit international number (highest)', { consulteeWhatsappNumber: '+123456789012345' }],
      ['an Indian number', { consulteeWhatsappNumber: '+919876543210' }],
      ['a UK number', { consulteeWhatsappNumber: '+447911123456' }],
    ])('accepts %s', async (_label, overrides) => {
      const booking = await createBooking(overrides);
      expect(await prisma.booking.count({ where: { id: booking.id } })).toBe(1);
    });
  });

  describe('negative: required columns (NOT NULL)', () => {
    // Raw SQL on purpose: through Prisma a missing field is rejected by the client before it reaches Postgres.
    const insertRaw = async (nullColumn: string) => {
      const { user, pkg } = await makeUserAndPackage();
      const values: Record<string, unknown> = {
        id: randomUUID(),
        reference: 'ED-RAW001',
        user_id: user.id,
        package_id: pkg.id,
        package_title: 'Pkg',
        amount_paise: 150000,
        consent_at: new Date(),
        updated_at: new Date(),
        consultee_name: 'Priya Sharma',
        consultee_whatsapp_number: '+919876543210',
        consultee_email: 'priya@example.com',
        consultee_age: 34,
        consultee_city: 'Pune',
      };
      values[nullColumn] = null;
      const columns = Object.keys(values);
      const casts: Record<string, string> = { id: '::uuid', user_id: '::uuid', package_id: '::uuid', consent_at: '::timestamptz', updated_at: '::timestamptz' };
      const placeholders = columns.map((c, i) => `$${i + 1}${casts[c] ?? ''}`);
      return prisma.$executeRawUnsafe(
        `INSERT INTO bookings (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`,
        ...columns.map((c) => (values[c] instanceof Date ? (values[c] as Date).toISOString() : values[c])),
      );
    };

    it('the raw insert used below is valid when no column is nulled (so the failures are real)', async () => {
      expect(await insertRaw('consultee_gender')).toBe(1);
      expect(await prisma.booking.count()).toBe(1);
    });

    it.each(['consultee_name', 'consultee_whatsapp_number', 'consultee_email', 'consultee_age', 'consultee_city'])(
      'rejects a booking whose %s is NULL',
      async (column) => {
        await expectRejectedBy(insertRaw(column), column);
        expect(await prisma.booking.count()).toBe(0);
      },
    );
  });

  describe('negative: bookings CHECK constraints', () => {
    it.each([
      ['age 0', { consulteeAge: 0 }, 'bookings_consultee_age_range'],
      ['age 120', { consulteeAge: 120 }, 'bookings_consultee_age_range'],
      ['age -1', { consulteeAge: -1 }, 'bookings_consultee_age_range'],
      ['a 1-character city', { consulteeCity: 'P' }, 'bookings_consultee_city_shape'],
      ['a 101-character city', { consulteeCity: 'c'.repeat(101) }, 'bookings_consultee_city_shape'],
      ['a city with a leading space', { consulteeCity: ' Pune' }, 'bookings_consultee_city_shape'],
      ['a city with a trailing space', { consulteeCity: 'Pune ' }, 'bookings_consultee_city_shape'],
      ['an empty gender (not-given must be NULL)', { consulteeGender: '' }, 'bookings_consultee_gender_shape'],
      ['a gender with a leading space', { consulteeGender: ' F' }, 'bookings_consultee_gender_shape'],
      ['a 51-character gender', { consulteeGender: 'g'.repeat(51) }, 'bookings_consultee_gender_shape'],
      ['a 46-character IP', { createdIp: 'x'.repeat(46) }, 'bookings_created_ip_length'],
      ['an empty IP', { createdIp: '' }, 'bookings_created_ip_length'],
      ['a 513-character user-agent', { createdUserAgent: 'u'.repeat(513) }, 'bookings_created_user_agent_length'],
      ['an empty user-agent', { createdUserAgent: '' }, 'bookings_created_user_agent_length'],
    ])('rejects %s', async (_label, overrides, constraint) => {
      await expectRejectedBy(createBooking(overrides), constraint);
      expect(await prisma.booking.count()).toBe(0);
    });

    it.each([
      ['no plus sign', '919876543210'],
      ['a leading zero after the plus', '+0919876543210'],
      ['a space inside', '+91 9876543210'],
      ['a space at the start', ' +919876543210'],
      ['dashes', '+91-98765-43210'],
      ['letters', '+9198765abcde'],
      ['7 digits (too short)', '+1234567'],
      ['16 digits (too long)', '+1234567890123456'],
      ['a plus alone', '+'],
      ['an empty string', ''],
      ['a trailing newline', '+919876543210\n'],
    ])('rejects a WhatsApp number with %s', async (_label, number) => {
      await expectRejectedBy(createBooking({ consulteeWhatsappNumber: number }), 'bookings_consultee_whatsapp_number_e164');
      expect(await prisma.booking.count()).toBe(0);
    });

    it.each([
      ['an upper-case letter', 'Priya@example.com'],
      ['a leading space', ' priya@example.com'],
      ['51 characters (over the PayU limit)', `${'a'.repeat(39)}@example.com`],
      ['no @', 'priya.example.com'],
      ['no dot after the @', 'priya@example'],
      ['a one-letter top-level domain', 'priya@example.c'],
      ['a pipe character (breaks the PayU hash string)', 'pri|ya@example.com'],
      ['a space inside', 'pri ya@example.com'],
      ['an empty string', ''],
    ])('rejects an email with %s', async (_label, email) => {
      await expectRejectedBy(createBooking({ consulteeEmail: email }), 'bookings_consultee_email_shape');
      expect(await prisma.booking.count()).toBe(0);
    });
  });

  describe('negative: transactions CHECK constraints', () => {
    it.each([
      ['a 46-character IP', { createdIp: 'x'.repeat(46) }, 'transactions_created_ip_length'],
      ['an empty IP', { createdIp: '' }, 'transactions_created_ip_length'],
      ['a 513-character user-agent', { createdUserAgent: 'u'.repeat(513) }, 'transactions_created_user_agent_length'],
      ['an empty user-agent', { createdUserAgent: '' }, 'transactions_created_user_agent_length'],
    ])('rejects %s', async (_label, overrides, constraint) => {
      await expectRejectedBy(makeTransaction(overrides), constraint);
      expect(await prisma.transaction.count()).toBe(0);
    });

    it('accepts the boundary lengths (45-character IP, 512-character user-agent)', async () => {
      const tx = await makeTransaction({ createdIp: 'x'.repeat(45), createdUserAgent: 'u'.repeat(512) });
      expect(await prisma.transaction.count({ where: { id: tx.id } })).toBe(1);
    });
  });

  describe('existing behaviour is untouched', () => {
    it('a payment-style status update on a booking still works (guarded updateMany)', async () => {
      const booking = await createBooking();
      const moved = await prisma.booking.updateMany({
        where: { id: booking.id, status: 'PENDING_PAYMENT' },
        data: { status: 'CONFIRMED', updatedAt: new Date() },
      });
      expect(moved.count).toBe(1);
    });
  });
});
