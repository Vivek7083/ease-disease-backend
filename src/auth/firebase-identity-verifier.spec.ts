import https from 'node:https';
import { Logger } from '@nestjs/common';
import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFirebaseKit } from '../../test/helpers/identity-kit.js';
import { FirebaseIdentityVerifier, UnconfiguredIdentityVerifier } from './firebase-identity-verifier.js';
import { IdentityRejectedError, IdentityUnavailableError } from './identity-verifier.js';

const sdkError = (code: string, message = 'sdk message') => Object.assign(new Error(message), { code });

describe('FirebaseIdentityVerifier with the real Firebase Admin SDK and locally signed RS256 tokens', () => {
  const kit = createFirebaseKit();
  afterAll(() => kit.close());

  const nowSeconds = () => Math.floor(Date.now() / 1000);

  describe('accepts', () => {
    it('a genuine token and maps its claims', async () => {
      await expect(kit.verifier.verify(kit.mint())).resolves.toEqual({
        uid: 'uid-priya-1',
        email: 'priya@example.com',
        emailVerified: true,
        name: 'Priya Sharma',
        signInProvider: 'google.com',
      });
    });

    it('an email-link style token: no name, provider "password"', async () => {
      const identity = await kit.verifier.verify(kit.mint({ name: undefined, firebase: { sign_in_provider: 'password' } }));
      expect(identity.name).toBeUndefined();
      expect(identity.signInProvider).toBe('password');
    });

    it('an empty name is treated as absent', async () => {
      expect((await kit.verifier.verify(kit.mint({ name: '' }))).name).toBeUndefined();
    });

    it('a token without an email: email undefined, not verified', async () => {
      const identity = await kit.verifier.verify(kit.mint({ email: undefined, email_verified: undefined }));
      expect(identity).toMatchObject({ email: undefined, emailVerified: false });
    });

    it.each([
      ['the string "true"', 'true'],
      ['the number 1', 1],
      ['false', false],
    ])('does not treat email_verified = %s as verified (only the boolean true counts)', async (_label, value) => {
      expect((await kit.verifier.verify(kit.mint({ email_verified: value }))).emailVerified).toBe(false);
    });

    it('a token issued a few seconds in the future (clock skew within the allowance)', async () => {
      const now = nowSeconds();
      await expect(kit.verifier.verify(kit.mint({ iat: now + 30, auth_time: now + 30, exp: now + 3600 }))).resolves.toMatchObject({ uid: 'uid-priya-1' });
    });

    it('a uid of exactly 128 characters', async () => {
      const uid = 'u'.repeat(128);
      await expect(kit.verifier.verify(kit.mint({ sub: uid }))).resolves.toMatchObject({ uid });
    });
  });

  describe('rejects with IdentityRejectedError', () => {
    const now = nowSeconds();
    it.each([
      ['signed by a key Google never published', () => kit.mint({}, { signWith: 'evil' })],
      ['an unknown key id', () => kit.mint({}, { kid: 'not-a-real-kid' })],
      ['no key id at all', () => kit.mint({}, { kid: null })],
      ['alg none (unsigned)', () => kit.mint({}, { alg: 'none' })],
      ['HS256 signed with the public key as the secret (algorithm confusion)', () => kit.mint({}, { alg: 'HS256' })],
      ['an expired token', () => kit.mint({ iat: now - 7200, auth_time: now - 7200, exp: now - 100 })],
      ['another Firebase project (audience)', () => kit.mint({ aud: 'some-other-project' })],
      ['another Firebase project (issuer)', () => kit.mint({ iss: 'https://securetoken.google.com/some-other-project' })],
      ['the wrong issuer family', () => kit.mint({ iss: 'https://accounts.google.com' })],
      ['a missing subject', () => kit.mint({ sub: undefined })],
      ['an empty subject', () => kit.mint({ sub: '' })],
      ['a subject of 129 characters', () => kit.mint({ sub: 'u'.repeat(129) })],
      ['a token issued far in the future', () => kit.mint({ iat: now + 4000, auth_time: now - 5, exp: now + 7000 })],
      ['an authentication time far in the future', () => kit.mint({ auth_time: now + 4000 })],
      ['a tenant token', () => kit.mint({ firebase: { sign_in_provider: 'google.com', tenant: 'tenant-1' } })],
      ['no firebase claim (not a Firebase sign-in token)', () => kit.mint({ firebase: undefined })],
      ['no sign_in_provider', () => kit.mint({ firebase: { identities: {} } })],
      ['an empty sign_in_provider', () => kit.mint({ firebase: { sign_in_provider: '' } })],
      ['a garbage string', () => 'not-a-jwt'],
      ['an empty string', () => ''],
    ])('%s', async (_label, token) => {
      await expect(kit.verifier.verify(token())).rejects.toBeInstanceOf(IdentityRejectedError);
    });

    it('anything when Google publishes no keys at all', async () => {
      const empty = createFirebaseKit();
      empty.serveNoKeys();
      await expect(empty.verifier.verify(empty.mint())).rejects.toBeInstanceOf(IdentityRejectedError);
      await empty.close();
    });
  });

  describe('Google unreachable is IdentityUnavailableError, never a rejection of the token', () => {
    it.each([
      ['the HTTP client reports a network failure', 'Error while making request: getaddrinfo ENOTFOUND www.googleapis.com. Error code: ENOTFOUND'],
      ['the key endpoint answers with an error', 'Error fetching public keys for Google certs: 503 Service Unavailable'],
    ])('when %s', async (_label, message) => {
      const down = createFirebaseKit();
      down.failKeyDownload(new Error(message));
      await expect(down.verifier.verify(down.mint())).rejects.toBeInstanceOf(IdentityUnavailableError);
      await down.close();
    });

    it('for a REAL network failure produced inside the SDK (DNS cannot resolve), with no mock of the SDK error', async () => {
      const agent = new https.Agent({
        lookup: (host, _options, callback) => callback(Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' }) as never, '', 4),
      });
      const app = initializeApp({ projectId: kit.projectId, httpAgent: agent }, `real-net-failure-${Math.random().toString(36).slice(2)}`);
      const verifier = new FirebaseIdentityVerifier({ projectId: kit.projectId, auth: getAuth(app) });
      await expect(verifier.verify(kit.mint())).rejects.toBeInstanceOf(IdentityUnavailableError);
      await deleteApp(app);
    });
  });

  describe('a key download failure whose message is not one of the known SDK sentences', () => {
    it('is denied as a rejection (fail closed); the SDK message is kept on the error so the guard logs it', async () => {
      const odd = createFirebaseKit();
      odd.failKeyDownload(new Error('something nobody has seen before'));
      const error = await odd.verifier.verify(odd.mint()).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(IdentityRejectedError);
      expect((error as Error).message).toContain('something nobody has seen before');
      await odd.close();
    });
  });
});

describe('FirebaseIdentityVerifier error classification (scripted SDK errors)', () => {
  const verifierThrowing = (error: unknown) => new FirebaseIdentityVerifier({ projectId: 'demo-classify', auth: { verifyIdToken: () => Promise.reject(error) } });
  let errorLog: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errorLog = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => errorLog.mockRestore());

  it.each(['auth/argument-error', 'auth/id-token-expired', 'auth/id-token-revoked', 'auth/invalid-id-token', 'auth/user-disabled', 'auth/user-not-found'])(
    '%s is a rejection and is not logged as an error',
    async (code) => {
      await expect(verifierThrowing(sdkError(code)).verify('t')).rejects.toBeInstanceOf(IdentityRejectedError);
      expect(errorLog).not.toHaveBeenCalled();
    },
  );

  it.each(['app/network-error', 'app/network-timeout', 'app/invalid-credential', 'app/unable-to-parse-response', 'auth/internal-error'])(
    '%s means unavailable',
    async (code) => {
      await expect(verifierThrowing(sdkError(code)).verify('t')).rejects.toBeInstanceOf(IdentityUnavailableError);
    },
  );

  it.each([
    ['Error while making request: connect ECONNREFUSED 127.0.0.1:1. Error code: ECONNREFUSED'],
    ['Error fetching public keys for Google certs: 500 Internal Server Error'],
  ])('auth/argument-error with the message "%s" means unavailable (the SDK reuses that code for outages)', async (message) => {
    await expect(verifierThrowing(sdkError('auth/argument-error', message)).verify('t')).rejects.toBeInstanceOf(IdentityUnavailableError);
  });

  it('those sentences only count at the START of the message (a token cannot smuggle them in mid-sentence)', async () => {
    const message = 'Firebase ID token has incorrect "aud" claim. Expected "p" but got "Error while making request: x".';
    await expect(verifierThrowing(sdkError('auth/argument-error', message)).verify('t')).rejects.toBeInstanceOf(IdentityRejectedError);
  });

  it.each([
    ['an unknown code', sdkError('auth/something-new')],
    ['an error without a code', new Error('boom')],
    ['a thrown string', 'boom'],
    ['null', null],
  ])('%s is denied as a rejection and logged at error level', async (_label, error) => {
    await expect(verifierThrowing(error).verify('t')).rejects.toBeInstanceOf(IdentityRejectedError);
    expect(errorLog).toHaveBeenCalledTimes(1);
  });

  it('passes checkRevoked through to the SDK (true only when asked)', async () => {
    const verifyIdToken = vi.fn().mockRejectedValue(sdkError('auth/argument-error'));
    const verifier = new FirebaseIdentityVerifier({ projectId: 'demo-classify', auth: { verifyIdToken } });
    await verifier.verify('t').catch(() => undefined);
    await verifier.verify('t', {}).catch(() => undefined);
    await verifier.verify('t', { checkRevoked: false }).catch(() => undefined);
    await verifier.verify('t', { checkRevoked: true }).catch(() => undefined);
    expect(verifyIdToken.mock.calls.map((call) => call[1])).toEqual([false, false, false, true]);
  });
});

