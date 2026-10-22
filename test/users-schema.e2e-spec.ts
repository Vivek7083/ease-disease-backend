import { randomUUID } from 'node:crypto';
import { inspect } from 'node:util';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { createTestPrisma, truncateAll } from './helpers/test-db.js';

/**
 * S2d migration: `users.last_auth_provider` and the backstop CHECKs on users. Real `_test` Postgres. Every negative
 * case also checks WHICH constraint fired, so a test cannot pass because of an unrelated error.
 */
describe('users columns and CHECK constraints (real Postgres)', () => {
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

  const createUser = (overrides: Record<string, unknown> = {}) =>
    prisma.user.create({
      data: { firebaseUid: `fb_${randomUUID()}`, email: 'priya@example.com', authProvider: 'google.com', lastAuthProvider: 'google.com', ...overrides } as never,
    });

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

  /** A lower-case email of exactly `length` characters. */
  const emailOfLength = (length: number) => `${'a'.repeat(length - '@example.com'.length)}@example.com`;

  describe('positive', () => {
    it('stores both provider labels independently', async () => {
      const user = await createUser({ authProvider: 'google.com', lastAuthProvider: 'emailLink' });
      const read = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(read).toMatchObject({ authProvider: 'google.com', lastAuthProvider: 'emailLink' });
    });

    it.each([
      ['the shortest allowed email (3 characters)', 'a@b'],
      ['a plus-addressed lower-case email', 'priya.s+diet@example.com'],
      ['an email of exactly 254 characters', emailOfLength(254)],
    ])('accepts %s', async (_label, email) => {
      const user = await createUser({ email });
      expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).email).toBe(email);
    });

    it('still allows two accounts with the same email (the token is the identity, not the email)', async () => {
      await createUser();
      await expect(createUser()).resolves.toBeDefined();
      expect(await prisma.user.count()).toBe(2);
    });
  });

  describe('negative: email', () => {
    it.each([
      ['an upper-case letter', 'Priya@example.com'],
      ['a leading space', ' priya@example.com'],
      ['a trailing space', 'priya@example.com '],
    ])('refuses %s (users_email_normalized_chk)', async (_label, email) => {
      await expectRejectedBy(createUser({ email }), 'users_email_normalized_chk');
    });

    it.each([
      ['an empty email', ''],
      ['a 2-character email', 'a@'],
    ])('refuses %s (users_email_length_chk)', async (_label, email) => {
      await expectRejectedBy(createUser({ email }), 'users_email_length_chk');
    });

    it('refuses a 255-character email (users_email_length_chk)', async () => {
      const email = emailOfLength(255);
      expect(email.length).toBe(255);
      await expectRejectedBy(createUser({ email }), 'users_email_length_chk');
    });
  });

  describe('negative: provider labels', () => {
    it.each(['password', 'facebook.com', 'Google.com', 'emaillink', ''])('refuses auth_provider "%s" (users_auth_provider_chk)', async (value) => {
      await expectRejectedBy(createUser({ authProvider: value }), 'users_auth_provider_chk');
    });

    it.each(['password', 'facebook.com', 'Google.com', 'emaillink', ''])('refuses last_auth_provider "%s" (users_last_auth_provider_chk)', async (value) => {
      await expectRejectedBy(createUser({ lastAuthProvider: value }), 'users_last_auth_provider_chk');
    });

    it('refuses an update of last_auth_provider to a bad value, and the row keeps its old value', async () => {
      const user = await createUser();
      await expectRejectedBy(prisma.user.update({ where: { id: user.id }, data: { lastAuthProvider: 'password' } }), 'users_last_auth_provider_chk');
      expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).lastAuthProvider).toBe('google.com');
    });

    it('requires last_auth_provider (NOT NULL): a raw insert without it is refused', async () => {
      await expectRejectedBy(
        prisma.$executeRaw`INSERT INTO users (id, firebase_uid, email, auth_provider, updated_at) VALUES (${randomUUID()}::uuid, ${`fb_${randomUUID()}`}, 'a@example.com', 'google.com', now())`,
        'last_auth_provider',
      );
    });
  });
});
