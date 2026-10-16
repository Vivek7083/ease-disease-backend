import { describe, expect, it } from 'vitest';
import { callbackRedirectUrl, fallbackUrl } from './callback-redirect.js';
import type { HandleOutcome } from './payment-handler.service.js';

const BASE = 'https://easedisease.in';
const result = (outcome: HandleOutcome, bookingReference: string | null) => ({ outcome, bookingReference });

describe('callbackRedirectUrl', () => {
  it.each(['applied', 'duplicate', 'pending', 'failed_payment', 'mismatch', 'gateway_error', 'not_found_at_payu'] as const)(
    'sends %s to the booking page without any flag',
    (outcome) => {
      expect(callbackRedirectUrl(BASE, result(outcome, 'ED-7K3QXM'))).toBe('https://easedisease.in/booking/ED-7K3QXM');
    },
  );

  it.each(['hash_invalid', 'ignored'] as const)('flags %s with ?e=verify', (outcome) => {
    expect(callbackRedirectUrl(BASE, result(outcome, 'ED-7K3QXM'))).toBe('https://easedisease.in/booking/ED-7K3QXM?e=verify');
  });

  it('falls back to the bookings list when no reference is known', () => {
    expect(callbackRedirectUrl(BASE, result('unknown_transaction', null))).toBe('https://easedisease.in/bookings?e=verify');
  });

  it.each([
    '//evil.com',
    'https://evil.com',
    'ED-1/../../x',
    'ED-1?x=1',
    'ED-1#frag',
    'ED-1\r\nSet-Cookie: a=b',
    'ED 1',
    'javascript:alert(1)',
    '',
    'E'.repeat(33),
    'ED-é',
    '../admin',
  ])('never puts an unsafe reference (%j) into the URL', (reference) => {
    expect(callbackRedirectUrl(BASE, result('applied', reference))).toBe('https://easedisease.in/bookings?e=verify');
  });

  it('keeps the host fixed to the configured origin for every outcome', () => {
    const outcomes: HandleOutcome[] = ['applied', 'duplicate', 'hash_invalid', 'unknown_transaction', 'gateway_error'];
    for (const outcome of outcomes) {
      for (const reference of ['ED-7K3QXM', null, '//evil.com']) {
        expect(new URL(callbackRedirectUrl(BASE, result(outcome, reference))).origin).toBe(BASE);
      }
    }
  });
});

describe('fallbackUrl', () => {
  it.each(['verify', 'busy', 'server'] as const)('builds the %s page', (reason) => {
    expect(fallbackUrl(BASE, reason)).toBe(`https://easedisease.in/bookings?e=${reason}`);
  });
});
