import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * PayU hash primitives (pure functions, no I/O). Formulas per PayU docs and api-flow.md §4:
 *  - request:  sha512(key|txnid|amount|productinfo|firstname|email|udf1..udf5||||||SALT)
 *  - response: sha512([additional_charges|]SALT|status||||||udf5..udf1|email|firstname|productinfo|amount|txnid|key)
 *  - verify:   sha512(key|command|var1|salt)
 * The salt must never leave the server; none of these functions log or return it.
 */

export interface PayuUdfs {
  udf1?: string;
  udf2?: string;
  udf3?: string;
  udf4?: string;
  udf5?: string;
}

export interface PayuRequestHashInput extends PayuUdfs {
  key: string;
  salt: string;
  txnid: string;
  /** PayU decimal string, e.g. "1500.00" — see {@link formatAmountPaise}. */
  amount: string;
  productinfo: string;
  firstname: string;
  email: string;
}

export interface PayuResponseHashInput extends PayuUdfs {
  key: string;
  salt: string;
  txnid: string;
  /** Exactly the string PayU sent; never re-formatted. */
  amount: string;
  productinfo: string;
  firstname: string;
  email: string;
  status: string;
  /** Present only when PayU sent `additional_charges`. */
  additionalCharges?: string;
}

const sha512Hex = (input: string): string => createHash('sha512').update(input, 'utf8').digest('hex');

/** Integer paise -> PayU amount string ("150000" -> "1500.00"). Rejects anything that is not a safe non-negative integer. */
export function formatAmountPaise(paise: number): string {
  if (!Number.isSafeInteger(paise) || paise < 0) {
    throw new RangeError('amount in paise must be a non-negative safe integer');
  }
  const rupees = Math.floor(paise / 100);
  const remainder = (paise % 100).toString().padStart(2, '0');
  return `${rupees}.${remainder}`;
}

export function computeRequestHash(input: PayuRequestHashInput): string {
  return sha512Hex(
    [
      input.key,
      input.txnid,
      input.amount,
      input.productinfo,
      input.firstname,
      input.email,
      input.udf1 ?? '',
      input.udf2 ?? '',
      input.udf3 ?? '',
      input.udf4 ?? '',
      input.udf5 ?? '',
      '', '', '', '', '', // udf6..udf10, unused by PayU hosted checkout
      input.salt,
    ].join('|'),
  );
}

export function computeResponseHash(input: PayuResponseHashInput): string {
  const parts = [
    input.salt,
    input.status,
    '', '', '', '', '', // udf10..udf6
    input.udf5 ?? '',
    input.udf4 ?? '',
    input.udf3 ?? '',
    input.udf2 ?? '',
    input.udf1 ?? '',
    input.email,
    input.firstname,
    input.productinfo,
    input.amount,
    input.txnid,
    input.key,
  ];
  if (input.additionalCharges !== undefined && input.additionalCharges !== '') {
    parts.unshift(input.additionalCharges);
  }
  return sha512Hex(parts.join('|'));
}

export function computeVerifyPaymentHash(input: { key: string; salt: string; command: string; var1: string }): string {
  return sha512Hex([input.key, input.command, input.var1, input.salt].join('|'));
}

const RESPONSE_STRING_FIELDS = ['txnid', 'amount', 'productinfo', 'firstname', 'email', 'status', 'hash'] as const;
const OPTIONAL_STRING_FIELDS = ['udf1', 'udf2', 'udf3', 'udf4', 'udf5', 'additional_charges'] as const;

/**
 * Verifies the hash on a raw PayU callback/webhook payload (form fields).
 * Uses OUR configured key and salt — never the key in the payload. Never throws: a missing,
 * malformed, or non-string field, or a mismatched hash, all return false.
 */
export function verifyResponseHash(payload: Record<string, unknown>, creds: { key: string; salt: string }): boolean {
  for (const field of RESPONSE_STRING_FIELDS) {
    if (typeof payload[field] !== 'string') return false;
  }
  for (const field of OPTIONAL_STRING_FIELDS) {
    if (payload[field] !== undefined && typeof payload[field] !== 'string') return false;
  }
  const p = payload as Record<string, string | undefined>;

  const expected = computeResponseHash({
    key: creds.key,
    salt: creds.salt,
    txnid: p.txnid!,
    amount: p.amount!,
    productinfo: p.productinfo!,
    firstname: p.firstname!,
    email: p.email!,
    status: p.status!,
    udf1: p.udf1,
    udf2: p.udf2,
    udf3: p.udf3,
    udf4: p.udf4,
    udf5: p.udf5,
    additionalCharges: p.additional_charges,
  });

  return constantTimeEqualHex(expected, p.hash!.toLowerCase());
}

function constantTimeEqualHex(expected: string, actual: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(actual, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
