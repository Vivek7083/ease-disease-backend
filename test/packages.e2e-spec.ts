import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter.js';
import { configureTrustProxy } from '../src/common/http/trust-proxy.js';
import { RequestIdMiddleware } from '../src/common/middleware/request-id.middleware.js';
import {
  IP_RATE_LIMITER,
  PUBLIC_READ_LIMIT_PER_MINUTE,
  PUBLIC_READ_RATE_LIMITER,
  RATE_LIMIT_WINDOW_MS,
} from '../src/common/rate-limit/rate-limit.guards.js';
import { SlidingWindowLimiter } from '../src/common/rate-limit/sliding-window-limiter.js';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { PackagesModule } from '../src/packages/packages.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { SEED_PACKAGE_ID, seedPackage } from '../src/seed/seed-package.js';
import { setupSwaggerIfAllowed } from '../src/swagger.js';
import { createTestPrisma, truncateAll } from './helpers/test-db.js';

/** GET /v1/packages over real HTTP on the real `_test` Postgres. The public limiter is the REAL one driven by a fake clock. */
describe('GET /v1/packages', () => {
  let prisma: PrismaClient;
  let app: NestExpressApplication;
  let now: number;

  async function createApp() {
    await app?.close();
    @Global()
    @Module({
      providers: [
        { provide: ConfigService, useValue: { get: () => undefined } },
        { provide: PrismaService, useValue: prisma },
      ],
      exports: [ConfigService, PrismaService],
    })
    class FakeInfraModule {}

    const moduleRef = await Test.createTestingModule({ imports: [FakeInfraModule, PackagesModule] })
      .overrideProvider(PUBLIC_READ_RATE_LIMITER)
      .useValue(new SlidingWindowLimiter(PUBLIC_READ_LIMIT_PER_MINUTE, RATE_LIMIT_WINDOW_MS, () => now))
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureTrustProxy(app, 0);
    const requestId = new RequestIdMiddleware();
    app.use((req: never, res: never, next: never) => requestId.use(req, res, next));
    app.useGlobalFilters(new AllExceptionsFilter());
    setupSwaggerIfAllowed(app, 'development');
    await app.init();
    await app.listen(0, '127.0.0.1');
  }

  beforeAll(() => {
    prisma = createTestPrisma();
  });
  afterAll(async () => {
    await app?.close();
    await prisma.$disconnect();
  });

  const logSpies: ReturnType<typeof vi.spyOn>[] = [];
  beforeEach(async () => {
    await truncateAll(prisma);
    now = 1_000_000_000;
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
      logSpies.push(vi.spyOn(Logger.prototype, level).mockImplementation(() => undefined));
    }
    await createApp();
  });
  afterEach(() => {
    for (const spy of logSpies.splice(0)) spy.mockRestore();
  });

  const get = () => request(app.getHttpServer()).get('/v1/packages');
  const add = (data: { title: string; pricePaise: number; originalPricePaise?: number | null; durationMinutes?: number; isActive?: boolean; description?: string[]; createdAt?: Date }) =>
    prisma.package.create({ data: { description: ['a point'], durationMinutes: 30, ...data } });

  it('answers an empty list when nothing is on sale', async () => {
    await add({ title: 'Off', pricePaise: 100, isActive: false });
    const res = await get().expect(200);
    expect(res.body).toEqual({ packages: [] });
  });

  it('returns exactly the fields the site needs, with the stored values', async () => {
    await seedPackage(prisma);
    const res = await get().expect(200);
    expect(res.body).toEqual({
      packages: [
        {
          id: SEED_PACKAGE_ID,
          title: 'One-Time Consult',
          description: ['3-week plan.', 'Understand your underlying root cause.'],
          pricePaise: 249900,
          originalPricePaise: 500000,
          currency: 'INR',
          durationMinutes: 30,
        },
      ],
    });
  });

  it('lists only active packages, cheapest first, then oldest first', async () => {
    await add({ title: 'Dear', pricePaise: 500000 });
    await add({ title: 'Hidden', pricePaise: 1, isActive: false });
    await add({ title: 'Cheap new', pricePaise: 100000, createdAt: new Date('2026-02-01T00:00:00Z') });
    await add({ title: 'Cheap old', pricePaise: 100000, createdAt: new Date('2026-01-01T00:00:00Z'), durationMinutes: 45 });
    const res = await get().expect(200);
    expect(res.body.packages.map((p: { title: string }) => p.title)).toEqual(['Cheap old', 'Cheap new', 'Dear']);
    expect(res.body.packages[0].durationMinutes).toBe(45);
  });

  it('carries the old price for the struck-through display, or null when there is none', async () => {
    await add({ title: 'On offer', pricePaise: 100000, originalPricePaise: 250000 });
    await add({ title: 'Plain', pricePaise: 200000 });
    const packages = (await get().expect(200)).body.packages;
    expect(packages.map((p: { title: string; pricePaise: number; originalPricePaise: number | null }) => [p.title, p.pricePaise, p.originalPricePaise])).toEqual([
      ['On offer', 100000, 250000],
      ['Plain', 200000, null],
    ]);
  });

  it('shows a package again once it is switched back on', async () => {
    const pkg = await add({ title: 'Seasonal', pricePaise: 100, isActive: false });
    expect((await get().expect(200)).body.packages).toHaveLength(0);
    await prisma.package.update({ where: { id: pkg.id }, data: { isActive: true } });
    expect((await get().expect(200)).body.packages).toHaveLength(1);
  });

  it('never exposes flags or timestamps, and keeps the description a list', async () => {
    await add({ title: 'Only', pricePaise: 100, description: ['one', 'two'] });
    const body = (await get().expect(200)).body;
    expect(Object.keys(body.packages[0]).sort()).toEqual(['currency', 'description', 'durationMinutes', 'id', 'originalPricePaise', 'pricePaise', 'title']);
    expect(body.packages[0].description).toEqual(['one', 'two']);
    expect(JSON.stringify(body)).not.toMatch(/isActive|createdAt|updatedAt/);
  });

  it('needs no login, no App Check and no Idempotency-Key, and may be cached for 5 minutes', async () => {
    await add({ title: 'Only', pricePaise: 100 });
    const res = await get().expect(200);
    expect(res.headers['cache-control']).toBe('public, max-age=300');
  });

  it('seeding twice leaves one package', async () => {
    await seedPackage(prisma);
    await seedPackage(prisma);
    expect((await get().expect(200)).body.packages).toHaveLength(1);
  });

  describe('limit', () => {
    it('allows 60 a minute per address, then 429 with Retry-After; the window slides', async () => {
      for (let i = 0; i < PUBLIC_READ_LIMIT_PER_MINUTE; i += 1) await get().expect(200);
      const res = await get().expect(429);
      expect(res.body.error.code).toBe('RATE_LIMITED');
      expect(res.headers['retry-after']).toBe('60');
      now += RATE_LIMIT_WINDOW_MS + 1;
      await get().expect(200);
    });

    it('has its own bucket, separate from the sign-in address bucket', () => {
      expect(PUBLIC_READ_RATE_LIMITER).not.toBe(IP_RATE_LIMITER);
    });
  });

  it('is documented in Swagger with the 200 and 429 answers', async () => {
    const res = await request(app.getHttpServer()).get('/docs-json').expect(200);
    const operation = res.body.paths['/v1/packages'].get;
    expect(Object.keys(operation.responses).sort()).toEqual(['200', '429']);
    expect(operation.security).toBeUndefined();
  });
});
