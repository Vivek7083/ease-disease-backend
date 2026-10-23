import { createHash } from 'node:crypto';
import { CanActivate, ExecutionContext, HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AppException } from '../exceptions/app.exception.js';
import type { AuthenticatedRequest } from '../../auth/firebase-auth.guard.js';
import type { LimitDecision, SlidingWindowLimiter } from './sliding-window-limiter.js';

/** Injection tokens for the two limiter instances used by the sign-in routes. */
export const IP_RATE_LIMITER = Symbol('IP_RATE_LIMITER');
export const USER_RATE_LIMITER = Symbol('USER_RATE_LIMITER');
/** Separate bucket for creating bookings: it must not share a budget with the sign-in routes. */
export const BOOKING_CREATE_RATE_LIMITER = Symbol('BOOKING_CREATE_RATE_LIMITER');
/** Another separate bucket: asking for a payment form must not spend the booking budget, nor the other way round. */
export const CHECKOUT_RATE_LIMITER = Symbol('CHECKOUT_RATE_LIMITER');
/** Reading bookings (list, detail) has its own, larger buckets: the payment status page polls every 2 seconds. */
export const READ_RATE_LIMITER = Symbol('READ_RATE_LIMITER');
export const READ_IP_RATE_LIMITER = Symbol('READ_IP_RATE_LIMITER');
/** Public reads (the package list) need no login, so only an address budget applies, separate from everything else. */
export const PUBLIC_READ_RATE_LIMITER = Symbol('PUBLIC_READ_RATE_LIMITER');

/** api-flow.md section 7: `/auth/sync` and `/me` share 30 / minute / person; 120 / minute / IP sits in front of everything. */
export const USER_LIMIT_PER_MINUTE = 30;
export const IP_LIMIT_PER_MINUTE = 120;
export const RATE_LIMIT_WINDOW_MS = 60_000;
/** api-flow.md section 7: `POST /v1/bookings` allows 10 / hour / person (a request-rate guard, separate from the count caps). */
export const BOOKING_CREATE_LIMIT_PER_HOUR = 10;
export const BOOKING_CREATE_WINDOW_MS = 3_600_000;
/** api-flow.md section 7: `POST /v1/bookings/{ref}/checkout` allows 10 / hour / person. */
export const CHECKOUT_LIMIT_PER_HOUR = 10;
export const CHECKOUT_WINDOW_MS = 3_600_000;
/** api-flow.md section 7: reading bookings allows 120 / minute / person and 600 / minute / address. */
export const READ_LIMIT_PER_MINUTE = 120;
export const READ_IP_LIMIT_PER_MINUTE = 600;
/** api-flow.md section 7: public GETs allow 60 / minute / address. */
export const PUBLIC_READ_LIMIT_PER_MINUTE = 60;

/** Answers 429 in the standard envelope, with `Retry-After` (whole seconds, at least 1) on the response. */
function refuse(response: Response, decision: LimitDecision): never {
  const retryAfterSeconds = Math.max(1, Math.ceil(decision.retryAfterMs / 1000));
  response.setHeader('Retry-After', String(retryAfterSeconds));
  throw new AppException('RATE_LIMITED', 'Too many requests', HttpStatus.TOO_MANY_REQUESTS, { retryAfterSeconds });
}

/**
 * First guard on a route: counts EVERY request from an address, including ones whose tokens turn out to be garbage, so a
 * flood from one place is slowed before any token is looked at. The address is `req.ip` as resolved by the trust-proxy
 * setting, so a forged `X-Forwarded-For` cannot pick the key. Subclasses only say which limiter (budget) they spend.
 */
abstract class PerAddressRateLimitGuard implements CanActivate {
  private readonly logger: Logger;

  protected constructor(private readonly limiter: SlidingWindowLimiter) {
    this.logger = new Logger(new.target.name);
  }

  canActivate(context: ExecutionContext): boolean {
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const decision = this.limiter.hit(request.ip ?? 'unknown');
    if (decision.allowed) return true;
    this.logger.warn(`Per-address rate limit reached (address ${request.ip ?? 'unknown'})`);
    return refuse(http.getResponse<Response>(), decision);
  }
}

/** Sign-in, booking creation and checkout: 120 / minute / address, one shared bucket. */
@Injectable()
export class IpRateLimitGuard extends PerAddressRateLimitGuard {
  constructor(@Inject(IP_RATE_LIMITER) limiter: SlidingWindowLimiter) {
    super(limiter);
  }
}

/** Reading bookings: 600 / minute / address (offices and phone carriers share addresses), its own bucket. */
@Injectable()
export class ReadIpRateLimitGuard extends PerAddressRateLimitGuard {
  constructor(@Inject(READ_IP_RATE_LIMITER) limiter: SlidingWindowLimiter) {
    super(limiter);
  }
}

/** Public GETs such as `/v1/packages`: 60 / minute / address, its own bucket. */
@Injectable()
export class PublicReadRateLimitGuard extends PerAddressRateLimitGuard {
  constructor(@Inject(PUBLIC_READ_RATE_LIMITER) limiter: SlidingWindowLimiter) {
    super(limiter);
  }
}

/**
 * Per-person limit. Must run AFTER the login guard: the key is the verified Firebase uid, which the caller cannot choose.
 * Requests refused by an earlier guard never get here, so they spend nobody's budget. A refused call never reaches the
 * handler. Subclasses only say which limiter (budget) they spend.
 */
abstract class PerUserRateLimitGuard implements CanActivate {
  private readonly logger: Logger;

  protected constructor(private readonly limiter: SlidingWindowLimiter) {
    this.logger = new Logger(new.target.name);
  }

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

/** `/auth/sync` and `/me`: one shared budget of 30 / minute / person. */
@Injectable()
export class UserRateLimitGuard extends PerUserRateLimitGuard {
  constructor(@Inject(USER_RATE_LIMITER) limiter: SlidingWindowLimiter) {
    super(limiter);
  }
}

/** `POST /v1/bookings`: 10 / hour / person. */
@Injectable()
export class BookingCreateRateLimitGuard extends PerUserRateLimitGuard {
  constructor(@Inject(BOOKING_CREATE_RATE_LIMITER) limiter: SlidingWindowLimiter) {
    super(limiter);
  }
}

/** `POST /v1/bookings/{ref}/checkout`: 10 / hour / person. */
@Injectable()
export class CheckoutRateLimitGuard extends PerUserRateLimitGuard {
  constructor(@Inject(CHECKOUT_RATE_LIMITER) limiter: SlidingWindowLimiter) {
    super(limiter);
  }
}

/** Reading bookings (list and detail): one shared budget of 120 / minute / person. */
@Injectable()
export class ReadRateLimitGuard extends PerUserRateLimitGuard {
  constructor(@Inject(READ_RATE_LIMITER) limiter: SlidingWindowLimiter) {
    super(limiter);
  }
}
