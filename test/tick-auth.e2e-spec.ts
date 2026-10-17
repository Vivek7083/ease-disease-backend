import { Controller, Global, HttpCode, Module, Post, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter.js';
import { RequestIdMiddleware } from '../src/common/middleware/request-id.middleware.js';
import { OIDC_VERIFIER, type OidcVerifier } from '../src/internal/oidc-verifier.js';
import { TickAuthGuard } from '../src/internal/tick-auth.guard.js';
import { AUDIENCE, SCHEDULER_ACCOUNT, createOidcKit } from './helpers/oidc-kit.js';

/**
 * R3: who may call the internal tick. Real tokens signed with a local RSA key go through the real Google verifier
 * (signature, issuer, audience, expiry) and the real guard, over real HTTP. A counter proves what sits behind the
 * guard never runs for a rejected caller.
 */
describe('TickAuthGuard + GoogleOidcVerifier', () => {
  const kit = createOidcKit();
  let app: NestExpressApplication;
  let behindGuard: number;

  @Controller('guarded')
  @UseGuards(TickAuthGuard)
  class GuardedController {
    @Post()
    @HttpCode(200)
    run() {
      behindGuard++;
      return { ran: true };
    }
  }

  async function createApp(config: Record<string, unknown>, verifier: OidcVerifier = kit.verifier) {
    @Global()
    @Module({
      providers: [
        { provide: ConfigService, useValue: { get: (name: string) => config[name] } },
        { provide: OIDC_VERIFIER, useValue: verifier },
      ],
      exports: [ConfigService, OIDC_VERIFIER],
    })
    class FakeInfraModule {}
    @Module({ imports: [FakeInfraModule], controllers: [GuardedController], providers: [TickAuthGuard] })
    class TestModule {}

    app = (await Test.createTestingModule({ imports: [TestModule] }).compile()).createNestApplication<NestExpressApplication>();
    const requestId = new RequestIdMiddleware();
    app.use((req: never, res: never, next: never) => requestId.use(req, res, next));
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  }

  const CONFIG = { TICK_AUDIENCE: AUDIENCE, TICK_SERVICE_ACCOUNT_EMAIL: SCHEDULER_ACCOUNT };
  const call = (authorization?: string) => {
    const req = request(app.getHttpServer()).post('/guarded');
    return authorization === undefined ? req : req.set('Authorization', authorization);
  };
  const bearer = (token: string) => `Bearer ${token}`;
  const expectRejected = async (pending: PromiseLike<request.Response>) => {
    const response = await pending;
    expect(response.status).toBe(401);
    expect(response.body.error).toMatchObject({ code: 'UNAUTHENTICATED', message: 'Authentication required' });
    expect(behindGuard).toBe(0);
    return response;
  };

  beforeEach(async () => {
    behindGuard = 0;
    await createApp(CONFIG);
  });
  afterEach(async () => {
    await app?.close();
  });

  describe('accepts', () => {
    it('a genuine token for the scheduler account and this audience', async () => {
      const res = await call(bearer(kit.mint())).expect(200);
      expect(res.body).toEqual({ ran: true });
      expect(behindGuard).toBe(1);
    });

    it('the Bearer scheme in any letter case, and the email in any letter case', async () => {
      await call(`bearer ${kit.mint()}`).expect(200);
      await call(bearer(kit.mint({ email: SCHEDULER_ACCOUNT.toUpperCase() }))).expect(200);
    });

    it('also the second issuer spelling Google uses', async () => {
      await call(bearer(kit.mint({ iss: 'accounts.google.com' }))).expect(200);
    });
  });

  describe('rejects with one identical 401 whatever the reason, and runs nothing behind the guard', () => {
    it.each([
      ['no Authorization header', undefined],
      ['an empty header', ''],
      ['the Basic scheme', 'Basic dXNlcjpwYXNz'],
      ['Bearer with nothing after it', 'Bearer '],
      ['Bearer with a non-JWT', 'Bearer not-a-jwt'],
      ['Bearer with two parts', 'Bearer aaa.bbb'],
      ['Bearer with four parts', 'Bearer a.b.c.d'],
      ['a token with a space inside', 'Bearer aaa bbb.ccc.ddd'],
      ['an oversized header', `Bearer ${'a'.repeat(5000)}.b.c`],
    ])('%s', async (_name, header) => {
      await expectRejected(call(header));
    });

    it('a genuine token sent without the Bearer scheme', async () => {
      await expectRejected(call(kit.mint()));
      await expectRejected(call(`Token ${kit.mint()}`));
      await expectRejected(call(`Bearer  ${kit.mint()}`));
    });

    it('malformed and oversized headers never reach the verifier (no work is done for them)', async () => {
      const verify = vi.fn(kit.verifier.verify.bind(kit.verifier));
      await app.close();
      await createApp(CONFIG, { verify });

      for (const header of [`Bearer ${'a'.repeat(5000)}.b.c`, `Bearer ${'a'.repeat(100)}.b.c.d`, 'Bearer not-a-jwt', kit.mint(), 'Bearer ']) {
        await expectRejected(call(header));
      }
      expect(verify).not.toHaveBeenCalled();

      await call(bearer(kit.mint())).expect(200);
      expect(verify).toHaveBeenCalledOnce();
    });

    it('a token whose payload was changed after signing (signature no longer matches)', async () => {
      await expectRejected(call(bearer(kit.mint({}, { tamperPayload: { email: 'attacker@example.com' } }))));
    });

    it('a token signed by a key Google never published', async () => {
      await expectRejected(call(bearer(kit.mint({}, { signWith: 'evil' }))));
    });

    it('an unknown key id, and no key id', async () => {
      await expectRejected(call(bearer(kit.mint({}, { kid: 'some-other-key' }))));
      await expectRejected(call(bearer(kit.mint({}, { kid: null }))));
    });

    it('algorithm "none" (unsigned) and an HMAC made with the public key as secret', async () => {
      await expectRejected(call(bearer(kit.mint({}, { alg: 'none' }))));
      await expectRejected(call(bearer(kit.mint({}, { alg: 'HS256' }))));
    });

    it('the wrong audience, and a missing one', async () => {
      await expectRejected(call(bearer(kit.mint({ aud: 'https://evil.example.com' }))));
      await expectRejected(call(bearer(kit.mint({ aud: undefined }))));
    });

    it('the wrong issuer, and a missing one', async () => {
      await expectRejected(call(bearer(kit.mint({ iss: 'https://evil.example.com' }))));
      await expectRejected(call(bearer(kit.mint({ iss: undefined }))));
    });

    it('an expired token', async () => {
      const now = Math.floor(Date.now() / 1000);
      await expectRejected(call(bearer(kit.mint({ iat: now - 7200, exp: now - 3600 }))));
    });

    it('a token that is not valid yet (issued in the future)', async () => {
      const now = Math.floor(Date.now() / 1000);
      await expectRejected(call(bearer(kit.mint({ iat: now + 3600, exp: now + 7200 }))));
    });

    it('a token with no expiry', async () => {
      await expectRejected(call(bearer(kit.mint({ exp: undefined }))));
    });

    it('a genuine Google token for a different service account', async () => {
      await expectRejected(call(bearer(kit.mint({ email: 'someone-else@easedisease-prod.iam.gserviceaccount.com' }))));
    });

    it('an email that only looks like the right one', async () => {
      await expectRejected(call(bearer(kit.mint({ email: `x${SCHEDULER_ACCOUNT}` }))));
      await expectRejected(call(bearer(kit.mint({ email: `${SCHEDULER_ACCOUNT}.evil.com` }))));
      await expectRejected(call(bearer(kit.mint({ email: [SCHEDULER_ACCOUNT] }))));
    });

    it('a token without an email, or with an unverified one', async () => {
      await expectRejected(call(bearer(kit.mint({ email: undefined }))));
      await expectRejected(call(bearer(kit.mint({ email_verified: false }))));
      await expectRejected(call(bearer(kit.mint({ email_verified: 'true' }))));
      await expectRejected(call(bearer(kit.mint({ email_verified: undefined }))));
    });

    it('never says why: the body is identical for every rejection', async () => {
      const strip = (body: { error: Record<string, unknown> }) => ({ ...body, error: { ...body.error, requestId: undefined } });
      const bodies = [
        strip((await call()).body),
        strip((await call(bearer(kit.mint({ aud: 'x' })))).body),
        strip((await call(bearer(kit.mint({ email: 'other@example.com' })))).body),
      ];
      expect(bodies[1]).toEqual(bodies[0]);
      expect(bodies[2]).toEqual(bodies[0]);
    });
  });

  describe('fails closed when the verifier itself breaks', () => {
    it('Google keys unreachable / verifier throws -> 401, not 500, and nothing runs', async () => {
      await app.close();
      await createApp(CONFIG, { verify: () => Promise.reject(new Error('certs download failed')) });
      await expectRejected(call(bearer(kit.mint())));
    });

    it('a verifier that returns nothing useful is not an approval', async () => {
      await app.close();
      await createApp(CONFIG, { verify: () => Promise.resolve({ email: undefined, emailVerified: false }) });
      await expectRejected(call(bearer(kit.mint())));
    });
  });

  describe('fails closed when not configured', () => {
    it.each([
      ['both missing', {}],
      ['audience missing', { TICK_SERVICE_ACCOUNT_EMAIL: SCHEDULER_ACCOUNT }],
      ['service account missing', { TICK_AUDIENCE: AUDIENCE }],
      ['both empty', { TICK_AUDIENCE: '', TICK_SERVICE_ACCOUNT_EMAIL: '' }],
    ])('%s: even a perfect token is refused', async (_name, config) => {
      await app.close();
      await createApp(config);
      await expectRejected(call(bearer(kit.mint())));
    });
  });
});
