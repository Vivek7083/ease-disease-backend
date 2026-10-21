import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Controller, Get, Global, Module, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AuthModule } from '../src/auth/auth.module.js';
import { CurrentIdentity } from '../src/auth/current-identity.decorator.js';
import { FirebaseAuthGuard } from '../src/auth/firebase-auth.guard.js';
import { FirebaseIdentityVerifier, UnconfiguredIdentityVerifier } from '../src/auth/firebase-identity-verifier.js';
import { IDENTITY_VERIFIER, type VerifiedIdentity } from '../src/auth/identity-verifier.js';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter.js';
import { RequestIdMiddleware } from '../src/common/middleware/request-id.middleware.js';

/**
 * S2b wiring: the REAL AuthModule (its factory, the guard, the verifier, the SDK app) built from config. A stand-in
 * for the Firebase Auth emulator answers on a local port, so the real factory can be exercised without Google.
 * In emulator mode the SDK skips the signature check but still enforces project and issuer, which is exactly what
 * these tests need: they prove the configured project id really reaches the SDK.
 */
describe('AuthModule wiring', () => {
  const base64url = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsignedToken = (projectId: string, uid = 'uid-from-emulator') => {
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      iss: `https://securetoken.google.com/${projectId}`,
      aud: projectId,
      sub: uid,
      user_id: uid,
      iat: now - 5,
      auth_time: now - 5,
      exp: now + 3000,
      email: 'priya@example.com',
      email_verified: true,
      firebase: { sign_in_provider: 'google.com', identities: {} },
    };
    return `${base64url({ alg: 'none', typ: 'JWT' })}.${base64url(claims)}.`;
  };

  let emulator: http.Server | undefined;
  let app: NestExpressApplication | undefined;
  const savedHost = process.env['FIREBASE_AUTH_EMULATOR_HOST'];

  @Controller('secure')
  @UseGuards(FirebaseAuthGuard)
  class SecureController {
    @Get()
    whoami(@CurrentIdentity() identity: VerifiedIdentity) {
      return { identity };
    }
  }

  /** `knownUid`: what the stand-in emulator says exists. `null` means it knows nobody. */
  async function startEmulator(knownUid: string | null) {
    emulator = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(knownUid ? { users: [{ localId: knownUid, email: 'priya@example.com', emailVerified: true, validSince: '0' }] } : {}));
      });
    });
    await new Promise<void>((resolve) => emulator!.listen(0, '127.0.0.1', resolve));
    process.env['FIREBASE_AUTH_EMULATOR_HOST'] = `127.0.0.1:${(emulator.address() as AddressInfo).port}`;
  }

  async function createApp(config: Record<string, unknown>) {
    @Global()
    @Module({
      providers: [{ provide: ConfigService, useValue: { get: (name: string) => config[name] } }],
      exports: [ConfigService],
    })
    class FakeConfigModule {}
    @Module({ imports: [FakeConfigModule, AuthModule], controllers: [SecureController] })
    class TestModule {}

    const moduleRef = await Test.createTestingModule({ imports: [TestModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    const requestId = new RequestIdMiddleware();
    app.use((req: never, res: never, next: never) => requestId.use(req, res, next));
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    return moduleRef;
  }

  /** Config for a run against the stand-in emulator: the SDK reads the environment variable, the guard reads config. */
  const emulatorConfig = () => ({ NODE_ENV: 'development', FIREBASE_PROJECT_ID: 'project-one', FIREBASE_AUTH_EMULATOR_HOST: process.env['FIREBASE_AUTH_EMULATOR_HOST'] });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    await new Promise<void>((resolve) => (emulator ? emulator.close(() => resolve()) : resolve()));
    emulator = undefined;
    if (savedHost === undefined) delete process.env['FIREBASE_AUTH_EMULATOR_HOST'];
    else process.env['FIREBASE_AUTH_EMULATOR_HOST'] = savedHost;
  });

  describe('without FIREBASE_PROJECT_ID (possible only in development and test)', () => {
    it('uses the refuse-everything verifier and every request is a 401', async () => {
      const moduleRef = await createApp({ NODE_ENV: 'development' });
      expect(moduleRef.get(IDENTITY_VERIFIER)).toBeInstanceOf(UnconfiguredIdentityVerifier);
      const res = await request(app!.getHttpServer()).get('/secure').set('Authorization', `Bearer ${unsignedToken('anything')}`).expect(401);
      expect(res.body.error).toMatchObject({ code: 'UNAUTHENTICATED', requestId: expect.any(String) });
    });
  });

  describe('with FIREBASE_PROJECT_ID', () => {
    it('builds the real Firebase verifier', async () => {
      const moduleRef = await createApp({ NODE_ENV: 'development', FIREBASE_PROJECT_ID: 'project-one' });
      expect(moduleRef.get(IDENTITY_VERIFIER)).toBeInstanceOf(FirebaseIdentityVerifier);
    });

    it('accepts a token for the configured project (the project id reached the SDK) and exposes the identity', async () => {
      await startEmulator('uid-from-emulator');
      await createApp(emulatorConfig());
      const res = await request(app!.getHttpServer()).get('/secure').set('Authorization', `Bearer ${unsignedToken('project-one')}`).expect(200);
      expect(res.body.identity).toEqual({
        uid: 'uid-from-emulator',
        email: 'priya@example.com',
        emailVerified: true,
        name: undefined,
        signInProvider: 'google.com',
      });
    });

    it('refuses a token minted for a different project, even though the stand-in knows the uid', async () => {
      await startEmulator('uid-from-emulator');
      await createApp(emulatorConfig());
      await request(app!.getHttpServer()).get('/secure').set('Authorization', `Bearer ${unsignedToken('project-two')}`).expect(401);
    });

    it('refuses a token for the right project when the stand-in does not know the user', async () => {
      await startEmulator(null);
      await createApp(emulatorConfig());
      await request(app!.getHttpServer()).get('/secure').set('Authorization', `Bearer ${unsignedToken('project-one')}`).expect(401);
    });

    it('shuts the SDK app down with the application (closing twice in a row does not throw)', async () => {
      await createApp({ NODE_ENV: 'development', FIREBASE_PROJECT_ID: 'project-one' });
      await expect(app!.close()).resolves.toBeUndefined();
    });
  });
});
