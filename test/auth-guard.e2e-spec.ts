import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Controller, Get, Global, Logger, Module, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { CurrentIdentity } from '../src/auth/current-identity.decorator.js';
import { FirebaseAuthGuard, RequireFreshIdentity } from '../src/auth/firebase-auth.guard.js';
import { IDENTITY_VERIFIER, IdentityRejectedError, IdentityUnavailableError, type VerifiedIdentity } from '../src/auth/identity-verifier.js';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter.js';
import { RequestIdMiddleware } from '../src/common/middleware/request-id.middleware.js';
import { FakeIdentityVerifier, IDENTITY, SHAPED_TOKEN } from './helpers/identity-kit.js';

/**
 * S2b: the guard over real HTTP with a scripted verifier. A counter proves that what sits behind the guard never runs
 * for a rejected caller, and a call count proves malformed requests never reach the verifier at all.
 */
describe('FirebaseAuthGuard', () => {
  const verifier = new FakeIdentityVerifier();
  let app: NestExpressApplication;
  let handlerRuns: number;

  @Controller('secure')
  @UseGuards(FirebaseAuthGuard)
  class SecureController {
    @Get()
    whoami(@CurrentIdentity() identity: VerifiedIdentity) {
      handlerRuns++;
      return { identity };
    }

    @Get('fresh')
    @RequireFreshIdentity()
    fresh(@CurrentIdentity() identity: VerifiedIdentity) {
      handlerRuns++;
      return { identity };
    }
  }

  /** A route that forgot the guard but asks for the identity. */
  @Controller('forgot-the-guard')
  class ForgotTheGuardController {
    @Get()
    whoami(@CurrentIdentity() identity: VerifiedIdentity) {
      handlerRuns++;
      return { identity };
    }
  }

  const DEV_CONFIG = { NODE_ENV: 'development', FIREBASE_PROJECT_ID: 'easedisease-test' };

  async function createApp(config: Record<string, unknown> = DEV_CONFIG) {
    await app?.close();
    @Global()
    @Module({
      providers: [
        { provide: ConfigService, useValue: { get: (name: string) => config[name] } },
        { provide: IDENTITY_VERIFIER, useValue: verifier },
      ],
      exports: [ConfigService, IDENTITY_VERIFIER],
    })
    class FakeInfraModule {}
    @Module({ imports: [FakeInfraModule], controllers: [SecureController, ForgotTheGuardController], providers: [FirebaseAuthGuard] })
    class TestModule {}

    app = (await Test.createTestingModule({ imports: [TestModule] }).compile()).createNestApplication<NestExpressApplication>();
    const requestId = new RequestIdMiddleware();
    app.use((req: never, res: never, next: never) => requestId.use(req, res, next));
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.listen(0, '127.0.0.1');
  }

  const bearer = (token: string) => `Bearer ${token}`;
  /** A well-shaped Bearer header whose TOTAL length is exactly `total` characters. */
  const headerOfLength = (total: number) => {
    const remaining = total - 'Bearer '.length - 2; // minus the two dots
    const first = Math.floor(remaining / 3);
    const second = Math.floor(remaining / 3);
    return `Bearer ${'a'.repeat(first)}.${'b'.repeat(second)}.${'c'.repeat(remaining - first - second)}`;
  };
  const get = (path = '/secure', authorization?: string) => {
    const req = request(app.getHttpServer()).get(path);
    return authorization === undefined ? req : req.set('Authorization', authorization);
  };
  /** Sends the header list exactly as given (Node would otherwise merge or drop repeated names). */
  const getRaw = (path: string, headers: string[]) =>
    new Promise<{ status: number; body: { error?: { code: string; message: string; details: unknown; requestId: string } } & Record<string, unknown>; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
      const { port } = app.getHttpServer().address() as AddressInfo;
      const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers: ['Host', `127.0.0.1:${port}`, ...headers] }, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(data), headers: res.headers }));
      });
      req.on('error', reject);
      req.end();
    });

  const expectDenied = async (pending: PromiseLike<request.Response>) => {
    const response = await pending;
    expect(response.status).toBe(401);
    expect(response.body.error).toMatchObject({ code: 'UNAUTHENTICATED', message: 'Authentication required' });
    expect(handlerRuns).toBe(0);
    return response;
  };

  beforeEach(async () => {
    handlerRuns = 0;
    verifier.calls.length = 0;
    verifier.willReturn(IDENTITY);
    await createApp();
  });
  afterEach(async () => {
    await app?.close();
    vi.restoreAllMocks();
  });

  describe('accepts', () => {
    it('a token the verifier vouches for: the handler runs and receives the identity', async () => {
      const res = await get('/secure', bearer(SHAPED_TOKEN)).expect(200);
      expect(res.body).toEqual({ identity: IDENTITY });
      expect(handlerRuns).toBe(1);
    });

    it('hands the verifier exactly the token from the header, once, without the revocation lookup', async () => {
      await get('/secure', bearer(SHAPED_TOKEN)).expect(200);
      expect(verifier.calls).toEqual([{ token: SHAPED_TOKEN, options: { checkRevoked: false } }]);
    });

    it.each(['bearer', 'BEARER', 'Bearer', 'bEaReR'])('the scheme written as "%s"', async (scheme) => {
      await get('/secure', `${scheme} ${SHAPED_TOKEN}`).expect(200);
    });

    it('a token with every base64url character (letters, digits, - and _)', async () => {
      await get('/secure', bearer('Ab0-_.Cd1-_.Ef2-_')).expect(200);
    });
  });

  describe('refuses a malformed Authorization header with the same 401, and the verifier is never asked', () => {
    it.each([
      ['no header at all', undefined],
      ['an empty header', ''],
      ['the scheme alone', 'Bearer'],
      ['the scheme and a space', 'Bearer '],
      ['a different scheme', `Basic ${SHAPED_TOKEN}`],
      ['no scheme', SHAPED_TOKEN],
      ['two parts only', 'Bearer aaaa.bbbb'],
      ['four parts', 'Bearer aaaa.bbbb.cccc.dddd'],
      ['an empty last part (unsigned token)', 'Bearer aaaa.bbbb.'],
      ['an empty first part', 'Bearer .bbbb.cccc'],
      ['a space inside the token', 'Bearer aaaa.bb bb.cccc'],
      ['two spaces after the scheme', `Bearer  ${SHAPED_TOKEN}`],
      ['a character outside base64url', 'Bearer aaaa.bb+b.cccc'],
      ['an equals sign (padding)', 'Bearer aaaa.bbbb.cc=='],
      ['a token followed by more text', `Bearer ${SHAPED_TOKEN}, Bearer ${SHAPED_TOKEN}`],
      ['4097 characters (one over the limit)', headerOfLength(4097)],
      ['10000 characters', headerOfLength(10000)],
    ])('%s', async (_label, header) => {
      await expectDenied(get('/secure', header));
      expect(verifier.calls).toHaveLength(0);
    });

    it('a header of exactly 4096 characters is still within the limit (so only the shape decides)', async () => {
      const header = headerOfLength(4096);
      expect(header.length).toBe(4096);
      await get('/secure', header).expect(200);
    });

    it('two Authorization headers (Node would silently keep the first; a proxy may honour another)', async () => {
      const res = await getRaw('/secure', ['Authorization', bearer(SHAPED_TOKEN), 'Authorization', bearer(SHAPED_TOKEN)]);
      expect(res.status).toBe(401);
      expect(res.body.error).toMatchObject({ code: 'UNAUTHENTICATED' });
      expect(handlerRuns).toBe(0);
      expect(verifier.calls).toHaveLength(0);
    });

    it('trailing whitespace is stripped by the HTTP layer before the guard sees it, so it is harmless', async () => {
      await get('/secure', `Bearer ${SHAPED_TOKEN} `).expect(200);
    });

    it('a single Authorization header sent through the raw path still works (the raw path itself is sound)', async () => {
      const res = await getRaw('/secure', ['Authorization', bearer(SHAPED_TOKEN)]);
      expect(res.status).toBe(200);
    });
  });

  describe('unsigned tokens (the Firebase emulator format, ending with a dot)', () => {
    const UNSIGNED = 'aaaa.bbbb.';

    it.each(['development', 'test'])('are passed to the verifier in %s when the emulator is configured', async (nodeEnv) => {
      await createApp({ ...DEV_CONFIG, NODE_ENV: nodeEnv, FIREBASE_AUTH_EMULATOR_HOST: 'localhost:9099' });
      await get('/secure', bearer(UNSIGNED)).expect(200);
      expect(verifier.calls[0]?.token).toBe(UNSIGNED);
    });

    it.each(['development', 'test', 'staging', 'production'])('are refused in %s when the emulator is NOT configured', async (nodeEnv) => {
      await createApp({ ...DEV_CONFIG, NODE_ENV: nodeEnv });
      await expectDenied(get('/secure', bearer(UNSIGNED)));
      expect(verifier.calls).toHaveLength(0);
    });

    it.each(['staging', 'production'])('are refused in %s even if an emulator address somehow reached the config', async (nodeEnv) => {
      await createApp({ ...DEV_CONFIG, NODE_ENV: nodeEnv, FIREBASE_AUTH_EMULATOR_HOST: 'localhost:9099' });
      await expectDenied(get('/secure', bearer(UNSIGNED)));
      expect(verifier.calls).toHaveLength(0);
    });

    it.each([['an empty first part', 'Bearer .bbbb.'], ['an empty second part', 'Bearer aaaa..'], ['two parts', 'Bearer aaaa.bbbb'], ['four parts', 'Bearer aaaa.bbbb.cccc.dddd']])(
      'even then, %s is still refused',
      async (_label, header) => {
        await createApp({ ...DEV_CONFIG, FIREBASE_AUTH_EMULATOR_HOST: 'localhost:9099' });
        await expectDenied(get('/secure', header));
        expect(verifier.calls).toHaveLength(0);
      },
    );
  });

  describe('refuses with 401 when the verifier does not vouch for the token', () => {
    it('a rejected token', async () => {
      verifier.willReturn(new IdentityRejectedError('expired'));
      await expectDenied(get('/secure', bearer(SHAPED_TOKEN)));
      expect(verifier.calls).toHaveLength(1);
    });

    it('an unexpected error from the verifier (fails closed)', async () => {
      verifier.willReturn(new Error('something nobody planned for'));
      await expectDenied(get('/secure', bearer(SHAPED_TOKEN)));
    });

    it('a verifier that throws something that is not an Error', async () => {
      verifier.willReturn(() => {
        throw 'a string';
      });
      await expectDenied(get('/secure', bearer(SHAPED_TOKEN)));
    });

    it.each([
      ['staging', { NODE_ENV: 'staging' }],
      ['production', { NODE_ENV: 'production' }],
      ['development', { NODE_ENV: 'development' }],
      ['test', { NODE_ENV: 'test' }],
    ])('when Firebase is not configured (%s): the same 401 and the verifier is never asked', async (_label, env) => {
      await createApp({ ...env, FIREBASE_PROJECT_ID: undefined });
      await expectDenied(get('/secure', bearer(SHAPED_TOKEN)));
      expect(verifier.calls).toHaveLength(0);
    });
  });

  describe('gives no hint about WHY a token was refused', () => {
    it('every 401 cause produces a byte-identical response (apart from the request id)', async () => {
      const bodies: string[] = [];
      const lengths: string[] = [];
      const capture = async (pending: PromiseLike<request.Response>) => {
        const res = await expectDenied(pending);
        bodies.push(JSON.stringify({ ...res.body, error: { ...res.body.error, requestId: 'ID' } }));
        lengths.push(`${res.headers['content-type']}|${res.headers['content-length']}|${res.headers['www-authenticate'] ?? ''}`);
      };

      await capture(get('/secure'));
      await capture(get('/secure', 'Basic abc'));
      await capture(get('/secure', bearer('only.two')));
      await capture(get('/secure', `Bearer ${'a'.repeat(5000)}`));
      for (const failure of [
        new IdentityRejectedError('token has expired'),
        new IdentityRejectedError('token was revoked'),
        new IdentityRejectedError('wrong project'),
        new IdentityRejectedError('bad signature'),
        new Error('unknown failure'),
      ]) {
        verifier.willReturn(failure);
        await capture(get('/secure', bearer(SHAPED_TOKEN)));
      }
      await createApp({ ...DEV_CONFIG, FIREBASE_PROJECT_ID: undefined });
      await capture(get('/secure', bearer(SHAPED_TOKEN)));

      expect(new Set(bodies).size).toBe(1);
      expect(new Set(lengths).size).toBe(1);
      expect(bodies[0]).toBe('{"error":{"code":"UNAUTHENTICATED","message":"Authentication required","details":{},"requestId":"ID"}}');
    });
  });

  describe('verified email', () => {
    it.each([
      ['not verified', { ...IDENTITY, emailVerified: false }],
      ['missing', { ...IDENTITY, email: undefined }],
      ['empty', { ...IDENTITY, email: '' }],
      ['blank', { ...IDENTITY, email: '   ' }],
      ['missing and flagged verified', { ...IDENTITY, email: undefined, emailVerified: true }],
    ])('an email that is %s: 403 EMAIL_NOT_VERIFIED and the handler does not run', async (_label, identity) => {
      verifier.willReturn(identity);
      const res = await get('/secure', bearer(SHAPED_TOKEN)).expect(403);
      expect(res.body.error).toMatchObject({ code: 'EMAIL_NOT_VERIFIED' });
      expect(handlerRuns).toBe(0);
    });

    it('is decided only after the token is proven: a bad token with an unverified email is still 401', async () => {
      verifier.willReturn(new IdentityRejectedError('bad signature'));
      await expectDenied(get('/secure', bearer(SHAPED_TOKEN)));
    });

    it('applies to every guarded route, not only one', async () => {
      verifier.willReturn({ ...IDENTITY, emailVerified: false });
      await get('/secure/fresh', bearer(SHAPED_TOKEN)).expect(403);
    });
  });

  describe('when Google cannot be reached', () => {
    it('answers 503 AUTH_UNAVAILABLE (not 401, not a pass) and the handler does not run', async () => {
      verifier.willReturn(new IdentityUnavailableError('network down'));
      const res = await get('/secure', bearer(SHAPED_TOKEN)).expect(503);
      expect(res.body.error).toMatchObject({ code: 'AUTH_UNAVAILABLE', message: 'Authentication is temporarily unavailable' });
      expect(handlerRuns).toBe(0);
    });

    it('does not leak the reason in the body', async () => {
      verifier.willReturn(new IdentityUnavailableError('getaddrinfo ENOTFOUND www.googleapis.com'));
      const res = await get('/secure', bearer(SHAPED_TOKEN)).expect(503);
      expect(JSON.stringify(res.body)).not.toContain('googleapis');
    });
  });

  describe('@RequireFreshIdentity (revoked or disabled accounts)', () => {
    it.each(['staging', 'production'])('asks the verifier to check revocation on a marked route in %s', async (nodeEnv) => {
      await createApp({ ...DEV_CONFIG, NODE_ENV: nodeEnv });
      await get('/secure/fresh', bearer(SHAPED_TOKEN)).expect(200);
      expect(verifier.calls[0]?.options).toEqual({ checkRevoked: true });
    });

    it.each(['development', 'test'])('does not in %s (a laptop has no Google credentials for that lookup)', async (nodeEnv) => {
      await createApp({ ...DEV_CONFIG, NODE_ENV: nodeEnv });
      await get('/secure/fresh', bearer(SHAPED_TOKEN)).expect(200);
      expect(verifier.calls[0]?.options).toEqual({ checkRevoked: false });
    });

    it.each(['development', 'test', 'staging', 'production'])('never asks on an unmarked route (%s)', async (nodeEnv) => {
      await createApp({ ...DEV_CONFIG, NODE_ENV: nodeEnv });
      await get('/secure', bearer(SHAPED_TOKEN)).expect(200);
      expect(verifier.calls[0]?.options).toEqual({ checkRevoked: false });
    });

    it('a revoked or disabled account is refused with the same 401', async () => {
      await createApp({ ...DEV_CONFIG, NODE_ENV: 'production' });
      verifier.willReturn((_token, options) => (options?.checkRevoked ? new IdentityRejectedError('revoked') : IDENTITY));
      await expectDenied(get('/secure/fresh', bearer(SHAPED_TOKEN)));
      // The very same token still passes on a route that does not ask for the lookup.
      await get('/secure', bearer(SHAPED_TOKEN)).expect(200);
    });

    it('the revocation lookup being unavailable is 503, not a pass', async () => {
      await createApp({ ...DEV_CONFIG, NODE_ENV: 'production' });
      verifier.willReturn(new IdentityUnavailableError('app/invalid-credential'));
      await get('/secure/fresh', bearer(SHAPED_TOKEN)).expect(503);
      expect(handlerRuns).toBe(0);
    });
  });

  describe('@CurrentIdentity', () => {
    it('a route that forgot the guard is refused with the same 401 instead of getting an undefined identity', async () => {
      const res = await expectDenied(get('/forgot-the-guard', bearer(SHAPED_TOKEN)));
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
      expect(verifier.calls).toHaveLength(0);
    });
  });

  describe('logging', () => {
    const captureLogs = () => {
      const lines: string[] = [];
      for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
        vi.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(' ')));
      }
      return lines;
    };

    it('a refused request never writes the token or the email to the log', async () => {
      const lines = captureLogs();
      const token = 'secretpart1.secretpart2.secretpart3';
      verifier.willReturn(new IdentityRejectedError('bad signature'));
      await get('/secure', bearer(token)).expect(401);
      await get('/secure', `Bearer ${'secretpart1.'.repeat(500)}`).expect(401);
      expect(lines.length).toBeGreaterThan(0);
      const everything = lines.join('\n');
      expect(everything).not.toContain('secretpart');
      expect(everything).not.toContain(IDENTITY.email);
    });

    it('a verifier message with line breaks or control characters cannot forge log lines', async () => {
      const lines = captureLogs();
      verifier.willReturn(new IdentityRejectedError('bad\nWARN forged line\r\u0007 end'));
      await get('/secure', bearer(SHAPED_TOKEN)).expect(401);
      const joined = lines.join('|');
      expect(joined).toContain('bad?WARN forged line?? end');
      for (const control of ['\n', '\r', '\u0007']) expect(joined.includes(control)).toBe(false);
    });

    it('a very long verifier message is cut', async () => {
      const lines = captureLogs();
      verifier.willReturn(new IdentityRejectedError('x'.repeat(5000)));
      await get('/secure', bearer(SHAPED_TOKEN)).expect(401);
      expect(lines.every((line) => line.length < 400)).toBe(true);
    });

    it('a successful request writes nothing about the caller', async () => {
      const lines = captureLogs();
      await get('/secure', bearer(SHAPED_TOKEN)).expect(200);
      expect(lines.join('\n')).not.toContain(IDENTITY.email);
      expect(lines.join('\n')).not.toContain(IDENTITY.uid);
    });
  });

  describe('concurrency', () => {
    it('50 simultaneous requests each get their own identity (nothing leaks between requests)', async () => {
      verifier.willReturn((token) => ({ ...IDENTITY, uid: `uid-${token.split('.')[2]}`, email: `${token.split('.')[2]}@example.com` }));
      const responses = await Promise.all(Array.from({ length: 50 }, (_, index) => get('/secure', bearer(`aaaa.bbbb.u${index}`))));
      responses.forEach((res, index) => {
        expect(res.status).toBe(200);
        expect(res.body.identity).toMatchObject({ uid: `uid-u${index}`, email: `u${index}@example.com` });
      });
      expect(handlerRuns).toBe(50);
    });

    it('a mix of good and bad callers at the same time: bad ones never reach the handler', async () => {
      verifier.willReturn((token) => (token.endsWith('.bad') ? new IdentityRejectedError('bad') : IDENTITY));
      const responses = await Promise.all(Array.from({ length: 40 }, (_, index) => get('/secure', bearer(index % 2 === 0 ? 'aaaa.bbbb.good' : 'aaaa.bbbb.bad'))));
      expect(responses.filter((res) => res.status === 200)).toHaveLength(20);
      expect(responses.filter((res) => res.status === 401)).toHaveLength(20);
      expect(handlerRuns).toBe(20);
    });
  });
});
