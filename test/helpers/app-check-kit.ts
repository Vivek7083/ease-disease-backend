import { createSign, generateKeyPairSync, randomUUID } from 'node:crypto';
import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getAppCheck } from 'firebase-admin/app-check';
import { AppCheckRejectedError, type AppCheckVerifier, type VerifiedAppCheck } from '../../src/auth/app-check-verifier.js';
import { FirebaseAppCheckVerifier } from '../../src/auth/firebase-app-check-verifier.js';

export const APP_CHECK_PROJECT_ID = 'demo-app-check-kit';
export const APP_CHECK_KID = 'app-check-kit-key-1';
export const APP_ID = '1:123456789012:web:abcdef0123456789';
/** Syntactically an App Check JWT (three base64url parts), which is all the guard checks before asking the verifier. */
export const SHAPED_APP_CHECK_TOKEN = 'aaaa.bbbb.cccc';

export type AppCheckOutcome = VerifiedAppCheck | Error | ((token: string) => VerifiedAppCheck | Error);

/** A scripted verifier that records every call: for tests of the guard, where the verifier itself is not under test. */
export class FakeAppCheckVerifier implements AppCheckVerifier {
  readonly calls: string[] = [];
  private outcome: AppCheckOutcome = { appId: APP_ID };

  willReturn(outcome: AppCheckOutcome): this {
    this.outcome = outcome;
    return this;
  }

  async verify(token: string): Promise<VerifiedAppCheck> {
    this.calls.push(token);
    const result = typeof this.outcome === 'function' ? this.outcome(token) : this.outcome;
    if (result instanceof Error) throw result;
    return result;
  }
}

export { AppCheckRejectedError };

/**
 * The REAL Firebase Admin SDK verifying REAL RS256 App Check signatures, with only the download of Google's public keys
 * replaced by a locally generated key (same idea as the identity kit). The seam is the SDK's own `signatureVerifier`
 * property, so a future SDK that moves it makes these tests fail loudly instead of silently testing nothing.
 */
export function createAppCheckKit(options: { projectId?: string } = {}) {
  const projectId = options.projectId ?? APP_CHECK_PROJECT_ID;
  const good = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const evil = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicPem = good.publicKey.export({ type: 'spki', format: 'pem' }).toString();

  let keyDownload: () => Promise<Record<string, string>> = async () => ({ [APP_CHECK_KID]: publicPem });

  const app = initializeApp({ projectId }, `app-check-kit-${randomUUID()}`);
  const appCheck = getAppCheck(app);
  const internals = appCheck as unknown as {
    appCheckTokenVerifier: { signatureVerifier: { constructor: new (fetcher: { fetchPublicKeys(): Promise<Record<string, string>> }) => object } };
  };
  const PublicKeySignatureVerifier = internals.appCheckTokenVerifier.signatureVerifier.constructor;
  (internals.appCheckTokenVerifier as { signatureVerifier: object }).signatureVerifier = new PublicKeySignatureVerifier({ fetchPublicKeys: () => keyDownload() });

  const verifier = new FirebaseAppCheckVerifier({ projectId, appCheck });

  const base64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

  /** A genuine-looking App Check token unless overridden; an override of `undefined` removes the claim. */
  function mint(overrides: Record<string, unknown> = {}, mintOptions: { signWith?: 'good' | 'evil'; alg?: string; kid?: string | null } = {}): string {
    const now = Math.floor(Date.now() / 1000);
    const claims: Record<string, unknown> = {
      iss: 'https://firebaseappcheck.googleapis.com/123456789012',
      aud: ['projects/123456789012', `projects/${projectId}`],
      sub: APP_ID,
      iat: now - 5,
      exp: now + 3000,
      ...overrides,
    };
    for (const [name, value] of Object.entries(claims)) if (value === undefined) delete claims[name];
    const header: Record<string, unknown> = { alg: mintOptions.alg ?? 'RS256', typ: 'JWT' };
    if (mintOptions.kid !== null) header['kid'] = mintOptions.kid ?? APP_CHECK_KID;
    const signingInput = `${base64url(header)}.${base64url(claims)}`;
    const key = (mintOptions.signWith === 'evil' ? evil : good).privateKey;
    return `${signingInput}.${createSign('RSA-SHA256').update(signingInput).sign(key).toString('base64url')}`;
  }

  return {
    verifier,
    appCheck,
    mint,
    projectId,
    /** Make the "download of Google's public keys" fail, as an outage would. */
    failKeyDownload(error: Error) {
      keyDownload = () => Promise.reject(error);
    },
    close: () => deleteApp(app),
  };
}
