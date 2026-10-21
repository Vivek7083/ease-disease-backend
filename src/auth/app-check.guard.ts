import { CanActivate, ExecutionContext, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { AppException } from '../common/exceptions/app.exception.js';
import type { Env } from '../config/env.schema.js';
import { APP_CHECK_VERIFIER, AppCheckUnavailableError, type AppCheckVerifier, type VerifiedAppCheck } from './app-check-verifier.js';

const HEADER = 'x-firebase-appcheck';
const MAX_HEADER_CHARS = 4096;
const MAX_LOGGED_REASON_CHARS = 200;
/** Exactly three non-empty base64url parts. */
const APP_CHECK_JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export type AppCheckedRequest = Request & { appCheck?: VerifiedAppCheck };

/**
 * Requires `X-Firebase-AppCheck: <token>`: proof the call comes from our real web app. Fails closed: when Firebase is
 * not configured, or on any doubt about the token, the answer is the same 403 whatever the reason (the reason goes to
 * the log, never to the caller). When Google cannot be reached the answer is 503, never a silent pass. Only
 * `APP_CHECK_MODE=off` (refused outside development/test by the boot check) lets calls through; `AuthModule` says so
 * loudly once at start-up (a guard is instantiated once per controller that uses it, so it cannot do that itself).
 *
 * Order: put this guard BEFORE `FirebaseAuthGuard` (`@UseGuards(AppCheckGuard, FirebaseAuthGuard)`), so scripts are
 * refused before any login or revocation work is spent on them.
 */
@Injectable()
export class AppCheckGuard implements CanActivate {
  private readonly logger = new Logger(AppCheckGuard.name);

  constructor(
    private readonly config: ConfigService<Env, true>,
    @Inject(APP_CHECK_VERIFIER) private readonly verifier: AppCheckVerifier,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.config.get('APP_CHECK_MODE', { infer: true }) === 'off') return true;
    if (!this.config.get('FIREBASE_PROJECT_ID', { infer: true })) return this.deny('Firebase is not configured');

    const request = context.switchToHttp().getRequest<AppCheckedRequest>();
    // Node joins repeated copies of this header with ", ", which the strict shape check below refuses.
    const token = request.headers[HEADER];
    if (typeof token !== 'string' || token.length > MAX_HEADER_CHARS) return this.deny('missing or oversized App Check header');
    if (!APP_CHECK_JWT.test(token)) return this.deny('App Check header is not a JWT');

    try {
      request.appCheck = await this.verifier.verify(token);
    } catch (error) {
      if (error instanceof AppCheckUnavailableError) {
        this.logger.error(`App Check verification unavailable: ${describe(error)}`);
        throw new AppException('APP_CHECK_UNAVAILABLE', 'App verification is temporarily unavailable', 503);
      }
      return this.deny(`token verification failed: ${describe(error)}`);
    }
    return true;
  }

  private deny(reason: string): never {
    this.logger.warn(`Request rejected: ${reason}`);
    throw new AppException('APP_CHECK_FAILED', 'App verification failed', 403);
  }
}

/** A log-safe reason: printable ASCII only (no forged log lines), bounded. Never contains the token. */
function describe(error: unknown): string {
  const text = error instanceof Error ? error.message : 'unknown error';
  return text.replace(/[^\x20-\x7E]/g, '?').slice(0, MAX_LOGGED_REASON_CHARS);
}
