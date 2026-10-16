import { execSync } from 'node:child_process';
import pg from 'pg';
import { testDatabaseUrl } from './helpers/test-db.js';

/**
 * Runs once before the e2e suite: makes sure the `_test` database exists and has every migration
 * applied, so integration tests never depend on someone having prepared it by hand.
 */
export default async function setup(): Promise<void> {
  const url = testDatabaseUrl();
  const dbName = new URL(url).pathname.replace(/^\//, '');

  const adminUrl = new URL(url);
  adminUrl.pathname = '/postgres';
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (exists.rowCount === 0) {
      await admin.query(`CREATE DATABASE "${dbName}"`);
    }
  } finally {
    await admin.end();
  }

  execSync('npx prisma migrate deploy --config prisma7.config.ts', {
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });
}
