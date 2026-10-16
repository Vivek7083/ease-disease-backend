import { Inject, Injectable, Logger } from '@nestjs/common';
import type { PrismaClient } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PayuCredentialsProvider } from './payu/payu-credentials.provider.js';
import { verifyResponseHash } from './payu/payu-hash.js';
import { sanitizeForJsonb } from './json-sanitize.js';

export type PaymentSource = 'RETURN' | 'WEBHOOK' | 'RECONCILE';

export type HandleOutcome =
  /** Payload had no usable txnid, or the txnid matches no transaction of ours. Nothing changed. */
  | 'unknown_transaction'
  /** The reverse hash did not verify. Nothing changed, PayU was not called. */
  | 'hash_invalid'
  /** We could not check the hash (payment credentials are not configured). Nothing changed. */
  | 'gateway_error'
  /** Hash is valid but the payload's booking reference disagrees with ours. Nothing changed. */
  | 'ignored'
  /** Hash and reference are valid. (P4c continues from here: PayU verify and the state transitions.) */
  | 'verified';

export interface HandleInput {
  source: PaymentSource;
  /** Raw body exactly as received. Never trusted. */
  payload: unknown;
  /** Client address of the inbound request (null for RECONCILE). Resolved by the HTTP layer, never read from headers here. */
  sourceIp: string | null;
}

export interface HandleResult {
  outcome: HandleOutcome;
  /** From OUR database (via the txnid), never from the payload. Null when the transaction is unknown. */
  bookingReference: string | null;
}

// Our txnids are `EDTX` + ULID (<= 25 chars). The charset also keeps `|` and anything odd out of every query.
const TXNID_PATTERN = /^[A-Za-z0-9_-]{1,25}$/;
const MAX_STORED_PAYLOAD_CHARS = 100_000;
const MAX_IP_CHARS = 45;

/**
 * Single entry point for every PayU signal (browser return, webhook, reconcile). Idempotent and
 * safe to call concurrently. All database access uses Prisma's parameterised API.
 */
@Injectable()
export class PaymentHandlerService {
  private readonly logger = new Logger(PaymentHandlerService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaClient,
    private readonly credentials: PayuCredentialsProvider,
  ) {}

  async handle(input: HandleInput): Promise<HandleResult> {
    const payload = isPlainObject(input.payload) ? input.payload : undefined;
    const txnid = payload && typeof payload['txnid'] === 'string' && TXNID_PATTERN.test(payload['txnid']) ? payload['txnid'] : null;

    // Read-only lookup, so the event can reference its transaction. Nothing is written before the event.
    const transaction = txnid
      ? await this.prisma.transaction.findUnique({
          where: { orderId: txnid },
          select: { id: true, booking: { select: { reference: true } } },
        })
      : null;

    // Pure computation, no I/O.
    const hashCheck = this.checkHash(payload);
    const hashValid = hashCheck.valid;

    const event = await this.prisma.paymentEvent.create({
      data: {
        transactionId: transaction?.id ?? null,
        source: input.source,
        hashValid,
        payload: storablePayload(input.payload),
        sourceIp: normaliseIp(input.sourceIp),
      },
      select: { id: true },
    });

    const bookingReference = transaction?.booking.reference ?? null;
    const finish = async (
      outcome: HandleOutcome,
      checks: Record<string, boolean> = {},
    ): Promise<HandleResult> => {
      await this.prisma.paymentEvent.update({
        where: { id: event.id },
        data: {
          verification: {
            hash: { valid: hashValid, variant: hashCheck.variant, ...(hashCheck.reason ? { reason: hashCheck.reason } : {}) },
            payuVerify: null,
            checks,
            result: outcome,
            handledAt: new Date().toISOString(),
          },
        },
      });
      return { outcome, bookingReference };
    };

    if (!txnid || !transaction) {
      return finish('unknown_transaction');
    }
    if (hashCheck.reason === 'not_configured') {
      this.logger.error(`PayU credentials are not configured; cannot verify a payment signal for ${txnid}`);
      return finish('gateway_error');
    }
    if (!hashValid) {
      this.logger.warn(`Payment signal with an invalid hash for ${txnid} (${input.source})`);
      return finish('hash_invalid');
    }

    const referenceMatches = payload?.['udf1'] === transaction.booking.reference;
    if (!referenceMatches) {
      this.logger.warn(`Payment signal for ${txnid} carries a different booking reference than ours (${input.source})`);
      return finish('ignored', { referenceMatches: false });
    }

    return finish('verified', { referenceMatches: true });
  }

  private checkHash(payload: Record<string, unknown> | undefined): {
    valid: boolean;
    variant: 'standard' | 'additional_charges' | null;
    reason?: 'not_configured' | 'malformed_payload';
  } {
    if (!payload) return { valid: false, variant: null, reason: 'malformed_payload' };
    const variant = typeof payload['additional_charges'] === 'string' && payload['additional_charges'] !== '' ? 'additional_charges' : 'standard';
    let creds: { key: string; salt: string };
    try {
      creds = this.credentials.get();
    } catch {
      return { valid: false, variant, reason: 'not_configured' };
    }
    return { valid: verifyResponseHash(payload, creds), variant };
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The payload exactly as received, made storable; oversize payloads keep only a preview. */
function storablePayload(raw: unknown) {
  const sanitised = sanitizeForJsonb(raw);
  const asText = JSON.stringify(sanitised);
  if (asText.length <= MAX_STORED_PAYLOAD_CHARS) {
    return isPlainObject(sanitised) ? sanitised : { _raw: sanitised };
  }
  return { _truncated: true, _length: asText.length, _preview: asText.slice(0, 2000) };
}

function normaliseIp(ip: string | null): string | null {
  return typeof ip === 'string' && ip.length >= 1 && ip.length <= MAX_IP_CHARS ? ip.replaceAll('\u0000', '') || null : null;
}