describe('FirebaseIdentityVerifier backstop checks, tested without the SDK in front of them', () => {
  // The SDK already refuses these; the checks are kept as a second line of defence, so they are proven on their own.
  const decoded = (overrides: Record<string, unknown>) => {
    const now = Math.floor(Date.now() / 1000);
    return { uid: 'uid-1', sub: 'uid-1', iat: now - 5, auth_time: now - 5, exp: now + 3000, email: 'a@example.com', email_verified: true, firebase: { sign_in_provider: 'google.com' }, ...overrides };
  };
  const verifierReturning = (token: Record<string, unknown>) =>
    new FirebaseIdentityVerifier({ projectId: 'demo-backstop', auth: { verifyIdToken: () => Promise.resolve(token as never) } });

  it('accepts a well-formed decoded token', async () => {
    await expect(verifierReturning(decoded({})).verify('t')).resolves.toMatchObject({ uid: 'uid-1', emailVerified: true });
  });

  it.each([
    ['a uid of 129 characters', { uid: 'u'.repeat(129) }],
    ['an empty uid', { uid: '' }],
    ['a numeric uid', { uid: 12345 }],
    ['a missing uid', { uid: undefined }],
  ])('refuses %s', async (_label, overrides) => {
    await expect(verifierReturning(decoded(overrides)).verify('t')).rejects.toBeInstanceOf(IdentityRejectedError);
  });

  it('accepts a uid of exactly 128 characters', async () => {
    await expect(verifierReturning(decoded({ uid: 'u'.repeat(128) })).verify('t')).resolves.toMatchObject({ uid: 'u'.repeat(128) });
  });
});

describe('FirebaseIdentityVerifier built the production way (project id only)', () => {
  it('starts, refuses a garbage token without any network call or credentials, and shuts down', async () => {
    const verifier = new FirebaseIdentityVerifier({ projectId: 'demo-production-way' });
    await expect(verifier.verify('not-a-jwt')).rejects.toBeInstanceOf(IdentityRejectedError);
    await expect(verifier.onModuleDestroy()).resolves.toBeUndefined();
  });
});

describe('UnconfiguredIdentityVerifier', () => {
  it('refuses everything', async () => {
    await expect(new UnconfiguredIdentityVerifier().verify()).rejects.toBeInstanceOf(IdentityRejectedError);
  });
});
