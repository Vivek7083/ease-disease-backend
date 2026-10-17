import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter.js';

/**
 * Runs against the real local Postgres (docker-compose), not a mock — this is the only way to
 * actually prove /healthz's db check is real, per docs/plans/2026-10-16-slice-plan.md (S1).
 */
describe('/healthz (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns ok status, version, and db: ok when the database is reachable', async () => {
    const response = await request(app.getHttpServer()).get('/healthz').expect(200);

    expect(response.body).toEqual({
      status: 'ok',
      version: expect.any(String),
      db: 'ok',
    });
  });

  it('attaches an X-Request-Id header to the response', async () => {
    const response = await request(app.getHttpServer()).get('/healthz').expect(200);

    expect(response.headers['x-request-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('echoes back a caller-supplied X-Request-Id instead of generating a new one', async () => {
    const response = await request(app.getHttpServer())
      .get('/healthz')
      .set('X-Request-Id', 'caller-supplied-id')
      .expect(200);

    expect(response.headers['x-request-id']).toBe('caller-supplied-id');
  });

  // The "db unreachable" case is deliberately NOT tested here: Prisma's client reconnects
  // lazily, so calling $disconnect() and querying again doesn't actually simulate an outage
  // (confirmed by running it — the query silently succeeds). That path is covered as a real
  // unit test instead, with a mocked PrismaService: see ../src/health/health.service.spec.ts.

  describe('internal tick, in the real application wiring', () => {
    it('POST /v1/internal/tick exists and refuses callers without a valid scheduler token (fails closed)', async () => {
      for (const header of [undefined, 'Bearer aaa.bbb.ccc']) {
        const req = request(app.getHttpServer()).post('/v1/internal/tick');
        const response = await (header ? req.set('Authorization', header) : req).expect(401);
        expect(response.body.error).toMatchObject({ code: 'UNAUTHENTICATED' });
      }
    });

    it('POST /dev/tick is hidden outside development', async () => {
      const response = await request(app.getHttpServer()).post('/dev/tick').expect(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
    });
  });

  it('maps an unknown route to the locked error envelope shape', async () => {
    const response = await request(app.getHttpServer()).get('/this-route-does-not-exist').expect(404);

    expect(response.body).toEqual({
      error: {
        code: expect.any(String),
        message: expect.any(String),
        details: expect.any(Object),
        requestId: expect.any(String),
      },
    });
  });
});
