import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../src/generated/prisma/client.js';

const DEFAULT_TEST_URL = 'postgresql://easedisease:easedisease_local@localhost:5432/easedisease_test';

/**
 * Database used by integration tests that write rows. Tests TRUNCATE tables, so this refuses any
 * database whose name does not end in `_test`: a wrong DATABASE_URL_TEST can never wipe dev data.
 */
export function testDatabaseUrl(): string {
  const url = process.env['DATABASE_URL_TEST'] ?? DEFAULT_TEST_URL;
  const name = new URL(url).pathname.replace(/^\//, '');
  if (!name.endsWith('_test')) {
    throw new Error(`Refusing to use database "${name}" for tests: its name must end with "_test"`);
  }
  return url;
}

export function createTestPrisma(): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: testDatabaseUrl() }) });
}

const TABLES = ['payment_events', 'transactions', 'bookings', 'outbox', 'packages', 'users'];

export async function truncateAll(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${TABLES.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`);
}
