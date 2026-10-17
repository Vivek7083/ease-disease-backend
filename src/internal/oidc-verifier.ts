import { OAuth2Client } from 'google-auth-library';

/** Injection token so tests (and, one day, other identity providers) can replace the verifier. */
export const OIDC_VERIFIER = Symbol('OIDC_VERIFIER');

export interface VerifiedOidcClaims {
  email: string | undefined;
  emailVerified: boolean;
}

export interface OidcVerifier {
  /** Resolves only for a genuine, unexpired, Google-signed ID token issued for `audience`. Rejects for anything else. */
  verify(token: string, audience: string): Promise<VerifiedOidcClaims>;
}

/**
 * Verifies Google-signed OIDC ID tokens (what Cloud Scheduler sends) with Google's own library: signature against
 * Google's published keys, issuer, audience, issue/expiry times. Who the token was issued to (service account) is
 * checked by the caller from the returned claims.
 */
export class GoogleOidcVerifier implements OidcVerifier {
  constructor(private readonly client: Pick<OAuth2Client, 'verifyIdToken'> = new OAuth2Client()) {}

  async verify(token: string, audience: string): Promise<VerifiedOidcClaims> {
    const ticket = await this.client.verifyIdToken({ idToken: token, audience });
    const payload = ticket.getPayload();
    if (!payload) throw new Error('token has no payload');
    return { email: typeof payload.email === 'string' ? payload.email : undefined, emailVerified: payload.email_verified === true };
  }
}
