import { defineConfig } from 'vitest/config';

// The same default as test/helpers/test-db.ts (which refuses any database whose name does not end in `_test`).
const TEST_DATABASE_URL = process.env['DATABASE_URL_TEST'] ?? 'postgresql://easedisease:easedisease_local@localhost:5432/easedisease_test';

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    globalSetup: ['./test/global-setup.ts'],
    // Tests that start the whole application (test/health.e2e-spec.ts) need DATABASE_URL, and must not depend on a
    // developer's git-ignored `.env` (the CI runner has none): they always use the migrated test database.
    env: { DATABASE_URL: TEST_DATABASE_URL },
    // Integration tests share one test database and truncate it, so files must not overlap.
    fileParallelism: false,
  },
});
