import { Module } from '@nestjs/common';
import {
  BOOKING_CREATE_LIMIT_PER_HOUR,
  BOOKING_CREATE_RATE_LIMITER,
  BOOKING_CREATE_WINDOW_MS,
  BookingCreateRateLimitGuard,
  CHECKOUT_LIMIT_PER_HOUR,
  CHECKOUT_RATE_LIMITER,
  CHECKOUT_WINDOW_MS,
  CheckoutRateLimitGuard,
  IP_LIMIT_PER_MINUTE,
  IP_RATE_LIMITER,
  IpRateLimitGuard,
  RATE_LIMIT_WINDOW_MS,
  READ_IP_LIMIT_PER_MINUTE,
  READ_IP_RATE_LIMITER,
  READ_LIMIT_PER_MINUTE,
  READ_RATE_LIMITER,
  ReadIpRateLimitGuard,
  ReadRateLimitGuard,
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
    { provide: BOOKING_CREATE_RATE_LIMITER, useFactory: () => new SlidingWindowLimiter(BOOKING_CREATE_LIMIT_PER_HOUR, BOOKING_CREATE_WINDOW_MS) },
    { provide: CHECKOUT_RATE_LIMITER, useFactory: () => new SlidingWindowLimiter(CHECKOUT_LIMIT_PER_HOUR, CHECKOUT_WINDOW_MS) },
    { provide: READ_RATE_LIMITER, useFactory: () => new SlidingWindowLimiter(READ_LIMIT_PER_MINUTE, RATE_LIMIT_WINDOW_MS) },
    { provide: READ_IP_RATE_LIMITER, useFactory: () => new SlidingWindowLimiter(READ_IP_LIMIT_PER_MINUTE, RATE_LIMIT_WINDOW_MS) },
    IpRateLimitGuard,
    UserRateLimitGuard,
    BookingCreateRateLimitGuard,
    CheckoutRateLimitGuard,
    ReadIpRateLimitGuard,
    ReadRateLimitGuard,
  ],
  exports: [
    IP_RATE_LIMITER,
    USER_RATE_LIMITER,
    BOOKING_CREATE_RATE_LIMITER,
    CHECKOUT_RATE_LIMITER,
    READ_RATE_LIMITER,
    READ_IP_RATE_LIMITER,
    IpRateLimitGuard,
    UserRateLimitGuard,
    BookingCreateRateLimitGuard,
    CheckoutRateLimitGuard,
    ReadIpRateLimitGuard,
    ReadRateLimitGuard,
  ],
})
export class RateLimitModule {}
