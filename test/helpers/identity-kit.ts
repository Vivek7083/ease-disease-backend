import { createHmac, createSign, generateKeyPairSync, randomUUID, type KeyObject } from 'node:crypto';
import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { FirebaseIdentityVerifier } from '../../src/auth/firebase-identity-verifier.js';
import type { IdentityVerifier, VerifiedIdentity, VerifyOptions } from '../../src/auth/identity-verifier.js';

export const PROJECT_ID = 'demo-identity-kit';
export const KID = 'kit-key-1';

/** A well-formed identity, as the guard would receive it from a verifier. */
export const IDENTITY: VerifiedIdentity = {
  uid: 'uid-priya-1',
  email: 'priya@example.com',
  emailVerified: true,
  name: 'Priya Sharma',
  signInProvider: 'google.com',
};

/** Syntactically a Bearer JWT (three base64url parts), which is all the guard checks before asking the verifier. */
export const SHAPED_TOKEN = 'aaaa.bbbb.cccc';

export type Outcome = VerifiedIdentity | Error | ((token: string, options: VerifyOptions | undefined) => VerifiedIdentity | Error);

/** A scripted verifier that records every call: for tests of the guard, where the verifier itself is not under test. */
export class FakeIdentityVerifier implements IdentityVerifier {
  readonly calls: Array<{ token: string; options: VerifyOptions | undefined }> = [];
  private outcome: Outcome = IDENTITY;

  willReturn(outcome: Outcome): this {
    this.outcome = outcome;
    return this;
  }

  async verify(token: string, options?: VerifyOptions): Promise<VerifiedIdentity> {
    this.calls.push({ token, options });
    const result = typeof this.outcome === 'function' ? this.outcome(token, options) : this.outcome;
    if (result instanceof Error) throw result;
    return result;
  }
}

export interface MintOptions {
  /** Which key signs the token. `evil` is a key that is not in Google's published set. */
  signWith?: 'good' | 'evil';
  alg?: 'RS256' | 'HS256' | 'none';
  /** `null` leaves the key id out of the header. */
  kid?: string | null;
}

/**
 * The REAL Firebase Admin SDK verifying REAL RS256 signatures, with only the download of Google's public keys replaced
 * by a locally generated key (the same idea as `oidc-kit` for the tick guard). Every other SDK check (algorithm, key
 * id, issuer, audience, subject, expiry) runs unchanged. The seam is the SDK's own `signatureVerifier` property, so a
 * future SDK that moves it makes these tests fail loudly instead of silently testing nothing.
 */
export function createFirebaseKit(options: { projectId?: string; now?: () => number } = {}) {
  const projectId = options.projectId ?? PROJECT_ID;
  const good = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const evil = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicPem = good.publicKey.export({ type: 'spki', format: 'pem' }).toString();

  let keyDownload: () => Promise<Record<string, string>> = async () => ({ [KID]: publicPem });

  const app = initializeApp({ projectId }, `identity-kit-${randomUUID()}`);
  const auth = getAuth(app);
  const internals = auth as unknown as { idTokenVerifier: { signatureVerifier: { constructor: new (fetcher: { fetchPublicKeys(): Promise<Record<string, string>> }) => object } } };
  const PublicKeySignatureVerifier = internals.idTokenVerifier.signatureVerifier.constructor;
  (internals.idTokenVerifier as { signatureVerifier: object }).signatureVerifier = new PublicKeySignatureVerifier({ fetchPublicKeys: () => keyDownload() });

  const verifier = new FirebaseIdentityVerifier({ projectId, auth, now: options.now });

  const base64url = (value: unknown) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
  const sign = (data: string, key: KeyObject) => createSign('RSA-SHA256').update(data).sign(key).toString('base64url');

  /** A genuine-looking Firebase ID token unless overridden; an override of `undefined` removes the claim. */
  function mint(overrides: Record<string, unknown> = {}, mintOptions: MintOptions = {}): string {
    const now = Math.floor((options.now?.() ?? Date.now()) / 1000);
    const claims: Record<string, unknown> = {
      iss: `https://securetoken.google.com/${projectId}`,
      aud: projectId,
      sub: 'uid-priya-1',
      iat: now - 5,
      exp: now + 3000,
      auth_time: now - 5,
      name: 'Priya Sharma',
      email: 'priya@example.com',
      email_verified: true,
      firebase: { sign_in_provider: 'google.com', identities: { email: ['priya@example.com'] } },
      ...overrides,
    };
    for (const [name, value] of Object.entries(claims)) if (value === undefined) delete claims[name];

    const alg = mintOptions.alg ?? 'RS256';
    const header: Record<string, unknown> = { alg, typ: 'JWT' };
    if (mintOptions.kid !== null) header['kid'] = mintOptions.kid ?? KID;
    const signingInput = `${base64url(header)}.${base64url(claims)}`;
    let signature = '';
    if (alg === 'RS256') signature = sign(signingInput, (mintOptions.signWith === 'evil' ? evil : good).privateKey);
    // Algorithm-confusion attempt: an HMAC "signed" with the PUBLIC key as the secret.
    if (alg === 'HS256') signature = createHmac('sha256', publicPem).update(signingInput).digest('base64url');
    return `${signingInput}.${signature}`;
  }

  return {
    verifier,
    auth,
    mint,
    projectId,
    /** Make the "download of Google's public keys" fail, as an outage would. */
    failKeyDownload(error: Error) {
      keyDownload = () => Promise.reject(error);
    },
    /** Serve an empty key set. */
    serveNoKeys() {
      keyDownload = async () => ({});
    },
    close: () => deleteApp(app),
  };
}
