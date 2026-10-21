import https from 'node:https';
import { Logger } from '@nestjs/common';
import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getAppCheck } from 'firebase-admin/app-check';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_ID, createAppCheckKit } from '../../test/helpers/app-check-kit.js';
import { AppCheckRejectedError, AppCheckUnavailableError } from './app-check-verifier.js';
import { FirebaseAppCheckVerifier, UnconfiguredAppCheckVerifier } from './firebase-app-check-verifier.js';

const sdkError = (code: string, message = 'sdk message') => Object.assign(new Error(message), { code });

describe('FirebaseAppCheckVerifier with the real Firebase Admin SDK and locally signed RS256 tokens', () => {
  const kit = createAppCheckKit();
  afterAll(() => kit.close());
  const nowSeconds = () => Math.floor(Date.now() / 1000);

  describe('accepts', () => {
    it('a genuine token and returns the app id', async () => {
      await expect(kit.verifier.verify(kit.mint())).resolves.toEqual({ appId: APP_ID });
    });

    // Measured SDK behaviour: with no key id it tries every published key. The signature is still checked against
    // Google's keys, so this is not a bypass; locked here so a change in either direction is noticed.
    it('a token with no key id but a valid signature from a published key (the SDK tries every key)', async () => {
      await expect(kit.verifier.verify(kit.mint({}, { kid: null }))).resolves.toEqual({ appId: APP_ID });
    });
  });

  describe('rejects (AppCheckRejectedError)', () => {
    it.each([
      ['a token signed by a key Google does not publish', () => kit.mint({}, { signWith: 'evil' })],
      ['an unknown key id', () => kit.mint({}, { kid: 'not-a-real-kid' })],
      ['no key id and a signature from a key Google does not publish', () => kit.mint({}, { kid: null, signWith: 'evil' })],
      ['the wrong algorithm', () => kit.mint({}, { alg: 'HS256' })],
      ['alg none', () => kit.mint({}, { alg: 'none' })],
      ['an expired token', () => kit.mint({ iat: nowSeconds() - 7200, exp: nowSeconds() - 3600 })],
      ['a token for another project (audience)', () => kit.mint({ aud: ['projects/1', 'projects/someone-elses-project'] })],
      ['a missing audience', () => kit.mint({ aud: undefined })],
      ['an audience that is a string, not a list', () => kit.mint({ aud: `projects/${kit.projectId}` })],
      ['the wrong issuer', () => kit.mint({ iss: 'https://securetoken.google.com/demo-app-check-kit' })],
      ['an empty subject', () => kit.mint({ sub: '' })],
      ['a missing subject', () => kit.mint({ sub: undefined })],
      ['a login (ID) token style payload', () => kit.mint({ iss: 'https://securetoken.google.com/demo-app-check-kit', aud: kit.projectId })],
      ['a garbage string', () => 'not-a-jwt'],
      ['an empty string', () => ''],
    ])('%s', async (_label, token) => {
      await expect(kit.verifier.verify(token())).rejects.toBeInstanceOf(AppCheckRejectedError);
    });
  });

  describe('Google unreachable is AppCheckUnavailableError, never a rejection of the token', () => {
    it('when the key download fails with the SDK sentence', async () => {
      const down = createAppCheckKit();
      down.failKeyDownload(new Error('Error fetching Json Web Keys: connect ECONNREFUSED 127.0.0.1:1'));
      await expect(down.verifier.verify(down.mint())).rejects.toBeInstanceOf(AppCheckUnavailableError);
      await down.close();
    });

    it('for a REAL network failure produced inside the SDK (DNS cannot resolve), with no mock of the SDK error', async () => {
      const agent = new https.Agent({
        lookup: (host, _options, callback) => callback(Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' }) as never, '', 4),
      });
      const app = initializeApp({ projectId: kit.projectId, httpAgent: agent }, `real-app-check-failure-${Math.random().toString(36).slice(2)}`);
      const verifier = new FirebaseAppCheckVerifier({ projectId: kit.projectId, appCheck: getAppCheck(app) });
      await expect(verifier.verify(kit.mint())).rejects.toBeInstanceOf(AppCheckUnavailableError);
      await deleteApp(app);
    });
  });

  it('shuts the SDK app down and tolerates a second shutdown', async () => {
    const own = new FirebaseAppCheckVerifier({ projectId: 'demo-own-app' });
    await expect(own.onModuleDestroy()).resolves.toBeUndefined();
    await expect(own.onModuleDestroy()).resolves.toBeUndefined();
  });

  it('builds its own SDK app from the project id alone and rejects a garbage token without any credentials', async () => {
    const own = new FirebaseAppCheckVerifier({ projectId: 'demo-own-app' });
    await expect(own.verify('not-a-jwt')).rejects.toBeInstanceOf(AppCheckRejectedError);
    await own.onModuleDestroy();
  });
});

describe('FirebaseAppCheckVerifier error classification (scripted SDK errors)', () => {
  const verifierThrowing = (error: unknown) => new FirebaseAppCheckVerifier({ projectId: 'demo-classify', appCheck: { verifyToken: () => Promise.reject(error) } });
  let errorLog: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errorLog = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => errorLog.mockRestore());

  it.each(['app-check/invalid-argument', 'app-check/app-check-token-expired'])('%s is a rejection and is not logged as an error', async (code) => {
    await expect(verifierThrowing(sdkError(code)).verify('t')).rejects.toBeInstanceOf(AppCheckRejectedError);
    expect(errorLog).not.toHaveBeenCalled();
  });

  it.each(['app-check/invalid-credential', 'app-check/internal-error', 'app-check/aborted'])('%s means unavailable', async (code) => {
    await expect(verifierThrowing(sdkError(code)).verify('t')).rejects.toBeInstanceOf(AppCheckUnavailableError);
  });

  it('invalid-argument with the key-download sentence means unavailable (the SDK reuses that code for outages)', async () => {
    const error = sdkError('app-check/invalid-argument', 'Error fetching Json Web Keys: socket hang up');
    await expect(verifierThrowing(error).verify('t')).rejects.toBeInstanceOf(AppCheckUnavailableError);
  });

  it('that sentence only counts at the START of the message (a token cannot smuggle it in mid-sentence)', async () => {
    const error = sdkError('app-check/invalid-argument', 'incorrect "aud" claim, got "Error fetching Json Web Keys: x".');
    await expect(verifierThrowing(error).verify('t')).rejects.toBeInstanceOf(AppCheckRejectedError);
  });

  it.each([
    ['an unknown SDK code', sdkError('app-check/something-new')],
    ['an error with no code', new Error('boom')],
    ['a thrown string', 'boom'],
    ['null', null],
  ])('%s is denied as a rejection and logged loudly', async (_label, error) => {
    await expect(verifierThrowing(error).verify('t')).rejects.toBeInstanceOf(AppCheckRejectedError);
    expect(errorLog).toHaveBeenCalledTimes(1);
  });

  it('a result without an app id is denied', async () => {
    const verifier = new FirebaseAppCheckVerifier({ projectId: 'p', appCheck: { verifyToken: async () => ({ appId: '', token: {} as never }) } });
    await expect(verifier.verify('t')).rejects.toBeInstanceOf(AppCheckRejectedError);
  });
});

describe('UnconfiguredAppCheckVerifier', () => {
  it('refuses every token', async () => {
    await expect(new UnconfiguredAppCheckVerifier().verify()).rejects.toBeInstanceOf(AppCheckRejectedError);
  });
});
