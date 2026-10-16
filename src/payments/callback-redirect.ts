import type { HandleResult } from './payment-handler.service.js';

export const DEFAULT_FRONTEND_BASE_URL = 'http://localhost:4200';

/** Our booking references look like `ED-7K3QXM`. Anything else never reaches a URL. */
const REFERENCE_PATTERN = /^[A-Za-z0-9-]{1,32}$/;

export type FallbackReason = 'verify' | 'busy' | 'server';

/**
 * Where the user's browser is sent after PayU posts to our callback. Built only from our configured
 * frontend origin plus a booking reference that came from OUR database (never from the payload),
 * and re-checked against a strict pattern, so nothing a caller sends can steer the redirect.
 * The page it lands on reads the real status from the API; nothing in the URL is trusted.
 */
export function callbackRedirectUrl(frontendBaseUrl: string, result: HandleResult): string {
  const { outcome, bookingReference } = result;
  if (!bookingReference || !REFERENCE_PATTERN.test(bookingReference)) {
    return fallbackUrl(frontendBaseUrl, 'verify');
  }
  const suffix = outcome === 'hash_invalid' || outcome === 'ignored' ? '?e=verify' : '';
  return `${frontendBaseUrl}/booking/${encodeURIComponent(bookingReference)}${suffix}`;
}

/** Used when no booking reference is known (unknown transaction, rate limit, or an internal error). */
export function fallbackUrl(frontendBaseUrl: string, reason: FallbackReason): string {
  return `${frontendBaseUrl}/bookings?e=${reason}`;
}
