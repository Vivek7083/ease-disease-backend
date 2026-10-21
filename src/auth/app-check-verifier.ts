/** Injection token so tests (and, one day, another provider) can replace the verifier. */
export const APP_CHECK_VERIFIER = Symbol('APP_CHECK_VERIFIER');

/** What the rest of the app may know about a verified App Check token. */
export interface VerifiedAppCheck {
  /** The Firebase web app that minted the token. */
  appId: string;
}

export interface AppCheckVerifier {
  /** Resolves only for a genuine, unexpired token issued for this project. Rejects with one of the two errors below. */
  verify(token: string): Promise<VerifiedAppCheck>;
}

/** The token is not acceptable: forged, expired, for another project, malformed. */
export class AppCheckRejectedError extends Error {
  override readonly name = 'AppCheckRejectedError';
}

/** We could not decide: Google unreachable. Says nothing about the token. */
export class AppCheckUnavailableError extends Error {
  override readonly name = 'AppCheckUnavailableError';
}
