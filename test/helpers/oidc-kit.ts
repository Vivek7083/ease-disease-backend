import { createHmac, createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import { GoogleOidcVerifier } from '../../src/internal/oidc-verifier.js';

export const AUDIENCE = 'https://api.easedisease.in';
export const SCHEDULER_ACCOUNT = 'scheduler@easedisease-prod.iam.gserviceaccount.com';
export const KID = 'test-key-1';

export interface MintOptions {
  /** Which key signs the token. `evil` is a key Google never published. */
  signWith?: 'good' | 'evil';
  alg?: 'RS256' | 'none' | 'HS256';
  kid?: string | null;
  /** Replace the payload AFTER signing (tampering). */
  tamperPayload?: Record<string, unknown>;
}

/**
 * Real Google-style ID tokens signed with a locally generated RSA key. The production verifier runs unchanged
 * (signature, issuer, audience and time checks); only the download of Google's public keys is replaced by our own key.
 */
export function createOidcKit() {
  const good = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const evil = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicPem = good.publicKey.export({ type: 'spki', format: 'pem' }).toString();

  class LocalCertsClient extends OAuth2Client {
    override async getFederatedSignonCertsAsync() {
      return { certs: { [KID]: publicPem }, format: 'PEM' as never };
    }
  }
  const verifier = new GoogleOidcVerifier(new LocalCertsClient());

  const b64 = (value: unknown) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
  const sign = (data: string, key: KeyObject) => createSign('RSA-SHA256').update(data).sign(key).toString('base64url');

  /** Claims of a genuine Cloud Scheduler token unless overridden; an override of `undefined` removes the claim. */
  function mint(overrides: Record<string, unknown> = {}, options: MintOptions = {}): string {
    const now = Math.floor(Date.now() / 1000);
    const claims: Record<string, unknown> = {
      iss: 'https://accounts.google.com',
      aud: AUDIENCE,
      sub: '112233445566778899001',
      azp: '112233445566778899001',
      email: SCHEDULER_ACCOUNT,
      email_verified: true,
      iat: now - 10,
      exp: now + 3000,
      ...overrides,
    };
    for (const [name, value] of Object.entries(claims)) if (value === undefined) delete claims[name];

    const alg = options.alg ?? 'RS256';
    const header: Record<string, unknown> = { alg, typ: 'JWT' };
    if (options.kid !== null) header['kid'] = options.kid ?? KID;
    const signingInput = `${b64(header)}.${b64(claims)}`;

    let signature = '';
    if (alg === 'RS256') signature = sign(signingInput, (options.signWith === 'evil' ? evil : good).privateKey);
    // Algorithm-confusion attempt: an HMAC "signed" with the PUBLIC key as the secret.
    if (alg === 'HS256') signature = createHmac('sha256', publicPem).update(signingInput).digest('base64url');

    const payload = options.tamperPayload ? b64({ ...claims, ...options.tamperPayload }) : b64(claims);
    return `${b64(header)}.${payload}.${signature}`;
  }

  return { verifier, mint, publicPem };
}
