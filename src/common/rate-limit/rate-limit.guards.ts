import { createHash } from 'node:crypto';
import { CanActivate, ExecutionContext, HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AppException } from '../exceptions/app.exception.js';
import type { AuthenticatedRequest } from '../../auth/firebase-auth.guard.js';
import type { LimitDecision, SlidingWindowLimiter } from './sliding-window-limiter.js';

/** Injection tokens for the two limiter instances used by the sign-in routes. */
export const IP_RATE_LIMITER = Symbol('IP_RATE_LIMITER');
export const USER_RATE_LIMITER = Symbol('USER_RATE_LIMITER');

/** api-flow.md section 7: `/auth/sync` and `/me` share 30 / minute / person; 120 / minute / IP sits in front of everything. */
export const USER_LIMIT_PER_MINUTE = 30;
export const IP_LIMIT_PER_MINUTE = 120;
export const RATE_LIMIT_WINDOW_MS = 60_000;

/** Answers 429 in the standard envelope, with `Retry-After` (whole seconds, at least 1) on the response. */
function refuse(response: Response, decision: LimitDecision): never {
  const retryAfterSeconds = Math.max(1, Math.ceil(decision.retryAfterMs / 1000));
  response.setHeader('Retry-After', String(retryAfterSeconds));
  throw new AppException('RATE_LIMITED', 'Too many requests', HttpStatus.TOO_MANY_REQUESTS, { retryAfterSeconds });
}

/**
 * First guard on the sign-in routes: counts EVERY request from an address, including ones whose tokens turn out to be
 * garbage, so a flood from one place is slowed before any token is looked at. The address is `req.ip` as resolved by the
 * trust-proxy setting, so a forged `X-Forwarded-For` cannot pick the key.
 */
@Injectable()
export class IpRateLimitGuard implements CanActivate {
  private readonly logger = new Logger(IpRateLimitGuard.name);

  constructor(@Inject(IP_RATE_LIMITER) private readonly limiter: SlidingWindowLimiter) {}

  canActivate(context: ExecutionContext): boolean {
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const decision = this.limiter.hit(request.ip ?? 'unknown');
    if (decision.allowed) return true;
    this.logger.warn(`Per-address rate limit reached (address ${request.ip ?? 'unknown'})`);
    return refuse(http.getResponse<Response>(), decision);
  }
}

/**
 * Must run AFTER the login guard: the key is the verified Firebase uid, which the caller cannot choose. Requests refused
 * by an earlier guard never get here, so they spend nobody's budget. A refused call never reaches the handler.
 */
@Injectable()
export class UserRateLimitGuard implements CanActivate {
  private readonly logger = new Logger(UserRateLimitGuard.name);

  constructor(@Inject(USER_RATE_LIMITER) private readonly limiter: SlidingWindowLimiter) {}

  canActivate(context: ExecutionContext): boolean {
    const http = context.switchToHttp();
    const identity = http.getRequest<AuthenticatedRequest>().identity;
    // A route that put this guard before the login guard would otherwise share one bucket between everybody.
    if (!identity) throw new AppException('UNAUTHENTICATED', 'Authentication required', HttpStatus.UNAUTHORIZED);
    const decision = this.limiter.hit(identity.uid);
    if (decision.allowed) return true;
    // A short fingerprint, not the uid: enough to see that one person is hammering, not enough to identify them.
    const fingerprint = createHash('sha256').update(identity.uid).digest('hex').slice(0, 8);
    this.logger.warn(`Per-user rate limit reached (user ${fingerprint})`);
    return refuse(http.getResponse<Response>(), decision);
  }
}
