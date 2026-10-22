import { Module } from '@nestjs/common';
import {
  IP_LIMIT_PER_MINUTE,
  IP_RATE_LIMITER,
  IpRateLimitGuard,
  RATE_LIMIT_WINDOW_MS,
  USER_LIMIT_PER_MINUTE,
  USER_RATE_LIMITER,
  UserRateLimitGuard,
} from './rate-limit.guards.js';
import { SlidingWindowLimiter } from './sliding-window-limiter.js';

/** One limiter instance per token for the whole application (a guard is instantiated once per controller using it). */
@Module({
  providers: [
    { provide: IP_RATE_LIMITER, useFactory: () => new SlidingWindowLimiter(IP_LIMIT_PER_MINUTE, RATE_LIMIT_WINDOW_MS) },
    { provide: USER_RATE_LIMITER, useFactory: () => new SlidingWindowLimiter(USER_LIMIT_PER_MINUTE, RATE_LIMIT_WINDOW_MS) },
    IpRateLimitGuard,
    UserRateLimitGuard,
  ],
  exports: [IP_RATE_LIMITER, USER_RATE_LIMITER, IpRateLimitGuard, UserRateLimitGuard],
})
export class RateLimitModule {}
