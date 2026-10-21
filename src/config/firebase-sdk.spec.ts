import { readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { deleteApp, initializeApp, type App } from 'firebase-admin/app';
import { getAppCheck } from 'firebase-admin/app-check';
import { getAuth } from 'firebase-admin/auth';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * S2a: the Firebase Admin SDK is a security-critical dependency. These tests pin how it is installed and prove, with
 * no credentials file and no network, the behaviour the later sign-in chunks rely on.
 */
const PROJECT_ID = 'demo-sdk-spec';
const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  dependencies: Record<string, string>;
  allowScripts: Record<string, boolean>;
};

const base64url = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
/** A token anyone can write by hand: no secret, no signature, claims of their choosing. */
const handWrittenToken = (uid: string) => {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: `https://securetoken.google.com/${PROJECT_ID}`,
    aud: PROJECT_ID,
    auth_time: now,
    user_id: uid,
    sub: uid,
    iat: now,
    exp: now + 3600,
    email: 'someone@example.com',
    email_verified: true,
    firebase: { identities: { email: ['someone@example.com'] }, sign_in_provider: 'google.com' },
  };
  return `${base64url({ alg: 'none', typ: 'JWT' })}.${base64url(claims)}.`;
};

describe('firebase-admin dependency', () => {
  describe('how it is installed', () => {
    it.each(['firebase-admin', 'google-auth-library'])('%s is pinned to an exact version (no ^ or ~)', (name) => {
      expect(packageJson.dependencies[name]).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it('explicitly denies the install scripts of its two script-bearing dependencies', () => {
      expect(packageJson.allowScripts['@firebase/util@1.15.3']).toBe(false);
      expect(packageJson.allowScripts['protobufjs@7.6.6']).toBe(false);
    });
  });

  describe('behaviour that needs no credentials and no network', () => {
    let app: App;
    let savedEmulatorHost: string | undefined;

    beforeEach(() => {
      // A developer's shell may have the emulator variable set; these tests are about the real (non-emulator) mode.
      savedEmulatorHost = process.env['FIREBASE_AUTH_EMULATOR_HOST'];
      delete process.env['FIREBASE_AUTH_EMULATOR_HOST'];
      app = initializeApp({ projectId: PROJECT_ID }, `sdk-spec-${Math.random().toString(36).slice(2)}`);
    });
    afterEach(async () => {
      await deleteApp(app);
      if (savedEmulatorHost === undefined) delete process.env['FIREBASE_AUTH_EMULATOR_HOST'];
      else process.env['FIREBASE_AUTH_EMULATOR_HOST'] = savedEmulatorHost;
    });

    it('starts from a project id alone (no service-account key is needed to verify tokens)', () => {
      expect(app.options.projectId).toBe(PROJECT_ID);
      // Without an explicit credential the SDK installs a default (Application Default Credentials) object, but only
      // resolves it lazily, for calls that need real Google access (for example the revoked-token lookup, an S2b
      // question). Verifying a token does not, which the tests below prove by succeeding without any credentials.
      expect(app.options.credential).toBeDefined();
    });

    it.each([
      ['a garbage string', 'not-a-jwt'],
      ['an empty string', ''],
      ['an unsigned alg:none token with correct-looking claims', handWrittenToken('victim-uid')],
    ])('rejects %s as an ID token', async (_label, token) => {
      await expect(getAuth(app).verifyIdToken(token)).rejects.toMatchObject({ code: 'auth/argument-error' });
    });

    it.each([
      ['a garbage string', 'not-a-jwt'],
      ['an empty string', ''],
    ])('rejects %s as an App Check token', async (_label, token) => {
      await expect(getAppCheck(app).verifyToken(token)).rejects.toMatchObject({ code: expect.stringMatching(/^app-check\//) });
    });
  });

  /**
   * Why the boot check on FIREBASE_AUTH_EMULATOR_HOST exists. In emulator mode the SDK skips the signature check and
   * only asks the server at that address whether the user exists. Locked here so that a change in the SDK's behaviour,
   * in either direction, shows up as a failing test instead of a silent change of risk.
   */
  describe('emulator mode (why the deployed-environment guard exists)', () => {
    const originalHost = process.env['FIREBASE_AUTH_EMULATOR_HOST'];
    let server: http.Server | undefined;
    let app: App | undefined;

    afterEach(async () => {
      if (app) await deleteApp(app);
      app = undefined;
      await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
      server = undefined;
      if (originalHost === undefined) delete process.env['FIREBASE_AUTH_EMULATOR_HOST'];
      else process.env['FIREBASE_AUTH_EMULATOR_HOST'] = originalHost;
    });

    const listen = async (userExists: boolean) => {
      server = http.createServer((request, response) => {
        request.resume();
        request.on('end', () => {
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify(userExists ? { users: [{ localId: 'victim-uid', email: 'someone@example.com', emailVerified: true, validSince: '0' }] } : {}));
        });
      });
      await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
      return (server.address() as AddressInfo).port;
    };

    it('accepts a hand-written unsigned token when the address answers "that user exists"', async () => {
      process.env['FIREBASE_AUTH_EMULATOR_HOST'] = `127.0.0.1:${await listen(true)}`;
      app = initializeApp({ projectId: PROJECT_ID }, `sdk-emulator-${Math.random().toString(36).slice(2)}`);
      const decoded = await getAuth(app).verifyIdToken(handWrittenToken('victim-uid'));
      expect(decoded.uid).toBe('victim-uid');
    });

    it('still rejects it when the address does not know the user', async () => {
      process.env['FIREBASE_AUTH_EMULATOR_HOST'] = `127.0.0.1:${await listen(false)}`;
      app = initializeApp({ projectId: PROJECT_ID }, `sdk-emulator-${Math.random().toString(36).slice(2)}`);
      await expect(getAuth(app).verifyIdToken(handWrittenToken('victim-uid'))).rejects.toBeDefined();
    });

    it('fails every login (closed, not open) when nothing is listening at the address', async () => {
      const port = await listen(true);
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
      process.env['FIREBASE_AUTH_EMULATOR_HOST'] = `127.0.0.1:${port}`;
      app = initializeApp({ projectId: PROJECT_ID }, `sdk-emulator-${Math.random().toString(36).slice(2)}`);
      await expect(getAuth(app).verifyIdToken(handWrittenToken('victim-uid'))).rejects.toBeDefined();
    });
  });
});
