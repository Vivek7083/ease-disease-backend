import { z } from 'zod';
import { computeVerifyPaymentHash, parseAmountToPaise } from './payu-hash.js';

export type PayuEnv = 'test' | 'live';

export interface PayuConfig {
  key: string;
  salt: string;
  env: PayuEnv;
}

export const PAYU_ENDPOINTS: Record<PayuEnv, { checkoutUrl: string; verifyUrl: string }> = {
  test: {
    checkoutUrl: 'https://test.payu.in/_payment',
    verifyUrl: 'https://test.payu.in/merchant/postservice.php?form=2',
  },
  live: {
    checkoutUrl: 'https://secure.payu.in/_payment',
    verifyUrl: 'https://info.payu.in/merchant/postservice.php?form=2',
  },
};

/** Minimal HTTP seam so tests never touch the network. */
export type HttpPost = (
  url: string,
  formBody: string,
  options: { timeoutMs: number },
) => Promise<{ status: number; text: string }>;

export const fetchPost: HttpPost = async (url, formBody, { timeoutMs }) => {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formBody,
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: response.status, text: await response.text() };
};

/** PayU could not give us a trustworthy answer. Callers must NOT treat the payment as settled. */
export class PayuGatewayError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PayuGatewayError';
  }
}

export type PayuPaymentStatus = 'success' | 'failure' | 'pending' | 'cancelled' | 'unknown';

export type PayuVerifyResult =
  | { outcome: 'not_found' }
  | {
      outcome: 'found';
      txnid: string;
      /** Normalised. Anything we don't recognise is 'unknown' and must never confirm a booking. */
      status: PayuPaymentStatus;
      rawStatus: string;
      amountPaise: number;
      mihpayid: string | null;
      mode: string | null;
      bankRefNum: string | null;
      errorCode: string | null;
      errorMessage: string | null;
    };

// Our txnids are `EDTX` + ULID (<= 25 chars). Restricting the charset also blocks `|`,
// which PayU treats as a separator for multi-transaction lookups.
const TXNID_PATTERN = /^[A-Za-z0-9_-]{1,25}$/;

const nullableString = z
  .union([z.string(), z.number()])
  .nullish()
  .transform((value) => (value === null || value === undefined ? null : String(value)));

const entrySchema = z.object({
  status: z.string(),
  txnid: z.string().optional(),
  mihpayid: nullableString,
  amt: z.string().optional(),
  mode: nullableString,
  bank_ref_num: nullableString,
  unmappedstatus: nullableString,
  error_code: nullableString,
  error_Message: nullableString,
});

const responseSchema = z.object({
  status: z.union([z.number(), z.string()]),
  transaction_details: z.record(z.string(), z.unknown()),
});

const DEFAULT_TIMEOUT_MS = 10_000;

export class PayuClient {
  constructor(
    private readonly getConfig: () => PayuConfig,
    private readonly http: HttpPost = fetchPost,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  /**
   * Server-to-server `verify_payment`. PayU's answer here is the source of truth for a payment.
   * Fails closed: timeouts, non-200s, malformed JSON, or a response that doesn't match the txnid
   * we asked about all throw {@link PayuGatewayError}.
   */
  async verifyPayment(txnid: string): Promise<PayuVerifyResult> {
    if (!TXNID_PATTERN.test(txnid)) {
      throw new RangeError('invalid txnid');
    }
    const { key, salt, env } = this.getConfig();
    const command = 'verify_payment';
    const body = new URLSearchParams({
      key,
      command,
      var1: txnid,
      hash: computeVerifyPaymentHash({ key, salt, command, var1: txnid }),
    }).toString();

    let status: number;
    let text: string;
    try {
      ({ status, text } = await this.http(PAYU_ENDPOINTS[env].verifyUrl, body, { timeoutMs: this.timeoutMs }));
    } catch (error) {
      throw new PayuGatewayError('verify_payment request failed', { cause: error });
    }
    if (status !== 200) {
      throw new PayuGatewayError(`verify_payment returned HTTP ${status}`);
    }

    return this.parse(txnid, text);
  }

  private parse(txnid: string, text: string): PayuVerifyResult {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (error) {
      throw new PayuGatewayError('verify_payment returned non-JSON', { cause: error });
    }
    const response = responseSchema.safeParse(json);
    if (!response.success) {
      throw new PayuGatewayError('verify_payment response had an unexpected shape');
    }

    const rawEntry = response.data.transaction_details[txnid];
    if (rawEntry === undefined) {
      throw new PayuGatewayError('verify_payment response did not include the requested txnid');
    }
    const entry = entrySchema.safeParse(rawEntry);
    if (!entry.success) {
      throw new PayuGatewayError('verify_payment transaction entry had an unexpected shape');
    }
    const detail = entry.data;

    if (detail.status.toLowerCase() === 'not found') {
      return { outcome: 'not_found' };
    }
    if (detail.txnid !== undefined && detail.txnid !== txnid) {
      throw new PayuGatewayError('verify_payment txnid does not match the request');
    }
    const amountPaise = detail.amt === undefined ? null : parseAmountToPaise(detail.amt);
    if (amountPaise === null) {
      throw new PayuGatewayError('verify_payment amount missing or malformed');
    }

    return {
      outcome: 'found',
      txnid,
      status: normaliseStatus(detail.status, detail.unmappedstatus),
      rawStatus: detail.status,
      amountPaise,
      mihpayid: detail.mihpayid,
      mode: detail.mode,
      bankRefNum: detail.bank_ref_num,
      errorCode: detail.error_code,
      errorMessage: detail.error_Message,
    };
  }
}

function normaliseStatus(status: string, unmappedStatus: string | null): PayuPaymentStatus {
  const s = status.toLowerCase();
  if (s === 'success') return 'success';
  if (s === 'pending') return 'pending';
  if (s === 'failure') return unmappedStatus?.toLowerCase() === 'usercancelled' ? 'cancelled' : 'failure';
  if (s === 'usercancelled' || s === 'cancelled') return 'cancelled';
  return 'unknown';
}
