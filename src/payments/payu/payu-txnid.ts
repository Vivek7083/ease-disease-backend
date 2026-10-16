import { randomBytes } from 'node:crypto';

/** 32 unambiguous characters (no I, L, O, U). 32 divides 256, so `byte % 32` is unbiased. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** `PU` tags the payment gateway (PayU), so a later gateway can have its own prefix. */
export const TXNID_PREFIX = 'EDTX_PU_';

/** Exactly 25 characters: PayU's documented maximum for `txnid` on the `_payment` API. */
export const TXNID_PATTERN = /^EDTX_PU_\d{13}[0-9A-HJKMNP-TV-Z]{4}$/;

/**
 * New PayU transaction id: `EDTX_PU_` + 13-digit epoch milliseconds + 4 random characters.
 * Generated only on the server, so the browser can never choose or probe an id. The time part makes ids
 * readable and sortable; the random part separates ids created in the same millisecond. It is NOT what
 * makes checkout idempotent: that comes from the database (one transaction per booking, stored txnid reused).
 * A collision (same millisecond and same 4 characters) is caught by the unique index on `order_id`.
 */
export function generateTxnid(
  nowMs: number = Date.now(),
  random: (size: number) => Uint8Array = randomBytes,
): string {
  // Between September 2001 and November 2286 the epoch is exactly 13 digits, which keeps the id at 25 characters.
  if (!Number.isInteger(nowMs) || nowMs < 1e12 || nowMs >= 1e13) {
    throw new RangeError('timestamp must be a 13-digit epoch in milliseconds');
  }
  const bytes = random(4);
  if (bytes.length !== 4) throw new RangeError('random source must return 4 bytes');
  let suffix = '';
  for (const byte of bytes) suffix += ALPHABET[byte % 32];
  return `${TXNID_PREFIX}${nowMs}${suffix}`;
}
