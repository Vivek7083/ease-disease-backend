import { CanActivate, ExecutionContext, Inject, Injectable, Logger, SetMetadata } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AppException } from '../common/exceptions/app.exception.js';
import type { Env } from '../config/env.schema.js';
import { IDENTITY_VERIFIER, IdentityUnavailableError, type IdentityVerifier, type VerifiedIdentity } from './identity-verifier.js';

const MAX_AUTHORIZATION_CHARS = 4096;
const MAX_LOGGED_REASON_CHARS = 200;
/** Same strict shape as the tick guard: the scheme, one space, then exactly three base64url parts. */
const BEARER_JWT = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i;
/**
 * The Firebase Auth emulator issues UNSIGNED tokens, which end with a dot (an empty signature). Accepted only when the
 * emulator is configured outside staging/production; real tokens always carry a signature.
 */
const BEARER_JWT_EMULATOR = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*)$/i;

export const REQUIRE_FRESH_IDENTITY = 'requireFreshIdentity';
/**
 * Marks a route (or controller) where a revoked or disabled account must be refused even if its token has not expired
 * yet. In staging and production the guard then also asks Google; in development and test it does not, because a
 * laptop has no Google credentials for that lookup.
 */
export const RequireFreshIdentity = () => SetMetadata(REQUIRE_FRESH_IDENTITY, true);

export type AuthenticatedRequest = Request & { identity?: VerifiedIdentity };

/**
 * Turns `Authorization: Bearer <Firebase ID token>` into a verified identity on the request. Fails closed: when Firebase
 * is not configured, or on any doubt about the token, the answer is the same 401 whatever the reason (the reason goes to
 * the log, never to the caller) and nothing behind the guard runs. A genuine token with an unverified email is 403, and
 * only after the token itself has been proven. When Google cannot be reached the answer is 503, never a silent pass.
 */
@Injectable()
export class FirebaseAuthGuard implements CanActivate {
  private readonly logger = new Logger(FirebaseAuthGuard.name);

  constructor(
    private readonly config: ConfigService<Env, true>,
    @Inject(IDENTITY_VERIFIER) private readonly verifier: IdentityVerifier,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!this.config.get('FIREBASE_PROJECT_ID', { infer: true })) return this.deny('Firebase sign-in is not configured');

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    // Node keeps only the first of several Authorization headers; a proxy in front may honour another. Refuse the ambiguity.
    if (countAuthorizationHeaders(request.rawHeaders) > 1) return this.deny('more than one Authorization header');
    const header = request.headers['authorization'];
    if (typeof header !== 'string' || header.length > MAX_AUTHORIZATION_CHARS) return this.deny('missing or oversized Authorization header');
    const token = (this.allowsUnsignedTokens() ? BEARER_JWT_EMULATOR : BEARER_JWT).exec(header)?.[1];
    if (!token) return this.deny('Authorization header is not a Bearer JWT');

    const fresh = this.reflector.getAllAndOverride<boolean | undefined>(REQUIRE_FRESH_IDENTITY, [context.getHandler(), context.getClass()]) === true;
    const checkRevoked = fresh && this.isDeployed();

    let identity: VerifiedIdentity;
    try {
      identity = await this.verifier.verify(token, { checkRevoked });
    } catch (error) {
      if (error instanceof IdentityUnavailableError) {
        this.logger.error(`Sign-in verification unavailable: ${describe(error)}`);
        throw new AppException('AUTH_UNAVAILABLE', 'Authentication is temporarily unavailable', 503);
      }
      return this.deny(`token verification failed: ${describe(error)}`);
    }

    // Only a proven token gets this far, so a bad token can never be told apart from an unverified email by its answer.
    if (!identity.emailVerified || !identity.email || identity.email.trim() === '') {
      throw new AppException('EMAIL_NOT_VERIFIED', 'Verify your email address to continue', 403);
    }
    request.identity = identity;
    return true;
  }

  private allowsUnsignedTokens(): boolean {
    return !this.isDeployed() && Boolean(this.config.get('FIREBASE_AUTH_EMULATOR_HOST', { infer: true }));
  }

  private isDeployed(): boolean {
    const nodeEnv = this.config.get('NODE_ENV', { infer: true });
    return nodeEnv === 'staging' || nodeEnv === 'production';
  }

  private deny(reason: string): never {
    this.logger.warn(`Request rejected: ${reason}`);
    throw new AppException('UNAUTHENTICATED', 'Authentication required', 401);
  }
}

function countAuthorizationHeaders(rawHeaders: readonly string[] | undefined): number {
  let count = 0;
  for (let index = 0; index < (rawHeaders?.length ?? 0); index += 2) {
    if (rawHeaders![index]?.toLowerCase() === 'authorization') count++;
  }
  return count;
}

/** A log-safe reason: printable ASCII only (no forged log lines), bounded. Never contains the token. */
function describe(error: unknown): string {
  const text = error instanceof Error ? error.message : 'unknown error';
  return text.replace(/[^\x20-\x7E]/g, '?').slice(0, MAX_LOGGED_REASON_CHARS);
}
