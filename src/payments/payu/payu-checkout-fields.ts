import { PAYU_ENDPOINTS, type PayuConfig } from './payu-client.js';
import { computeRequestHash, formatAmountPaise } from './payu-hash.js';
import { TXNID_PATTERN } from './payu-txnid.js';

/** Limits from PayU's "Additional Info for Payment APIs" reference. `firstname` is 60 in production but 20 in test, so we use 20 everywhere. */
const MAX_FIRSTNAME = 20;
const MAX_PRODUCTINFO = 100;
const MAX_EMAIL = 50;
/** PayU documents a 50-character maximum for surl / furl. Our callback URLs can exceed it; see `warnings`. */
const MAX_RETURN_URL = 50;
const MIN_AMOUNT_PAISE = 100; // ₹1

const REFERENCE_PATTERN = /^[A-Za-z0-9-]{1,32}$/;
const EMAIL_PATTERN = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

export const CALLBACK_PATH = '/v1/payments/payu/callback';

export type CheckoutFieldErrorCode = 'EMAIL_INVALID' | 'EMAIL_TOO_LONG' | 'PHONE_INVALID' | 'AMOUNT_INVALID' | 'REFERENCE_INVALID';

/** The data we were given cannot be sent to PayU as is. The caller turns this into the right API error. */
export class CheckoutFieldError extends Error {
  constructor(
    readonly code: CheckoutFieldErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CheckoutFieldError';
  }
}

/**
 * Reduces free text to letters, digits, space, `.`, `'` and `-`. Accents are folded to plain letters.
 * PayU documents no allowed-character list, so this is deliberately conservative; it also guarantees that
 * no `|` (the hash separator) or markup can ever reach a field. Whatever this returns is exactly what is hashed and sent.
 */
function cleanText(value: string, max: number): string {
  const ascii = value.normalize('NFD').replace(/\p{M}/gu, '');
  const kept = ascii.replace(/[^A-Za-z0-9 .'-]/g, ' ').replace(/\s+/g, ' ').trim();
  return kept.slice(0, max).trim();
}

/** First word of the customer's name, at most 20 characters; `Customer` when nothing usable is left. */
export function cleanFirstname(fullName: string | null | undefined): string {
  const firstWord = cleanText(fullName ?? '', 200).split(' ')[0] ?? '';
  return firstWord.slice(0, MAX_FIRSTNAME) || 'Customer';
}

/** The package title as shown on PayU's page, at most 100 characters; `Consultation` when nothing usable is left. */
export function cleanProductInfo(title: string | null | undefined): string {
  return cleanText(title ?? '', MAX_PRODUCTINFO) || 'Consultation';
}

/** Indian mobile number as 10 digits (accepts +91 / 91 / 0 prefixes and separators). */
export function cleanPhone(raw: string): string {
  let digits = raw.replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  if (!/^[6-9]\d{9}$/.test(digits)) {
    throw new CheckoutFieldError('PHONE_INVALID', 'Phone must be a 10-digit Indian mobile number');
  }
  return digits;
}

/** PayU allows at most 50 characters. A strict ASCII pattern also keeps `|` and markup out of the hashed string. */
export function validateEmail(raw: string): string {
  const email = raw.trim();
  if (email.length > MAX_EMAIL) {
    throw new CheckoutFieldError('EMAIL_TOO_LONG', `Email is longer than PayU's ${MAX_EMAIL}-character limit`);
  }
  if (!EMAIL_PATTERN.test(email)) {
    throw new CheckoutFieldError('EMAIL_INVALID', 'Email is not in a form PayU accepts');
  }
  return email;
}

export interface CheckoutInput {
  creds: PayuConfig;
  /** From `generateTxnid` (or the stored one when a checkout is repeated). */
  txnid: string;
  /** The booking's own snapshot, never a caller-supplied value. */
  amountPaise: number;
  productTitle: string;
  customerName: string | null;
  email: string;
  phone: string;
  bookingReference: string;
  /** Origin of this API, e.g. `https://api.easedisease.in` (validated by the env schema). */
  apiPublicUrl: string;
}

export interface CheckoutForm {
  gatewayUrl: string;
  method: 'POST';
  /** Everything the browser must post to PayU. Never contains the salt. */
  fields: Record<string, string>;
  /** Things that may make PayU refuse the checkout; they do not stop us from building it. */
  warnings: string[];
}

/**
 * Pure: builds the hosted-checkout form for PayU and its request hash. No database, no network, and the salt
 * is used only inside the hash. Sends exactly the fields PayU documents; never `pg`, `bankcode`,
 * `service_provider` or `api_version`.
 */
export function buildCheckoutFields(input: CheckoutInput): CheckoutForm {
  if (!TXNID_PATTERN.test(input.txnid)) throw new RangeError('txnid is not in our transaction id format');
  if (new URL(input.apiPublicUrl).origin !== input.apiPublicUrl) throw new RangeError('apiPublicUrl must be an origin without a trailing slash');
  if (!REFERENCE_PATTERN.test(input.bookingReference)) {
    throw new CheckoutFieldError('REFERENCE_INVALID', 'Booking reference is not in the expected format');
  }
  if (!Number.isSafeInteger(input.amountPaise) || input.amountPaise < MIN_AMOUNT_PAISE) {
    throw new CheckoutFieldError('AMOUNT_INVALID', 'Amount must be at least ₹1');
  }

  const email = validateEmail(input.email);
  const phone = cleanPhone(input.phone);
  const amount = formatAmountPaise(input.amountPaise);
  const productinfo = cleanProductInfo(input.productTitle);
  const firstname = cleanFirstname(input.customerName);
  const returnUrl = `${input.apiPublicUrl}${CALLBACK_PATH}`;

  const hash = computeRequestHash({
    key: input.creds.key,
    salt: input.creds.salt,
    txnid: input.txnid,
    amount,
    productinfo,
    firstname,
    email,
    udf1: input.bookingReference,
  });

  const warnings: string[] = [];
  if (returnUrl.length > MAX_RETURN_URL) {
    warnings.push(
      `surl/furl/curl are ${returnUrl.length} characters; PayU's docs state a ${MAX_RETURN_URL}-character maximum (not yet confirmed against a real transaction)`,
    );
  }
  if (!returnUrl.startsWith('https://')) {
    warnings.push("surl/furl/curl are not https; PayU's hosted-checkout docs require a public https URL");
  }

  return {
    gatewayUrl: PAYU_ENDPOINTS[input.creds.env].checkoutUrl,
    method: 'POST',
    fields: {
      key: input.creds.key,
      txnid: input.txnid,
      amount,
      productinfo,
      firstname,
      email,
      phone,
      surl: returnUrl,
      furl: returnUrl,
      curl: returnUrl,
      udf1: input.bookingReference,
      hash,
    },
    warnings,
  };
}
