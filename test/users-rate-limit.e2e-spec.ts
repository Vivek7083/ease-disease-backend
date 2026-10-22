import { Controller, Get, Global, Logger, Module, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { APP_CHECK_VERIFIER } from '../src/auth/app-check-verifier.js';
import { IDENTITY_VERIFIER, IdentityRejectedError, IdentityUnavailableError, type VerifiedIdentity } from '../src/auth/identity-verifier.js';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter.js';
import { configureTrustProxy } from '../src/common/http/trust-proxy.js';
import { RequestIdMiddleware } from '../src/common/middleware/request-id.middleware.js';
import {
  IP_LIMIT_PER_MINUTE,
  IP_RATE_LIMITER,
  RATE_LIMIT_WINDOW_MS,
  USER_LIMIT_PER_MINUTE,
  USER_RATE_LIMITER,
  UserRateLimitGuard,
} from '../src/common/rate-limit/rate-limit.guards.js';
import { RateLimitModule } from '../src/common/rate-limit/rate-limit.module.js';
import { SlidingWindowLimiter } from '../src/common/rate-limit/sliding-window-limiter.js';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { setupSwaggerIfAllowed } from '../src/swagger.js';
import { UsersModule } from '../src/users/users.module.js';
import { FakeAppCheckVerifier, SHAPED_APP_CHECK_TOKEN } from './helpers/app-check-kit.js';
import { FakeIdentityVerifier, IDENTITY, SHAPED_TOKEN } from './helpers/identity-kit.js';
import { createTestPrisma, truncateAll } from './helpers/test-db.js';

/**
 * S2f: the two limits on POST /v1/auth/sync and GET /v1/me, over real HTTP on the real `_test` Postgres, with the
 * REAL limiters driven by a fake clock (so "a minute later" costs no waiting).
 */
describe('rate limits on /v1/auth/sync and /v1/me', () => {
  let prisma: PrismaClient;
  let app: NestExpressApplication;
  let now: number;
  const identityVerifier = new FakeIdentityVerifier();
  const appCheckVerifier = new FakeAppCheckVerifier();

  async function createApp(trustProxyHops = 0) {
    await app?.close();
    const values: Record<string, unknown> = { NODE_ENV: 'development', FIREBASE_PROJECT_ID: 'easedisease-test', APP_CHECK_MODE: 'enforce' };
    @Global()
    @Module({
      providers: [
        { provide: ConfigService, useValue: { get: (name: string) => values[name] } },
        { provide: PrismaService, useValue: prisma },
      ],
      exports: [ConfigService, PrismaService],
    })
    class FakeInfraModule {}

    const moduleRef = await Test.createTestingModule({ imports: [FakeInfraModule, UsersModule] })
      .overrideProvider(IDENTITY_VERIFIER)
      .useValue(identityVerifier)
      .overrideProvider(APP_CHECK_VERIFIER)
      .useValue(appCheckVerifier)
      .overrideProvider(IP_RATE_LIMITER)
      .useValue(new SlidingWindowLimiter(IP_LIMIT_PER_MINUTE, RATE_LIMIT_WINDOW_MS, () => now))
      .overrideProvider(USER_RATE_LIMITER)
      .useValue(new SlidingWindowLimiter(USER_LIMIT_PER_MINUTE, RATE_LIMIT_WINDOW_MS, () => now))
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureTrustProxy(app, trustProxyHops);
    const requestId = new RequestIdMiddleware();
    app.use((req: never, res: never, next: never) => requestId.use(req, res, next));
    app.useGlobalFilters(new AllExceptionsFilter());
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

  let warn: ReturnType<typeof vi.spyOn>;
  let errorLog: ReturnType<typeof vi.spyOn>;
  beforeEach(async () => {
    await truncateAll(prisma);
    now = 1_000_000_000;
    identityVerifier.calls.length = 0;
    identityVerifier.willReturn(IDENTITY);
    appCheckVerifier.calls.length = 0;
    appCheckVerifier.willReturn({ appId: 'app' });
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    errorLog = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    await createApp();
  });
  afterEach(() => {
    warn.mockRestore();
    errorLog.mockRestore();
  });

  const sync = (ip?: string) => {
    const req = request(app.getHttpServer()).post('/v1/auth/sync').set('X-Firebase-AppCheck', SHAPED_APP_CHECK_TOKEN).set('Authorization', `Bearer ${SHAPED_TOKEN}`);
    return ip ? req.set('X-Forwarded-For', ip) : req;
  };
  const me = (ip?: string, token = SHAPED_TOKEN) => {
    const req = request(app.getHttpServer()).get('/v1/me').set('Authorization', `Bearer ${token}`);
    return ip ? req.set('X-Forwarded-For', ip) : req;
  };
  const statuses = async (count: number, call: () => PromiseLike<request.Response>) => {
    const out: number[] = [];
    for (let i = 0; i < count; i++) out.push((await call()).status);
    return out;
  };
  const as = (uid: string) => identityVerifier.willReturn({ ...IDENTITY, uid } satisfies VerifiedIdentity);
  const lastLogin = async (uid = IDENTITY.uid) => (await prisma.user.findUnique({ where: { firebaseUid: uid } }))?.lastLoginAt?.getTime();

  describe('per person: 30 a minute, shared by /auth/sync and /me', () => {
    it('allows exactly 30 calls and refuses the 31st with the standard 429 envelope and Retry-After', async () => {
      expect(await statuses(30, () => sync())).toEqual(Array(30).fill(200));
      const res = await sync().expect(429);
      expect(res.body.error).toEqual({ code: 'RATE_LIMITED', message: 'Too many requests', details: { retryAfterSeconds: 60 }, requestId: expect.any(String) });
      expect(res.headers['retry-after']).toBe('60');
    });

    it('a refused call never reaches the handler (the row is not touched)', async () => {
      await statuses(30, () => sync());
      const before = await lastLogin();
      now += 5_000;
      await sync().expect(429);
      expect(await lastLogin()).toBe(before);
      expect(await prisma.user.count()).toBe(1);
    });

    it('Retry-After counts down with the clock and never drops below 1', async () => {
      await statuses(30, () => sync());
      now += 10_000;
      const res = await sync().expect(429);
      expect(res.body.error.details).toEqual({ retryAfterSeconds: 50 });
      expect(res.headers['retry-after']).toBe('50');
      now += 49_500; // 500 ms left: rounds up to 1
      const last = await sync().expect(429);
      expect(last.headers['retry-after']).toBe('1');
    });

    it('allows calls again once a full window has passed since the first hits', async () => {
      await statuses(30, () => sync());
      await sync().expect(429);
      now += 60_001;
      await sync().expect(200);
    });

    it('frees only the oldest calls as the window slides', async () => {
      await statuses(10, () => sync()); // t = 0
      now += 30_000;
      await statuses(20, () => sync()); // t = 30 s: 30 in the window
      await sync().expect(429);
      now += 30_001; // the first 10 have left, 20 remain
      expect(await statuses(10, () => sync())).toEqual(Array(10).fill(200));
      await sync().expect(429);
    });

    it('refused calls do not extend the lock', async () => {
      await statuses(30, () => sync());
      for (let i = 0; i < 20; i++) {
        now += 2_000;
        await sync().expect(429);
      }
      now += 20_001; // 60 s + after the first hit, however many refusals happened
      await sync().expect(200);
    });

    it('/auth/sync and /me share one bucket: 15 + 15 fill it, then either is refused', async () => {
      expect(await statuses(15, () => sync())).toEqual(Array(15).fill(200));
      expect(await statuses(15, () => me())).toEqual(Array(15).fill(200));
      await me().expect(429);
      await sync().expect(429);
    });

    it('/me alone also stops at 30', async () => {
      expect(await statuses(30, () => me())).toEqual(Array(30).fill(200));
      const res = await me().expect(429);
      expect(res.body.error).toMatchObject({ code: 'RATE_LIMITED' });
      expect(res.headers['retry-after']).toBe('60');
    });

    it('one person over the limit does not affect another', async () => {
      as('uid-a');
      await statuses(30, () => sync());
      await sync().expect(429);
      as('uid-b');
      await sync().expect(200);
    });

    it('two Firebase accounts with the same email have separate budgets', async () => {
      identityVerifier.willReturn({ ...IDENTITY, uid: 'uid-a', email: 'same@example.com' });
      await statuses(30, () => sync());
      await sync().expect(429);
      identityVerifier.willReturn({ ...IDENTITY, uid: 'uid-b', email: 'same@example.com' });
      await sync().expect(200);
    });

    it('the budget belongs to the uid, not to the token string: a fresh token for the same person does not reset it', async () => {
      await statuses(30, () => me(undefined, 'aaaa.bbbb.cccc'));
      await me(undefined, 'dddd.eeee.ffff').expect(429);
    });

    it('the same person from another address shares the same per-person budget', async () => {
      await createApp(1);
      await statuses(30, () => me('203.0.113.1'));
      await me('203.0.113.2').expect(429);
    });
  });

  describe('requests refused earlier spend nobody budget', () => {
    it('40 bad login tokens, then the real person still has all 30', async () => {
      identityVerifier.willReturn(new IdentityRejectedError('forged'));
      expect(await statuses(40, () => me())).toEqual(Array(40).fill(401));
      identityVerifier.willReturn(IDENTITY);
      expect(await statuses(30, () => me())).toEqual(Array(30).fill(200));
      await me().expect(429);
    });

    it('40 syncs without App Check (403), then all 30 are still available', async () => {
      const noAppCheck = () => request(app.getHttpServer()).post('/v1/auth/sync').set('Authorization', `Bearer ${SHAPED_TOKEN}`);
      expect(await statuses(40, noAppCheck)).toEqual(Array(40).fill(403));
      expect(await statuses(30, () => sync())).toEqual(Array(30).fill(200));
    });

    it('unverified-email calls (403) and Google outages (503) spend nothing', async () => {
      identityVerifier.willReturn({ ...IDENTITY, emailVerified: false });
      expect(await statuses(35, () => me())).toEqual(Array(35).fill(403));
      identityVerifier.willReturn(new IdentityUnavailableError('down'));
      expect(await statuses(35, () => me())).toEqual(Array(35).fill(503));
      identityVerifier.willReturn(IDENTITY);
      expect(await statuses(30, () => me())).toEqual(Array(30).fill(200));
    });

    it('a call refused by the per-person limit does not reach the database (no new row for a refused new person)', async () => {
      as('uid-new');
      await statuses(30, () => me());
      expect(await prisma.user.count()).toBe(1);
      await me().expect(429);
      expect(await prisma.user.count()).toBe(1);
    });
  });

  describe('per address: 120 a minute in front of everything', () => {
    it('counts bad-token requests too, and the 121st is refused before any token is looked at', async () => {
      identityVerifier.willReturn(new IdentityRejectedError('forged'));
      expect(await statuses(120, () => me())).toEqual(Array(120).fill(401));
      expect(identityVerifier.calls).toHaveLength(120);
      const res = await me().expect(429);
      expect(res.body.error).toMatchObject({ code: 'RATE_LIMITED', details: { retryAfterSeconds: 60 } });
      expect(res.headers['retry-after']).toBe('60');
      expect(identityVerifier.calls).toHaveLength(120); // the 121st never reached the verifier
    });

    it('on sync the 121st is refused before App Check is even asked', async () => {
      appCheckVerifier.willReturn(new Error('x'));
      const noToken = () => request(app.getHttpServer()).post('/v1/auth/sync');
      expect(await statuses(120, noToken)).toEqual(Array(120).fill(403));
      await noToken().expect(429);
      expect(appCheckVerifier.calls).toHaveLength(0); // no header was ever sent, and the 429 came first
    });

    it('slides: after a minute the address is free again', async () => {
      identityVerifier.willReturn(new IdentityRejectedError('forged'));
      await statuses(120, () => me());
      await me().expect(429);
      now += 60_001;
      await me().expect(401);
    });

    it('with trust-proxy 0 a forged X-Forwarded-For does not give a fresh allowance', async () => {
      identityVerifier.willReturn(new IdentityRejectedError('forged'));
      await statuses(120, () => me('1.1.1.1'));
      await me('2.2.2.2').expect(429);
      await me('3.3.3.3').expect(429);
    });

    it('with one trusted proxy, each client address has its own allowance and a real person on another address is unaffected', async () => {
      await createApp(1);
      identityVerifier.willReturn(new IdentityRejectedError('forged'));
      await statuses(120, () => me('203.0.113.1'));
      await me('203.0.113.1').expect(429);
      identityVerifier.willReturn(IDENTITY);
      await me('203.0.113.2').expect(200);
    });

    it('with one trusted proxy, a client-prepended forged entry cannot choose the key', async () => {
      await createApp(1);
      identityVerifier.willReturn(new IdentityRejectedError('forged'));
      await statuses(120, () => me('6.6.6.1, 203.0.113.1'));
      await me('6.6.6.2, 203.0.113.1').expect(429);
    });

    it('the address limit does not spend the per-person budget', async () => {
      identityVerifier.willReturn(new IdentityRejectedError('forged'));
      await statuses(100, () => me());
      now += 60_001;
      identityVerifier.willReturn(IDENTITY);
      expect(await statuses(30, () => me())).toEqual(Array(30).fill(200));
    });

    it('both limiters are real, separate instances (the singletons are shared across controllers, not across kinds)', () => {
      const moduleLimiters = Test.createTestingModule({ imports: [RateLimitModule] }).compile();
      return moduleLimiters.then((moduleRef) => {
        const ip = moduleRef.get(IP_RATE_LIMITER);
        const user = moduleRef.get(USER_RATE_LIMITER);
        expect(ip).toBeInstanceOf(SlidingWindowLimiter);
        expect(user).toBeInstanceOf(SlidingWindowLimiter);
        expect(ip).not.toBe(user);
        expect(moduleRef.get(IP_RATE_LIMITER)).toBe(ip);
      });
    });
  });

  describe('misuse and logging', () => {
    it('the per-person guard placed before the login guard refuses with 401 instead of sharing one bucket', async () => {
      @Controller('misordered')
      @UseGuards(UserRateLimitGuard)
      class MisorderedController {
        @Get()
        ping() {
          return { ok: true };
        }
      }
      @Module({ imports: [RateLimitModule], controllers: [MisorderedController] })
      class MisorderedModule {}
      const moduleRef = await Test.createTestingModule({ imports: [MisorderedModule] }).compile();
      const misordered = moduleRef.createNestApplication<NestExpressApplication>();
      misordered.useGlobalFilters(new AllExceptionsFilter());
      await misordered.init();
      const res = await request(misordered.getHttpServer()).get('/misordered');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
      await misordered.close();
    });

    it('the log names a short fingerprint, never the uid, the email or the token', async () => {
      await statuses(30, () => sync());
      await sync().expect(429);
      const logged = warn.mock.calls.map((call: unknown[]) => String(call[0])).join('|');
      expect(logged).toContain('Per-user rate limit reached (user ');
      expect(logged).not.toContain(IDENTITY.uid);
      expect(logged).not.toContain('priya@example.com');
      expect(logged).not.toContain(SHAPED_TOKEN);
    });

    it('the address limit logs the address once per refused call', async () => {
      identityVerifier.willReturn(new IdentityRejectedError('forged'));
      await statuses(120, () => me());
      warn.mockClear();
      await me().expect(429);
      expect(warn.mock.calls.filter((call: unknown[]) => String(call[0]).includes('Per-address rate limit reached'))).toHaveLength(1);
    });
  });
});

/** The Swagger document for the two routes (the page is development/staging only). */
describe('Swagger for /v1/auth/sync and /v1/me', () => {
  const prisma = {} as PrismaClient;

  async function documentFor(nodeEnv: string) {
    const values: Record<string, unknown> = { NODE_ENV: nodeEnv, FIREBASE_PROJECT_ID: 'easedisease-test', APP_CHECK_MODE: 'enforce' };
    @Global()
    @Module({
      providers: [
        { provide: ConfigService, useValue: { get: (name: string) => values[name] } },
        { provide: PrismaService, useValue: prisma },
      ],
      exports: [ConfigService, PrismaService],
    })
    class FakeInfraModule {}
    const moduleRef = await Test.createTestingModule({ imports: [FakeInfraModule, UsersModule] })
      .overrideProvider(IDENTITY_VERIFIER)
      .useValue(new FakeIdentityVerifier())
      .overrideProvider(APP_CHECK_VERIFIER)
      .useValue(new FakeAppCheckVerifier())
      .compile();
    const app = moduleRef.createNestApplication<NestExpressApplication>();
    setupSwaggerIfAllowed(app, nodeEnv);
    await app.init();
    const res = await request(app.getHttpServer()).get('/docs-json');
    await app.close();
    return res;
  }

  it('lists both routes with the bearer scheme, typed 200 responses and every documented error', async () => {
    const res = await documentFor('development');
    expect(res.status).toBe(200);
    const sync = res.body.paths['/v1/auth/sync'].post;
    const me = res.body.paths['/v1/me'].get;
    for (const operation of [sync, me]) {
      expect(operation.tags).toContain('auth');
      expect(operation.security).toEqual([{ 'firebase-id-token': [] }]);
      expect(operation.responses['200'].content['application/json'].schema.$ref).toBe('#/components/schemas/ProfileResponseDto');
      for (const code of ['400', '401', '403', '429', '503']) {
        expect(operation.responses[code], `response ${code}`).toBeDefined();
        expect(operation.responses[code].content['application/json'].schema.$ref).toBe('#/components/schemas/ErrorEnvelopeDto');
      }
      expect(operation.responses['429'].description).toContain('Retry-After');
    }
    expect(res.body.components.securitySchemes['firebase-id-token']).toMatchObject({ type: 'http', scheme: 'bearer' });
  });

  it('documents the App Check header on sync only', async () => {
    const res = await documentFor('development');
    const appCheck = (operation: { parameters?: Array<{ name: string; in: string; required: boolean }> }) =>
      (operation.parameters ?? []).filter((parameter) => parameter.name === 'X-Firebase-AppCheck');
    expect(appCheck(res.body.paths['/v1/auth/sync'].post)).toEqual([expect.objectContaining({ in: 'header', required: true })]);
    expect(appCheck(res.body.paths['/v1/me'].get)).toEqual([]);
  });

  it('describes the profile and error shapes', async () => {
    const res = await documentFor('development');
    const schemas = res.body.components.schemas;
    expect(Object.keys(schemas.UserProfileDto.properties).sort()).toEqual(['authProvider', 'dob', 'email', 'id', 'lastAuthProvider', 'name', 'phone']);
    expect(schemas.UserProfileDto.properties.authProvider.enum).toEqual(['google.com', 'emailLink']);
    expect(Object.keys(schemas.ProfileResponseDto.properties).sort()).toEqual(['profileComplete', 'user']);
    expect(Object.keys(schemas.ErrorEnvelopeDto.properties)).toEqual(['error']);
    expect(Object.keys(schemas.ErrorBodyDto.properties).sort()).toEqual(['code', 'details', 'message', 'requestId']);
  });

  it('names every error code the routes can answer in the response descriptions', async () => {
    const res = await documentFor('development');
    const text = JSON.stringify(res.body.paths['/v1/auth/sync'].post.responses);
    for (const code of ['INVALID_EMAIL', 'UNAUTHENTICATED', 'APP_CHECK_FAILED', 'EMAIL_NOT_VERIFIED', 'UNSUPPORTED_SIGN_IN_PROVIDER', 'RATE_LIMITED', 'AUTH_UNAVAILABLE', 'APP_CHECK_UNAVAILABLE']) {
      expect(text, code).toContain(code);
    }
  });

  it('is not served in production', async () => {
    expect((await documentFor('production')).status).toBe(404);
  });
});
