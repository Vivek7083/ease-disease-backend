import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Controller, Get, Global, Logger, Module, Req, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppCheckGuard, type AppCheckedRequest } from '../src/auth/app-check.guard.js';
import { APP_CHECK_VERIFIER, AppCheckRejectedError, AppCheckUnavailableError } from '../src/auth/app-check-verifier.js';
import { FirebaseAuthGuard } from '../src/auth/firebase-auth.guard.js';
import { IDENTITY_VERIFIER } from '../src/auth/identity-verifier.js';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter.js';
import { RequestIdMiddleware } from '../src/common/middleware/request-id.middleware.js';
import { APP_ID, FakeAppCheckVerifier, SHAPED_APP_CHECK_TOKEN } from './helpers/app-check-kit.js';
import { FakeIdentityVerifier, SHAPED_TOKEN } from './helpers/identity-kit.js';

/** S2c: the guard over real HTTP with a scripted verifier. A counter proves that what sits behind it never runs for a rejected caller. */
describe('AppCheckGuard', () => {
  const verifier = new FakeAppCheckVerifier();
  const identityVerifier = new FakeIdentityVerifier();
  let app: NestExpressApplication;
  let handlerRuns: number;

  @Controller('checked')
  @UseGuards(AppCheckGuard)
  class CheckedController {
    @Get()
    ping(@Req() req: AppCheckedRequest) {
      handlerRuns++;
      return { appId: req.appCheck?.appId ?? null };
    }
  }

  /** The order the real routes use: App Check first, then login. */
  @Controller('both')
  @UseGuards(AppCheckGuard, FirebaseAuthGuard)
  class BothController {
    @Get()
    ping() {
      handlerRuns++;
      return { ok: true };
    }
  }

  const ENFORCED = { NODE_ENV: 'development', FIREBASE_PROJECT_ID: 'easedisease-test', APP_CHECK_MODE: 'enforce' };

  async function createApp(config: Record<string, unknown> = ENFORCED) {
    await app?.close();
    @Global()
    @Module({
      providers: [
        { provide: ConfigService, useValue: { get: (name: string) => config[name] } },
        { provide: APP_CHECK_VERIFIER, useValue: verifier },
        { provide: IDENTITY_VERIFIER, useValue: identityVerifier },
      ],
      exports: [ConfigService, APP_CHECK_VERIFIER, IDENTITY_VERIFIER],
    })
    class FakeInfraModule {}
    @Module({ imports: [FakeInfraModule], controllers: [CheckedController, BothController], providers: [AppCheckGuard, FirebaseAuthGuard] })
    class TestModule {}

    app = (await Test.createTestingModule({ imports: [TestModule] }).compile()).createNestApplication<NestExpressApplication>();
    const requestId = new RequestIdMiddleware();
    app.use((req: never, res: never, next: never) => requestId.use(req, res, next));
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    await app.listen(0, '127.0.0.1');
  }

  const get = (path = '/checked', token?: string) => {
    const req = request(app.getHttpServer()).get(path);
    return token === undefined ? req : req.set('X-Firebase-AppCheck', token);
  };
  /** Sends the header list exactly as given (Node would otherwise merge repeated names). */
  const getRaw = (path: string, headers: string[]) =>
    new Promise<{ status: number; body: { error?: { code: string; message: string; details: unknown; requestId: string } } }>((resolve, reject) => {
      const { port } = app.getHttpServer().address() as AddressInfo;
      const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers: ['Host', `127.0.0.1:${port}`, ...headers] }, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) }));
      });
      req.on('error', reject);
      req.end();
    });

  const expectDenied = async (pending: PromiseLike<{ status: number; body: { error?: unknown } }>) => {
    const response = await pending;
    expect(response.status).toBe(403);
    expect(response.body.error).toMatchObject({ code: 'APP_CHECK_FAILED', message: 'App verification failed' });
    expect(handlerRuns).toBe(0);
    return response;
  };

  let warn: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;
  beforeEach(async () => {
    handlerRuns = 0;
    verifier.calls.length = 0;
    identityVerifier.calls.length = 0;
    verifier.willReturn({ appId: APP_ID });
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    await createApp();
  });
  afterEach(async () => {
    warn.mockRestore();
    error.mockRestore();
    await app?.close();
  });

  describe('accepts', () => {
    it('a request with a token the verifier accepts, and exposes the app id to the handler', async () => {
      const res = await get('/checked', SHAPED_APP_CHECK_TOKEN).expect(200);
      expect(res.body).toEqual({ appId: APP_ID });
      expect(verifier.calls).toEqual([SHAPED_APP_CHECK_TOKEN]);
    });

    it('the header name in any letter case', async () => {
      await request(app.getHttpServer()).get('/checked').set('x-FIREBASE-appcheck', SHAPED_APP_CHECK_TOKEN).expect(200);
    });

    it('a header of exactly 4096 characters', async () => {
      const token = `${'a'.repeat(1364)}.${'b'.repeat(1364)}.${'c'.repeat(1366)}`;
      expect(token.length).toBe(4096);
      await get('/checked', token).expect(200);
    });
  });

  describe('denies with one identical 403 and never reaches the handler', () => {
    it('a missing header (the verifier is not even asked)', async () => {
      await expectDenied(get('/checked'));
      expect(verifier.calls).toHaveLength(0);
    });

    it.each([
      ['an empty header', ''],
      ['not a JWT', 'not-a-jwt'],
      ['two parts', 'aaaa.bbbb'],
      ['four parts', 'aaaa.bbbb.cccc.dddd'],
      ['an empty part', 'aaaa..cccc'],
      ['an empty signature (the emulator-style unsigned shape)', 'aaaa.bbbb.'],
      ['characters outside base64url', 'aa+a.bbbb.cccc'],
      ['a Bearer prefix', 'Bearer aaaa.bbbb.cccc'],
      ['a space inside', 'aaaa .bbbb.cccc'],
    ])('%s', async (_label, token) => {
      await expectDenied(token === '' ? getRaw('/checked', ['X-Firebase-AppCheck', '']) : get('/checked', token));
      expect(verifier.calls).toHaveLength(0);
    });

    it('4097 characters', async () => {
      const token = `${'a'.repeat(1365)}.${'b'.repeat(1365)}.${'c'.repeat(1365)}`;
      expect(token.length).toBe(4097);
      await expectDenied(get('/checked', token));
      expect(verifier.calls).toHaveLength(0);
    });

    it('two App Check headers, even when both are well-formed (Node joins them with a comma, so the shape check refuses)', async () => {
      await expectDenied(getRaw('/checked', ['X-Firebase-AppCheck', 'aaaa.bbbb.cccc', 'x-firebase-appcheck', 'dddd.eeee.ffff']));
      expect(verifier.calls).toHaveLength(0);
    });

    it('a token the verifier rejects', async () => {
      verifier.willReturn(new AppCheckRejectedError('expired'));
      await expectDenied(get('/checked', SHAPED_APP_CHECK_TOKEN));
    });

    it('an unexpected error from the verifier (fail closed)', async () => {
      verifier.willReturn(new Error('something nobody planned for'));
      await expectDenied(get('/checked', SHAPED_APP_CHECK_TOKEN));
    });

    it('a request that sends only a login token (a different header)', async () => {
      await expectDenied(get('/checked').set('Authorization', `Bearer ${SHAPED_TOKEN}`));
    });

    it('every denial has the same body shape and carries a request id, with no reason text', async () => {
      verifier.willReturn(new AppCheckRejectedError('SECRET-REASON-expired-at-noon'));
      const responses = [await get('/checked'), await get('/checked', 'garbage'), await get('/checked', SHAPED_APP_CHECK_TOKEN)];
      for (const response of responses) {
        expect(response.body.error).toEqual({ code: 'APP_CHECK_FAILED', message: 'App verification failed', details: {}, requestId: expect.any(String) });
        expect(JSON.stringify(response.body)).not.toContain('SECRET-REASON');
      }
    });
  });

  describe('Google unreachable', () => {
    it('is 503 APP_CHECK_UNAVAILABLE, never a pass and never the 403', async () => {
      verifier.willReturn(new AppCheckUnavailableError('Error fetching Json Web Keys: down'));
      const res = await get('/checked', SHAPED_APP_CHECK_TOKEN).expect(503);
      expect(res.body.error).toMatchObject({ code: 'APP_CHECK_UNAVAILABLE' });
      expect(handlerRuns).toBe(0);
    });
  });

  describe('configuration', () => {
    it('enforce with no Firebase project fails closed and never asks the verifier', async () => {
      await createApp({ NODE_ENV: 'development', APP_CHECK_MODE: 'enforce' });
      await expectDenied(get('/checked', SHAPED_APP_CHECK_TOKEN));
      expect(verifier.calls).toHaveLength(0);
    });

    it('mode unset behaves as enforce when a project exists and the token is missing', async () => {
      await createApp({ NODE_ENV: 'development', FIREBASE_PROJECT_ID: 'easedisease-test' });
      await expectDenied(get('/checked'));
    });

    it('mode off lets a request with no header through and never asks the verifier', async () => {
      await createApp({ NODE_ENV: 'development', FIREBASE_PROJECT_ID: 'easedisease-test', APP_CHECK_MODE: 'off' });
      await get('/checked').expect(200);
      expect(verifier.calls).toHaveLength(0);
    });

    // The start-up warning for mode off lives in AuthModule (one warning per start, not one per controller): see app-check-module.e2e-spec.ts.
  });

  describe('order with the login guard (App Check first)', () => {
    it('both valid: passes, and each verifier is asked once', async () => {
      await get('/both', SHAPED_APP_CHECK_TOKEN).set('Authorization', `Bearer ${SHAPED_TOKEN}`).expect(200);
      expect(verifier.calls).toHaveLength(1);
      expect(identityVerifier.calls).toHaveLength(1);
    });

    it('no App Check and no login: 403 APP_CHECK_FAILED, and the login verifier is never asked', async () => {
      await expectDenied(get('/both'));
      expect(identityVerifier.calls).toHaveLength(0);
    });

    it('login valid but App Check missing: 403, the login verifier is never asked', async () => {
      await expectDenied(get('/both').set('Authorization', `Bearer ${SHAPED_TOKEN}`));
      expect(identityVerifier.calls).toHaveLength(0);
    });

    it('App Check valid but no login: 401 UNAUTHENTICATED', async () => {
      const res = await get('/both', SHAPED_APP_CHECK_TOKEN).expect(401);
      expect(res.body.error).toMatchObject({ code: 'UNAUTHENTICATED' });
      expect(handlerRuns).toBe(0);
    });

    it('Google unreachable for App Check: 503 APP_CHECK_UNAVAILABLE before the login guard runs', async () => {
      verifier.willReturn(new AppCheckUnavailableError('down'));
      const res = await get('/both', SHAPED_APP_CHECK_TOKEN).set('Authorization', `Bearer ${SHAPED_TOKEN}`).expect(503);
      expect(res.body.error).toMatchObject({ code: 'APP_CHECK_UNAVAILABLE' });
      expect(identityVerifier.calls).toHaveLength(0);
    });
  });

  describe('logging', () => {
    it('never writes the token to the log, on denial or on outage', async () => {
      const secret = 'SECRETPART.SECRETPART.SECRETPART';
      verifier.willReturn(new AppCheckRejectedError('bad token'));
      await get('/checked', secret).expect(403);
      verifier.willReturn(new AppCheckUnavailableError('down'));
      await get('/checked', secret).expect(503);
      const logged = JSON.stringify([...warn.mock.calls, ...error.mock.calls]);
      expect(logged).not.toContain('SECRETPART');
    });

    it('strips control characters from a verifier reason so a log line cannot be forged', async () => {
      verifier.willReturn(new AppCheckRejectedError('line one\nFORGED LOG LINE\r'));
      await get('/checked', SHAPED_APP_CHECK_TOKEN).expect(403);
      const logged = warn.mock.calls.map((call: unknown[]) => String(call[0])).join('|');
      expect(logged).toContain('line one?FORGED LOG LINE?');
      expect(logged).not.toContain('\n');
    });

    it('truncates a very long reason', async () => {
      verifier.willReturn(new AppCheckRejectedError('x'.repeat(5000)));
      await get('/checked', SHAPED_APP_CHECK_TOKEN).expect(403);
      expect(warn.mock.calls.map((call: unknown[]) => String(call[0])).join('').length).toBeLessThan(400);
    });
  });
});
