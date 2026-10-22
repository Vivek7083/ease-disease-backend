import { IdempotencyCleanupService } from '../src/common/idempotency/idempotency-cleanup.service.js';
import { IDEMPOTENCY_KEY_LIFETIME_MS } from '../src/common/idempotency/idempotency.js';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { createTestPrisma, truncateAll } from './helpers/test-db.js';

const NOW = new Date('2026-10-22T10:00:00.000Z');
const HASH = 'a'.repeat(64);

/** The tick's cleanup step against real Postgres, with a fixed clock. */
describe('IdempotencyCleanupService (real Postgres)', () => {
  let prisma: PrismaClient;
  let userId: string;
  let counter: number;

  beforeAll(() => {
    prisma = createTestPrisma();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await truncateAll(prisma);
    counter = 0;
    userId = (await prisma.user.create({ data: { firebaseUid: 'u1', email: 'u1@example.com', authProvider: 'google.com', lastAuthProvider: 'google.com' } })).id;
  });

  const service = () => new IdempotencyCleanupService(prisma);
  const key = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;
  const seed = (ageMs: number, over: { userId?: string; endpoint?: string } = {}) =>
    prisma.idempotencyKey.create({ data: { key: key(), userId: over.userId ?? userId, endpoint: over.endpoint ?? 'POST /v1/bookings', requestHash: HASH, createdAt: new Date(NOW.getTime() - ageMs) } });

  it('the lifetime is exactly 24 hours', () => {
    expect(IDEMPOTENCY_KEY_LIFETIME_MS).toBe(86_400_000);
  });

  it('deletes keys strictly older than 24 hours and keeps the rest, to the millisecond', async () => {
    const older = await seed(IDEMPOTENCY_KEY_LIFETIME_MS + 1);
    const exactly = await seed(IDEMPOTENCY_KEY_LIFETIME_MS);
    const younger = await seed(IDEMPOTENCY_KEY_LIFETIME_MS - 1);
    const fresh = await seed(0);
    const summary = await service().run({ now: NOW });
    expect(summary).toEqual({ idempotencyKeysDeleted: 1 });
    const left = (await prisma.idempotencyKey.findMany()).map((row) => row.key).sort();
    expect(left).toEqual([exactly.key, younger.key, fresh.key].sort());
    expect(left).not.toContain(older.key);
  });

  it('the same cut-off the claim uses: a key the cleanup keeps is still held, one it deletes was already free', async () => {
    // The booking tests prove the claim side (23h50m held, 24h01m free); this pins that cleanup never deletes a held key.
    const held = await seed(IDEMPOTENCY_KEY_LIFETIME_MS - 60_000);
    await service().run({ now: NOW });
    expect(await prisma.idempotencyKey.findUnique({ where: { key_userId_endpoint: { key: held.key, userId, endpoint: held.endpoint } } })).not.toBeNull();
  });

  it('deletes across people and endpoints, and touches nothing else', async () => {
    const other = await prisma.user.create({ data: { firebaseUid: 'u2', email: 'u2@example.com', authProvider: 'google.com', lastAuthProvider: 'google.com' } });
    await seed(2 * IDEMPOTENCY_KEY_LIFETIME_MS);
    await seed(2 * IDEMPOTENCY_KEY_LIFETIME_MS, { userId: other.id });
    await seed(2 * IDEMPOTENCY_KEY_LIFETIME_MS, { endpoint: 'POST /v1/bookings/{reference}/checkout' });
    expect((await service().run({ now: NOW })).idempotencyKeysDeleted).toBe(3);
    expect(await prisma.idempotencyKey.count()).toBe(0);
    expect(await prisma.user.count()).toBe(2);
  });

  it('is a plain zero on an empty table and when repeated', async () => {
    expect(await service().run({ now: NOW })).toEqual({ idempotencyKeysDeleted: 0 });
    await seed(2 * IDEMPOTENCY_KEY_LIFETIME_MS);
    expect((await service().run({ now: NOW })).idempotencyKeysDeleted).toBe(1);
    expect((await service().run({ now: NOW })).idempotencyKeysDeleted).toBe(0);
  });

  it('two runs at once delete each row exactly once and do not fail', async () => {
    for (let i = 0; i < 20; i++) await seed(2 * IDEMPOTENCY_KEY_LIFETIME_MS);
    const results = await Promise.all([service().run({ now: NOW }), service().run({ now: NOW })]);
    expect(results.reduce((sum, r) => sum + r.idempotencyKeysDeleted, 0)).toBe(20);
    expect(await prisma.idempotencyKey.count()).toBe(0);
  });

  it('uses the real clock when none is given', async () => {
    await prisma.idempotencyKey.create({ data: { key: key(), userId, endpoint: 'POST /v1/bookings', requestHash: HASH, createdAt: new Date(Date.now() - 25 * 3_600_000) } });
    await prisma.idempotencyKey.create({ data: { key: key(), userId, endpoint: 'POST /v1/bookings', requestHash: HASH } });
    expect(await service().run()).toEqual({ idempotencyKeysDeleted: 1 });
    expect(await prisma.idempotencyKey.count()).toBe(1);
  });
});
