import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { deleteApp, initializeApp, type App } from 'firebase-admin/app';
import { getAuth, type Auth, type DecodedIdToken } from 'firebase-admin/auth';
import { IdentityRejectedError, IdentityUnavailableError, type IdentityVerifier, type VerifiedIdentity, type VerifyOptions } from './identity-verifier.js';

/** A token issued "in the future" by this much or less is clock skew, not an attack. */
const CLOCK_SKEW_SECONDS = 60;
const MAX_UID_CHARS = 128;

/** SDK error codes that mean "this token is not acceptable". */
const REJECTED_CODES = new Set([
  'auth/argument-error',
  'auth/id-token-expired',
  'auth/id-token-revoked',
  'auth/invalid-id-token',
  'auth/user-disabled',
  'auth/user-not-found',
]);
/** SDK error codes that mean "we could not find out". */
const UNAVAILABLE_CODES = new Set([
  'app/network-error',
  'app/network-timeout',
  'app/invalid-credential',
  'app/unable-to-parse-response',
  'auth/internal-error',
]);
/**
 * The SDK reports a failed download of Google's signing keys with the SAME code as a forged token
 * (`auth/argument-error`), so only the message tells them apart. Both prefixes are written by the SDK and its HTTP
 * client, never copied from the token, and token faults use different sentences. Pinned by tests against the real SDK.
 */
const UNAVAILABLE_MESSAGE_PREFIXES = ['Error while making request:', 'Error fetching public keys for Google certs:'];

export interface FirebaseIdentityVerifierOptions {
  projectId: string;
  /** For tests: an Auth whose key download has been replaced. Production builds its own from the project id alone. */
  auth?: Pick<Auth, 'verifyIdToken'>;
  /** For tests. */
  now?: () => number;
}

/**
 * Verifies Firebase ID tokens with the Firebase Admin SDK (signature against Google's published keys, issuer,
 * audience, subject, expiry), then applies a few checks of our own that the SDK does not make. No credentials file is
 * needed to verify a token; only the optional revocation lookup uses Google credentials (Cloud Run supplies them).
 */
export class FirebaseIdentityVerifier implements IdentityVerifier {
  private readonly logger = new Logger(FirebaseIdentityVerifier.name);
  private app: App | undefined;
  private readonly auth: Pick<Auth, 'verifyIdToken'>;
  private readonly now: () => number;

  constructor(options: FirebaseIdentityVerifierOptions) {
    this.now = options.now ?? Date.now;
    if (options.auth) {
      this.auth = options.auth;
    } else {
      this.app = initializeApp({ projectId: options.projectId }, `ease-disease-auth-${randomUUID()}`);
      this.auth = getAuth(this.app);
    }
  }

  /** Safe to call more than once (the framework may close an application twice in tests). */
  async onModuleDestroy(): Promise<void> {
    const app = this.app;
    this.app = undefined;
    if (app) await deleteApp(app);
  }

  async verify(token: string, options: VerifyOptions = {}): Promise<VerifiedIdentity> {
    let decoded: DecodedIdToken;
    try {
      decoded = await this.auth.verifyIdToken(token, options.checkRevoked === true);
    } catch (error) {
      throw this.classify(error);
    }
    return this.toIdentity(decoded);
  }

  private classify(error: unknown): Error {
    const code = typeof (error as { code?: unknown } | null)?.code === 'string' ? (error as { code: string }).code : undefined;
    const message = error instanceof Error ? error.message : String(error);
    if (code && UNAVAILABLE_CODES.has(code)) return new IdentityUnavailableError(`${code}: ${message}`);
    if (UNAVAILABLE_MESSAGE_PREFIXES.some((prefix) => message.startsWith(prefix))) return new IdentityUnavailableError(message);
    if (code && REJECTED_CODES.has(code)) return new IdentityRejectedError(`${code}: ${message}`);
    // Unknown: still denied and still identical to the caller, but it is a bug or an SDK change, so it is loud in the log.
    this.logger.error(`Unrecognised error while verifying an ID token (denied): ${code ?? 'no code'}: ${message}`);
    return new IdentityRejectedError(`unrecognised verifier error: ${code ?? 'no code'}`);
  }

  /** The SDK's checks have passed; these are ours. */
  private toIdentity(decoded: DecodedIdToken): VerifiedIdentity {
    const nowSeconds = Math.floor(this.now() / 1000);
    const uid = decoded.uid;
    if (typeof uid !== 'string' || uid.length === 0 || uid.length > MAX_UID_CHARS) throw new IdentityRejectedError('token has no usable subject');
    // Only Google can sign, so a future timestamp cannot come from an attacker; still, a genuine token never has one.
    if (typeof decoded.iat === 'number' && decoded.iat > nowSeconds + CLOCK_SKEW_SECONDS) throw new IdentityRejectedError('token was issued in the future');
    if (typeof decoded.auth_time === 'number' && decoded.auth_time > nowSeconds + CLOCK_SKEW_SECONDS) {
      throw new IdentityRejectedError('token authentication time is in the future');
    }
    const firebase = decoded.firebase as { sign_in_provider?: unknown; tenant?: unknown } | undefined;
    if (!firebase || typeof firebase.sign_in_provider !== 'string' || firebase.sign_in_provider.length === 0) {
      throw new IdentityRejectedError('token is not a Firebase sign-in token');
    }
    if (firebase.tenant !== undefined) throw new IdentityRejectedError('tenant tokens are not accepted');

    const name = (decoded as unknown as Record<string, unknown>)['name'];
    return {
      uid,
      email: typeof decoded.email === 'string' ? decoded.email : undefined,
      emailVerified: decoded.email_verified === true,
      name: typeof name === 'string' && name.length > 0 ? name : undefined,
      signInProvider: firebase.sign_in_provider,
    };
  }
}

/** Used when no Firebase project is configured (development/test only): every token is refused, nothing is contacted. */
export class UnconfiguredIdentityVerifier implements IdentityVerifier {
  verify(): Promise<VerifiedIdentity> {
    return Promise.reject(new IdentityRejectedError('Firebase is not configured'));
  }
}
