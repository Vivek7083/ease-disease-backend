import { describe, expect, it } from 'vitest';
import { HealthService } from './health.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';

function createService(queryRaw: () => Promise<unknown>): HealthService {
  const prisma = { $queryRaw: queryRaw } as unknown as PrismaService;
  return new HealthService(prisma);
}

describe('HealthService', () => {
  it('reports db: ok when the query succeeds', async () => {
    const service = createService(() => Promise.resolve([{ '?column?': 1 }]));

    const result = await service.check();

    expect(result.db).toBe('ok');
    expect(result.status).toBe('ok');
  });

  it('reports db: error (without throwing) when the query fails', async () => {
    const service = createService(() => Promise.reject(new Error('connection refused')));

    const result = await service.check();

    expect(result.db).toBe('error');
    expect(result.status).toBe('ok'); // the endpoint itself still responds
  });

  it('includes the app version from package.json', async () => {
    const service = createService(() => Promise.resolve([]));

    const result = await service.check();

    expect(result.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
