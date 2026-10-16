import type { PrismaClient } from '../generated/prisma/client.js';

/** Fixed id so re-running the seed finds the same row (packages have no natural key yet). */
export const SEED_PACKAGE_ID = '00000000-0000-4000-8000-000000000001';

export const SEED_PACKAGE = {
  title: 'One-Time Consult',
  /** Bullet points the frontend shows as-is. */
  description: ['3-week plan.', 'Understand your underlying root cause.'],
  /** ₹2,499, as set by the owner on 2026-10-17. Seeding never overwrites an existing row's price. */
  pricePaise: 249900,
  isActive: true,
} as const;

/**
 * Idempotent: creates the single launch package if it is missing and never overwrites an existing
 * row, so later edits (title, price, points) are not clobbered by re-running the seed.
 */
export async function seedPackage(prisma: Pick<PrismaClient, 'package'>): Promise<void> {
  await prisma.package.upsert({
    where: { id: SEED_PACKAGE_ID },
    update: {},
    create: { id: SEED_PACKAGE_ID, ...SEED_PACKAGE, description: [...SEED_PACKAGE.description] },
  });
}
