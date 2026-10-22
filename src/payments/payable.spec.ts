import { describe, expect, it } from 'vitest';
import { canPay } from './payable.js';

const BOOKING = ['PENDING_PAYMENT', 'CONFIRMED', 'COMPLETED', 'CANCELLED', 'NO_SHOW', 'EXPIRED', 'NEEDS_ATTENTION', 'FAILED'];
const PAYMENT = [null, 'CREATED', 'INITIATED', 'PENDING', 'SUCCESS', 'FAILURE', 'CANCELLED', 'EXPIRED'];

describe('canPay', () => {
  it('is true for a booking waiting for payment with no payment record, or one not yet decided at PayU', () => {
    expect(canPay('PENDING_PAYMENT', null)).toBe(true);
    expect(canPay('PENDING_PAYMENT', 'CREATED')).toBe(true);
    expect(canPay('PENDING_PAYMENT', 'INITIATED')).toBe(true);
  });

  it.each(['PENDING', 'SUCCESS', 'FAILURE', 'CANCELLED', 'EXPIRED'])('is false while the payment is %s', (payment) => {
    expect(canPay('PENDING_PAYMENT', payment)).toBe(false);
  });

  it.each(BOOKING.filter((status) => status !== 'PENDING_PAYMENT'))('is false for a %s booking whatever its payment', (status) => {
    for (const payment of PAYMENT) expect(canPay(status, payment)).toBe(false);
  });
});
