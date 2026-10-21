import { Controller, Get, Global, Logger, Module, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppCheckGuard } from '../src/auth/app-check.guard.js';
import { APP_CHECK_VERIFIER } from '../src/auth/app-check-verifier.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { FirebaseAppCheckVerifier, UnconfiguredAppCheckVerifier } from '../src/auth/firebase-app-check-verifier.js';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter.js';
import { RequestIdMiddleware } from '../src/common/middleware/request-id.middleware.js';

/** S2c wiring: the REAL AuthModule factory for App Check, built from config, with the real SDK. */
describe('AuthModule wiring for App Check', () => {
  let app: NestExpressApplication | undefined;

  @Controller('checked')
  @UseGuards(AppCheckGuard)
  class CheckedController {
    @Get()
    ping() {
      return { ok: true };
    }
  }

  async function createApp(config: Record<string, unknown>) {
    @Global()
    @Module({
      providers: [{ provide: ConfigService, useValue: { get: (name: string) => config[name] } }],
      exports: [ConfigService],
    })
    class FakeConfigModule {}
    @Module({ imports: [FakeConfigModule, AuthModule], controllers: [CheckedController] })
    class TestModule {}

    const moduleRef = await Test.createTestingModule({ imports: [TestModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    const requestId = new RequestIdMiddleware();
    app.use((req: never, res: never, next: never) => requestId.use(req, res, next));
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    return moduleRef;
  }

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('without FIREBASE_PROJECT_ID uses the refuse-everything verifier, and every request is a 403', async () => {
    const moduleRef = await createApp({ NODE_ENV: 'development' });
    expect(moduleRef.get(APP_CHECK_VERIFIER)).toBeInstanceOf(UnconfiguredAppCheckVerifier);
    const res = await request(app!.getHttpServer()).get('/checked').set('X-Firebase-AppCheck', 'aaaa.bbbb.cccc').expect(403);
    expect(res.body.error).toMatchObject({ code: 'APP_CHECK_FAILED', requestId: expect.any(String) });
  });

  it('with FIREBASE_PROJECT_ID builds the real Firebase verifier, and a forged token is refused by the real SDK', async () => {
    const moduleRef = await createApp({ NODE_ENV: 'development', FIREBASE_PROJECT_ID: 'project-one' });
    expect(moduleRef.get(APP_CHECK_VERIFIER)).toBeInstanceOf(FirebaseAppCheckVerifier);
    const forged = `${Buffer.from('{"alg":"RS256","kid":"x"}').toString('base64url')}.${Buffer.from('{"sub":"a"}').toString('base64url')}.c2ln`;
    await request(app!.getHttpServer()).get('/checked').set('X-Firebase-AppCheck', forged).expect(403);
  });

  it('with APP_CHECK_MODE=off the real guard lets the request through', async () => {
    await createApp({ NODE_ENV: 'development', FIREBASE_PROJECT_ID: 'project-one', APP_CHECK_MODE: 'off' });
    await request(app!.getHttpServer()).get('/checked').expect(200);
  });

  describe('start-up warning for APP_CHECK_MODE=off', () => {
    const offWarnings = (spy: ReturnType<typeof vi.spyOn>) => spy.mock.calls.filter((call: unknown[]) => String(call[0]).includes('APP_CHECK_MODE=off'));

    it('is logged exactly once even when several controllers use the guard, not on every request', async () => {
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      @Controller('other')
      @UseGuards(AppCheckGuard)
      class OtherController {
        @Get()
        ping() {
          return { ok: true };
        }
      }
      @Global()
      @Module({ providers: [{ provide: ConfigService, useValue: { get: (name: string) => ({ NODE_ENV: 'development', APP_CHECK_MODE: 'off' })[name as 'NODE_ENV'] } }], exports: [ConfigService] })
      class OffConfigModule {}
      @Module({ imports: [OffConfigModule, AuthModule], controllers: [CheckedController, OtherController] })
      class TwoControllerModule {}
      app = (await Test.createTestingModule({ imports: [TwoControllerModule] }).compile()).createNestApplication<NestExpressApplication>();
      await app.init();
      await request(app.getHttpServer()).get('/checked').expect(200);
      await request(app.getHttpServer()).get('/other').expect(200);
      expect(offWarnings(warn)).toHaveLength(1);
      warn.mockRestore();
    });

    it('is not logged when App Check is enforced', async () => {
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      await createApp({ NODE_ENV: 'development', FIREBASE_PROJECT_ID: 'project-one' });
      expect(offWarnings(warn)).toHaveLength(0);
      warn.mockRestore();
    });
  });

  it('shuts the SDK app down with the application (closing twice in a row does not throw)', async () => {
    await createApp({ NODE_ENV: 'development', FIREBASE_PROJECT_ID: 'project-one' });
    await expect(app!.close()).resolves.toBeUndefined();
  });
});
