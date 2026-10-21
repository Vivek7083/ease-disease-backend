import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { deleteApp, initializeApp, type App } from 'firebase-admin/app';
import { getAppCheck, type AppCheck } from 'firebase-admin/app-check';
import { AppCheckRejectedError, AppCheckUnavailableError, type AppCheckVerifier, type VerifiedAppCheck } from './app-check-verifier.js';

/** SDK error codes that mean "this token is not acceptable". */
const REJECTED_CODES = new Set(['app-check/invalid-argument', 'app-check/app-check-token-expired']);
/** SDK error codes that mean "we could not find out". */
const UNAVAILABLE_CODES = new Set(['app-check/invalid-credential', 'app-check/internal-error', 'app-check/aborted']);
/**
 * The SDK reports a failed download of Google's App Check signing keys with the SAME code as a forged token
 * (`app-check/invalid-argument`), so only the message tells them apart. The prefix is written by the SDK, never copied
 * from the token. Pinned by a test against the real SDK.
 */
const UNAVAILABLE_MESSAGE_PREFIXES = ['Error fetching Json Web Keys:'];

export interface FirebaseAppCheckVerifierOptions {
  projectId: string;
  /** For tests: an AppCheck whose key download has been replaced. Production builds its own from the project id alone. */
  appCheck?: Pick<AppCheck, 'verifyToken'>;
}

/**
 * Verifies Firebase App Check tokens with the Firebase Admin SDK (signature against Google's published keys, issuer,
 * audience, subject, expiry). No credentials file is needed. Replay protection (`consume`) is deliberately not used.
 */
export class FirebaseAppCheckVerifier implements AppCheckVerifier {
  private readonly logger = new Logger(FirebaseAppCheckVerifier.name);
  private app: App | undefined;
  private readonly appCheck: Pick<AppCheck, 'verifyToken'>;

  constructor(options: FirebaseAppCheckVerifierOptions) {
    if (options.appCheck) {
      this.appCheck = options.appCheck;
    } else {
      this.app = initializeApp({ projectId: options.projectId }, `ease-disease-app-check-${randomUUID()}`);
      this.appCheck = getAppCheck(this.app);
    }
  }

  /** Safe to call more than once. */
  async onModuleDestroy(): Promise<void> {
    const app = this.app;
    this.app = undefined;
    if (app) await deleteApp(app);
  }

  async verify(token: string): Promise<VerifiedAppCheck> {
    try {
      const result = await this.appCheck.verifyToken(token);
      if (typeof result.appId !== 'string' || result.appId.length === 0) throw new AppCheckRejectedError('token has no app id');
      return { appId: result.appId };
    } catch (error) {
      if (error instanceof AppCheckRejectedError) throw error;
      throw this.classify(error);
    }
  }

  private classify(error: unknown): Error {
    const code = typeof (error as { code?: unknown } | null)?.code === 'string' ? (error as { code: string }).code : undefined;
    const message = error instanceof Error ? error.message : String(error);
    if (code && UNAVAILABLE_CODES.has(code)) return new AppCheckUnavailableError(`${code}: ${message}`);
    if (UNAVAILABLE_MESSAGE_PREFIXES.some((prefix) => message.startsWith(prefix))) return new AppCheckUnavailableError(message);
    if (code && REJECTED_CODES.has(code)) return new AppCheckRejectedError(`${code}: ${message}`);
    // Unknown: still denied and still identical to the caller, but it is a bug or an SDK change, so it is loud in the log.
    this.logger.error(`Unrecognised error while verifying an App Check token (denied): ${code ?? 'no code'}: ${message}`);
    return new AppCheckRejectedError(`unrecognised verifier error: ${code ?? 'no code'}`);
  }
}

/** Used when no Firebase project is configured (development/test only): every token is refused, nothing is contacted. */
export class UnconfiguredAppCheckVerifier implements AppCheckVerifier {
  verify(): Promise<VerifiedAppCheck> {
    return Promise.reject(new AppCheckRejectedError('Firebase is not configured'));
  }
}
