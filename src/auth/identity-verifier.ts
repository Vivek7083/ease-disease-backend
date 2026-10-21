/** Injection token so tests (and, one day, another identity provider) can replace the verifier. */
export const IDENTITY_VERIFIER = Symbol('IDENTITY_VERIFIER');

/** What the rest of the app may know about a signed-in caller. The Firebase uid is the only identity we store. */
export interface VerifiedIdentity {
  uid: string;
  /** As in the token. Not lower-cased here: whoever stores it does that once. */
  email: string | undefined;
  /** True only when the token says exactly `true`. */
  emailVerified: boolean;
  /** Present for Google sign-in, absent for email-link sign-in. */
  name: string | undefined;
  /** Raw Firebase value (`google.com`, `password`, ...). Mapping it to a stored label is not this layer's job. */
  signInProvider: string;
}

export interface VerifyOptions {
  /**
   * Also ask Google whether the user was disabled or the session revoked after the token was issued. Costs a network
   * round trip and needs Google credentials, so it is used only where it matters (checkout).
   */
  checkRevoked?: boolean;
}

export interface IdentityVerifier {
  /** Resolves only for a genuine, unexpired token issued for this project. Rejects with one of the two errors below. */
  verify(token: string, options?: VerifyOptions): Promise<VerifiedIdentity>;
}

/** The token is not acceptable: forged, expired, revoked, for another project, malformed, or the user is gone. */
export class IdentityRejectedError extends Error {
  override readonly name = 'IdentityRejectedError';
}

/** We could not decide: Google unreachable, no credentials for the revocation lookup. Says nothing about the token. */
export class IdentityUnavailableError extends Error {
  override readonly name = 'IdentityUnavailableError';
}
