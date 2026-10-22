import { randomUUID } from 'node:crypto';
import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { APP_CHECK_VERIFIER, AppCheckRejectedError, AppCheckUnavailableError } from '../src/auth/app-check-verifier.js';
import { IDENTITY_VERIFIER, IdentityRejectedError, IdentityUnavailableError, type VerifiedIdentity } from '../src/auth/identity-verifier.js';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter.js';
import { RequestIdMiddleware } from '../src/common/middleware/request-id.middleware.js';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { UsersModule } from '../src/users/users.module.js';
import { FakeAppCheckVerifier, SHAPED_APP_CHECK_TOKEN } from './helpers/app-check-kit.js';
import { FakeIdentityVerifier, IDENTITY, SHAPED_TOKEN } from './helpers/identity-kit.js';
import { createTestPrisma, truncateAll } from './helpers/test-db.js';

/**
 * S2d: POST /v1/auth/sync and GET /v1/me over real HTTP on the real `_test` Postgres, behind the REAL guards with
 * scripted verifiers (the verifiers themselves are covered in S2b/S2c).
 */
describe('POST /v1/auth/sync and GET /v1/me', () => {
  let prisma: PrismaClient;
  let app: NestExpressApplication;
  const identityVerifier = new FakeIdentityVerifier();
  const appCheckVerifier = new FakeAppCheckVerifier();

  beforeAll(async () => {
    prisma = createTestPrisma();
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
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    const requestId = new RequestIdMiddleware();
    app.use((req: never, res: never, next: never) => requestId.use(req, res, next));
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    await app.listen(0, '127.0.0.1');
  });
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  let warn: ReturnType<typeof vi.spyOn>;
  let errorLog: ReturnType<typeof vi.spyOn>;
  beforeEach(async () => {
    await truncateAll(prisma);
    identityVerifier.calls.length = 0;
    identityVerifier.willReturn(IDENTITY);
    appCheckVerifier.calls.length = 0;
    appCheckVerifier.willReturn({ appId: 'app' });
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    errorLog = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    warn.mockRestore();
    errorLog.mockRestore();
  });

  const identity = (overrides: Partial<VerifiedIdentity> = {}): VerifiedIdentity => ({ ...IDENTITY, ...overrides });
  const sync = () => request(app.getHttpServer()).post('/v1/auth/sync').set('X-Firebase-AppCheck', SHAPED_APP_CHECK_TOKEN).set('Authorization', `Bearer ${SHAPED_TOKEN}`);
  const me = () => request(app.getHttpServer()).get('/v1/me').set('Authorization', `Bearer ${SHAPED_TOKEN}`);
  const rowFor = (uid: string) => prisma.user.findUnique({ where: { firebaseUid: uid } });
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  describe('sync: first sign-in', () => {
    it('creates exactly one row and answers 200 with the exact contract shape', async () => {
      const res = await sync().expect(200);
      expect(res.body).toEqual({
        user: {
          id: expect.stringMatching(/^[0-9a-f-]{36}$/),
          email: 'priya@example.com',
          name: 'Priya Sharma',
          phone: null,
          dob: null,
          authProvider: 'google.com',
          lastAuthProvider: 'google.com',
        },
        profileComplete: false,
      });
      expect(await prisma.user.count()).toBe(1);
      const row = await rowFor(IDENTITY.uid);
      expect(row).toMatchObject({ id: res.body.user.id, email: 'priya@example.com', name: 'Priya Sharma', authProvider: 'google.com', lastAuthProvider: 'google.com' });
      expect(row?.lastLoginAt).toBeInstanceOf(Date);
    });

    it('sends Cache-Control: no-store', async () => {
      expect((await sync().expect(200)).headers['cache-control']).toBe('no-store');
    });

    it('lower-cases and trims the email', async () => {
      identityVerifier.willReturn(identity({ email: '  Priya.SHARMA@Example.COM ' }));
      const res = await sync().expect(200);
      expect(res.body.user.email).toBe('priya.sharma@example.com');
      expect((await rowFor(IDENTITY.uid))?.email).toBe('priya.sharma@example.com');
    });

    it('maps the email-link provider (password) to emailLink for both columns', async () => {
      identityVerifier.willReturn(identity({ signInProvider: 'password', name: undefined }));
      const res = await sync().expect(200);
      expect(res.body.user).toMatchObject({ authProvider: 'emailLink', lastAuthProvider: 'emailLink', name: null });
    });

    it('a token with no name leaves the name null', async () => {
      identityVerifier.willReturn(identity({ name: undefined }));
      expect((await sync().expect(200)).body.user.name).toBeNull();
    });

    it('cleans a messy token name (control characters, spacing, length)', async () => {
      identityVerifier.willReturn(identity({ name: `  Priya\n\u0000 ${'x'.repeat(200)}` }));
      const name = (await sync().expect(200)).body.user.name as string;
      expect(name.startsWith('Priya ')).toBe(true);
      expect(name.length).toBeLessThanOrEqual(100);
      expect(Array.from(name).some((character) => character.charCodeAt(0) < 32)).toBe(false);
    });

    it('a token name that is only control characters leaves the name null', async () => {
      identityVerifier.willReturn(identity({ name: '\u0000​ ' }));
      expect((await sync().expect(200)).body.user.name).toBeNull();
    });

    it('stores a Unicode name as-is', async () => {
      identityVerifier.willReturn(identity({ name: 'प्रिया शर्मा' }));
      expect((await sync().expect(200)).body.user.name).toBe('प्रिया शर्मा');
    });
  });

  describe('sync: later sign-ins', () => {
    it('does not duplicate the row, keeps the same id, and moves last_login_at forward', async () => {
      const first = await sync().expect(200);
      const before = (await rowFor(IDENTITY.uid))!.lastLoginAt!;
      await wait(15);
      const second = await sync().expect(200);
      expect(second.body.user.id).toBe(first.body.user.id);
      expect(await prisma.user.count()).toBe(1);
      expect((await rowFor(IDENTITY.uid))!.lastLoginAt!.getTime()).toBeGreaterThan(before.getTime());
    });

    it('fills the name from the token only while the stored name is empty', async () => {
      identityVerifier.willReturn(identity({ name: undefined }));
      await sync().expect(200);
      identityVerifier.willReturn(identity({ name: 'Priya Sharma' }));
      expect((await sync().expect(200)).body.user.name).toBe('Priya Sharma');
    });

    it('fills the name when the stored name is an empty string', async () => {
      await sync().expect(200);
      await prisma.user.update({ where: { firebaseUid: IDENTITY.uid }, data: { name: '' } });
      identityVerifier.willReturn(identity({ name: 'Priya Sharma' }));
      expect((await sync().expect(200)).body.user.name).toBe('Priya Sharma');
    });

    it('never overwrites a name the person edited, even when the token carries a different one', async () => {
      await sync().expect(200);
      await prisma.user.update({ where: { firebaseUid: IDENTITY.uid }, data: { name: 'Priya S (edited)' } });
      identityVerifier.willReturn(identity({ name: 'Totally Different' }));
      expect((await sync().expect(200)).body.user.name).toBe('Priya S (edited)');
    });

    it('keeps the stored name when the token has none', async () => {
      await sync().expect(200);
      identityVerifier.willReturn(identity({ name: undefined }));
      expect((await sync().expect(200)).body.user.name).toBe('Priya Sharma');
    });

    it('never touches phone or dob', async () => {
      await sync().expect(200);
      await prisma.user.update({ where: { firebaseUid: IDENTITY.uid }, data: { phone: '+919876543210', dob: new Date('1990-04-12') } });
      const res = await sync().expect(200);
      expect(res.body.user).toMatchObject({ phone: '+919876543210', dob: '1990-04-12' });
      expect(res.body.profileComplete).toBe(true);
    });

    it('follows a changed verified email (lower-cased)', async () => {
      await sync().expect(200);
      identityVerifier.willReturn(identity({ email: 'New.Address@Example.com' }));
      const res = await sync().expect(200);
      expect(res.body.user.email).toBe('new.address@example.com');
      expect(await prisma.user.count()).toBe(1);
    });

    it('keeps the first sign-up method and moves the latest one', async () => {
      await sync().expect(200);
      identityVerifier.willReturn(identity({ signInProvider: 'password' }));
      const res = await sync().expect(200);
      expect(res.body.user).toMatchObject({ authProvider: 'google.com', lastAuthProvider: 'emailLink' });
      identityVerifier.willReturn(identity({ signInProvider: 'google.com' }));
      expect((await sync().expect(200)).body.user).toMatchObject({ authProvider: 'google.com', lastAuthProvider: 'google.com' });
    });
  });

  describe('sync: two accounts and concurrency', () => {
    it('two different Firebase accounts with the same email are two rows, and each sees only its own', async () => {
      identityVerifier.willReturn(identity({ uid: 'uid-a', name: 'Account A' }));
      const a = await sync().expect(200);
      identityVerifier.willReturn(identity({ uid: 'uid-b', name: 'Account B' }));
      const b = await sync().expect(200);
      expect(a.body.user.id).not.toBe(b.body.user.id);
      expect(await prisma.user.count()).toBe(2);
      identityVerifier.willReturn(identity({ uid: 'uid-a' }));
      expect((await me().expect(200)).body.user).toMatchObject({ id: a.body.user.id, name: 'Account A' });
      identityVerifier.willReturn(identity({ uid: 'uid-b' }));
      expect((await me().expect(200)).body.user).toMatchObject({ id: b.body.user.id, name: 'Account B' });
    });

    it('20 simultaneous first sign-ins of one account create one row and every call succeeds (repeated for 5 accounts)', async () => {
      for (let round = 0; round < 5; round++) {
        const uid = `uid-race-${round}`;
        identityVerifier.willReturn(identity({ uid }));
        const responses = await Promise.all(Array.from({ length: 20 }, () => sync()));
        expect(responses.map((r) => r.status)).toEqual(Array(20).fill(200));
        expect(await prisma.user.count({ where: { firebaseUid: uid } })).toBe(1);
        expect(new Set(responses.map((r) => r.body.user.id)).size).toBe(1);
      }
    });

    it('simultaneous first sign-ins with different methods leave one row whose first method is one of them', async () => {
      identityVerifier.willReturn((_token) => identity({ signInProvider: Math.random() < 0.5 ? 'google.com' : 'password' }));
      const responses = await Promise.all(Array.from({ length: 10 }, () => sync()));
      expect(responses.map((r) => r.status)).toEqual(Array(10).fill(200));
      const rows = await prisma.user.findMany();
      expect(rows).toHaveLength(1);
      expect(['google.com', 'emailLink']).toContain(rows[0]!.authProvider);
      expect(['google.com', 'emailLink']).toContain(rows[0]!.lastAuthProvider);
    });

    it('10 simultaneous sign-ins of 10 different accounts create 10 rows', async () => {
      identityVerifier.willReturn((token) => identity({ uid: `uid-${token}` }));
      const responses = await Promise.all(
        Array.from({ length: 10 }, (_v, i) =>
          request(app.getHttpServer()).post('/v1/auth/sync').set('X-Firebase-AppCheck', SHAPED_APP_CHECK_TOKEN).set('Authorization', `Bearer t${i}.bbbb.cccc`),
        ),
      );
      expect(responses.map((r) => r.status)).toEqual(Array(10).fill(200));
      expect(await prisma.user.count()).toBe(10);
    });
  });

  describe('sync: what is refused (and nothing is written)', () => {
    it('an unsupported sign-in method: 403 UNSUPPORTED_SIGN_IN_PROVIDER, no row', async () => {
      identityVerifier.willReturn(identity({ signInProvider: 'facebook.com' }));
      const res = await sync().expect(403);
      expect(res.body.error).toMatchObject({ code: 'UNSUPPORTED_SIGN_IN_PROVIDER' });
      expect(await prisma.user.count()).toBe(0);
    });

    it('an unsupported method for an EXISTING account changes nothing', async () => {
      await sync().expect(200);
      const before = await rowFor(IDENTITY.uid);
      identityVerifier.willReturn(identity({ signInProvider: 'github.com', name: 'Other' }));
      await sync().expect(403);
      expect(await rowFor(IDENTITY.uid)).toEqual(before);
    });

    it.each([
      ['non-ASCII', 'priyä@example.com'],
      ['too long', `${'a'.repeat(250)}@example.com`],
      ['with a space', 'pri ya@example.com'],
    ])('an email that is %s: 400 INVALID_EMAIL, no row', async (_label, email) => {
      identityVerifier.willReturn(identity({ email }));
      const res = await sync().expect(400);
      expect(res.body.error).toMatchObject({ code: 'INVALID_EMAIL' });
      expect(await prisma.user.count()).toBe(0);
    });

    it('an unverified email: 403 EMAIL_NOT_VERIFIED, no row', async () => {
      identityVerifier.willReturn(identity({ emailVerified: false }));
      const res = await sync().expect(403);
      expect(res.body.error).toMatchObject({ code: 'EMAIL_NOT_VERIFIED' });
      expect(await prisma.user.count()).toBe(0);
    });

    it('no email in the token: 403 EMAIL_NOT_VERIFIED, no row', async () => {
      identityVerifier.willReturn(identity({ email: undefined }));
      await sync().expect(403);
      expect(await prisma.user.count()).toBe(0);
    });

    it('a rejected login token: 401, no row', async () => {
      identityVerifier.willReturn(new IdentityRejectedError('expired'));
      const res = await sync().expect(401);
      expect(res.body.error).toMatchObject({ code: 'UNAUTHENTICATED' });
      expect(await prisma.user.count()).toBe(0);
    });

    it('Google unreachable for the login token: 503 AUTH_UNAVAILABLE, no row', async () => {
      identityVerifier.willReturn(new IdentityUnavailableError('down'));
      await sync().expect(503);
      expect(await prisma.user.count()).toBe(0);
    });

    it('a missing App Check header: 403 APP_CHECK_FAILED, no row, and the login verifier is never asked', async () => {
      const res = await request(app.getHttpServer()).post('/v1/auth/sync').set('Authorization', `Bearer ${SHAPED_TOKEN}`).expect(403);
      expect(res.body.error).toMatchObject({ code: 'APP_CHECK_FAILED' });
      expect(identityVerifier.calls).toHaveLength(0);
      expect(await prisma.user.count()).toBe(0);
    });

    it('a rejected App Check token: 403, no row', async () => {
      appCheckVerifier.willReturn(new AppCheckRejectedError('forged'));
      await sync().expect(403);
      expect(await prisma.user.count()).toBe(0);
    });

    it('Google unreachable for App Check: 503 APP_CHECK_UNAVAILABLE, no row', async () => {
      appCheckVerifier.willReturn(new AppCheckUnavailableError('down'));
      const res = await sync().expect(503);
      expect(res.body.error).toMatchObject({ code: 'APP_CHECK_UNAVAILABLE' });
      expect(await prisma.user.count()).toBe(0);
    });

    it('App Check valid but no login header: 401', async () => {
      await request(app.getHttpServer()).post('/v1/auth/sync').set('X-Firebase-AppCheck', SHAPED_APP_CHECK_TOKEN).expect(401);
    });

    it('wrong HTTP methods are 404 (no GET /auth/sync, no POST /me)', async () => {
      await request(app.getHttpServer()).get('/v1/auth/sync').set('Authorization', `Bearer ${SHAPED_TOKEN}`).expect(404);
      await request(app.getHttpServer()).post('/v1/me').set('Authorization', `Bearer ${SHAPED_TOKEN}`).expect(404);
    });
  });

  describe('sync: the response never leaks internals', () => {
    it('contains only the contract fields: no firebase uid, no timestamps', async () => {
      const res = await sync().expect(200);
      expect(Object.keys(res.body).sort()).toEqual(['profileComplete', 'user']);
      expect(Object.keys(res.body.user).sort()).toEqual(['authProvider', 'dob', 'email', 'id', 'lastAuthProvider', 'name', 'phone']);
      const text = JSON.stringify(res.body);
      expect(text).not.toContain(IDENTITY.uid);
      expect(text).not.toMatch(/firebase|createdAt|updatedAt|lastLoginAt|last_login/i);
    });

    it('profileComplete needs both name and phone', async () => {
      identityVerifier.willReturn(identity({ name: undefined }));
      await sync().expect(200);
      expect((await sync().expect(200)).body.profileComplete).toBe(false);
      await prisma.user.update({ where: { firebaseUid: IDENTITY.uid }, data: { phone: '+919876543210' } });
      expect((await sync().expect(200)).body.profileComplete).toBe(false); // phone but no name
      await prisma.user.update({ where: { firebaseUid: IDENTITY.uid }, data: { name: 'Priya' } });
      expect((await sync().expect(200)).body.profileComplete).toBe(true);
      await prisma.user.update({ where: { firebaseUid: IDENTITY.uid }, data: { phone: null } });
      expect((await sync().expect(200)).body.profileComplete).toBe(false); // name but no phone
    });

    it('never writes the token or the email to the log', async () => {
      await sync().expect(200);
      identityVerifier.willReturn(identity({ signInProvider: 'facebook.com' }));
      await sync().expect(403);
      const logged = JSON.stringify([...warn.mock.calls, ...errorLog.mock.calls]);
      expect(logged).not.toContain(SHAPED_TOKEN);
      expect(logged).not.toContain('priya@example.com');
    });
  });

  describe('me', () => {
    it('returns the stored profile, with the contract shape and no-store', async () => {
      await sync().expect(200);
      await prisma.user.update({ where: { firebaseUid: IDENTITY.uid }, data: { phone: '+919876543210', dob: new Date('1990-04-12') } });
      const res = await me().expect(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toEqual({
        user: { id: expect.any(String), email: 'priya@example.com', name: 'Priya Sharma', phone: '+919876543210', dob: '1990-04-12', authProvider: 'google.com', lastAuthProvider: 'google.com' },
        profileComplete: true,
      });
    });

    it('does not change last_login_at, the provider, the email or the name of an existing row', async () => {
      await sync().expect(200);
      const before = await rowFor(IDENTITY.uid);
      await wait(15);
      identityVerifier.willReturn(identity({ email: 'changed@example.com', name: 'Changed', signInProvider: 'password' }));
      const res = await me().expect(200);
      expect(res.body.user).toMatchObject({ email: 'priya@example.com', name: 'Priya Sharma', authProvider: 'google.com', lastAuthProvider: 'google.com' });
      expect(await rowFor(IDENTITY.uid)).toEqual(before);
    });

    it('creates a missing row exactly as sync would, with last_login_at set once', async () => {
      const res = await me().expect(200);
      expect(res.body.user).toMatchObject({ email: 'priya@example.com', name: 'Priya Sharma', authProvider: 'google.com', lastAuthProvider: 'google.com' });
      expect(await prisma.user.count()).toBe(1);
      expect((await rowFor(IDENTITY.uid))?.lastLoginAt).toBeInstanceOf(Date);
      const again = await me().expect(200);
      expect(again.body.user.id).toBe(res.body.user.id);
      expect(await prisma.user.count()).toBe(1);
    });

    it('10 simultaneous calls for a missing row create one row', async () => {
      const responses = await Promise.all(Array.from({ length: 10 }, () => me()));
      expect(responses.map((r) => r.status)).toEqual(Array(10).fill(200));
      expect(await prisma.user.count()).toBe(1);
    });

    it('works without an App Check header and never asks the App Check verifier', async () => {
      await me().expect(200);
      expect(appCheckVerifier.calls).toHaveLength(0);
    });

    it('refuses an unsupported method when the row is missing (no row) but serves an existing row regardless', async () => {
      identityVerifier.willReturn(identity({ signInProvider: 'facebook.com' }));
      await me().expect(403);
      expect(await prisma.user.count()).toBe(0);
      identityVerifier.willReturn(IDENTITY);
      await sync().expect(200);
      identityVerifier.willReturn(identity({ signInProvider: 'facebook.com' }));
      await me().expect(200);
    });

    it('an unverified email: 403 and no row', async () => {
      identityVerifier.willReturn(identity({ emailVerified: false }));
      await me().expect(403);
      expect(await prisma.user.count()).toBe(0);
    });

    it('no login header: 401; rejected token: 401; Google unreachable: 503', async () => {
      await request(app.getHttpServer()).get('/v1/me').expect(401);
      identityVerifier.willReturn(new IdentityRejectedError('x'));
      await me().expect(401);
      identityVerifier.willReturn(new IdentityUnavailableError('x'));
      await me().expect(503);
      expect(await prisma.user.count()).toBe(0);
    });

    it("never returns another person's data", async () => {
      identityVerifier.willReturn(identity({ uid: 'uid-a', name: 'Account A', email: 'a@example.com' }));
      await sync().expect(200);
      identityVerifier.willReturn(identity({ uid: 'uid-b', name: 'Account B', email: 'b@example.com' }));
      const res = await me().expect(200);
      expect(JSON.stringify(res.body)).not.toContain('Account A');
      expect(JSON.stringify(res.body)).not.toContain('a@example.com');
    });
  });

  it('uses the verified uid as the key, whatever the token claims to be someone else in other fields', async () => {
    identityVerifier.willReturn(identity({ uid: 'uid-real', name: 'uid-victim' }));
    await sync().expect(200);
    expect((await rowFor('uid-real'))?.name).toBe('uid-victim');
    expect(await rowFor('uid-victim')).toBeNull();
  });

  it('survives a uid that looks like SQL', async () => {
    const uid = `x'); DROP TABLE users; --${randomUUID()}`;
    identityVerifier.willReturn(identity({ uid, name: `Robert'); DROP TABLE users;--` }));
    await sync().expect(200);
    expect((await rowFor(uid))?.name).toBe(`Robert'); DROP TABLE users;--`);
    expect(await prisma.user.count()).toBe(1);
  });
});
