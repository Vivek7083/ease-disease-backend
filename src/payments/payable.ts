/** The only transaction states in which a checkout may be (re)issued: nothing has been decided at PayU yet. */
export const REUSABLE_TRANSACTION_STATUSES: readonly string[] = ['CREATED', 'INITIATED'];

/**
 * Whether the person can still be offered a payment form for a booking: it is waiting for payment and its payment record,
 * if any, is not already in progress or decided at PayU. This is exactly when the checkout route accepts the booking, so
 * a "Pay" button driven by it never leads to an error. One rule for the create answer, the list and the detail.
 */
export function canPay(bookingStatus: string, paymentStatus: string | null): boolean {
  return bookingStatus === 'PENDING_PAYMENT' && (paymentStatus === null || REUSABLE_TRANSACTION_STATUSES.includes(paymentStatus));
}
