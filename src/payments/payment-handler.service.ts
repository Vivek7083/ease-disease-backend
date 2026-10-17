import { Inject, Injectable, Logger } from '@nestjs/common';
import type { BookingStatus, Prisma, PrismaClient } from '../generated/prisma/client.js';
import { AppException } from '../common/exceptions/app.exception.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { minimiseEventPayload } from './payment-event-payload.js';
import { PayuClient, PayuGatewayError, type PayuVerifyResult } from './payu/payu-client.js';
import { PayuCredentialsProvider } from './payu/payu-credentials.provider.js';
import { parseAmountToPaise, verifyResponseHash } from './payu/payu-hash.js';

export type PaymentSource = 'RETURN' | 'WEBHOOK' | 'RECONCILE';

export type HandleOutcome =
  /** Payload had no usable txnid, or the txnid matches no transaction of ours. Nothing changed. */
  | 'unknown_transaction'
  /** The reverse hash did not verify. Nothing changed, PayU was not called. */
  | 'hash_invalid'
  /** We could not get a trustworthy answer (credentials missing, or PayU unreachable / malformed). Nothing changed. */
  | 'gateway_error'
  /** Hash is valid but the payload's booking reference disagrees with ours. Nothing changed, PayU was not called. */
  | 'ignored'
  /** PayU does not know the transaction, or answered with a status we do not recognise. Nothing changed. */
  | 'not_found_at_payu'
  /** PayU says success and this call moved the booking to CONFIRMED (or the paid-on-a-closed-booking alert). */
  | 'applied'
  /** PayU says failure / cancelled and this call recorded it (transaction + booking FAILED). */
  | 'failed_payment'
  /** PayU says pending. Booking untouched. */
  | 'pending'
  /** PayU says success but the amount differs from ours: escalated to NEEDS_ATTENTION. */
  | 'mismatch'
  /** An earlier call already recorded this. The guarded updates matched nothing, nothing was written. */
  | 'duplicate';

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
const MAX_IP_CHARS = 45;

/** Booking states a successful payment may move to CONFIRMED. Anything else that is not already settled needs a human. */
const CONFIRMABLE: BookingStatus[] = ['PENDING_PAYMENT', 'FAILED', 'EXPIRED'];
/** Booking states where a mismatch escalation is pointless (already settled or already flagged). */
const NOT_ESCALATABLE: BookingStatus[] = ['NEEDS_ATTENTION', 'CONFIRMED', 'COMPLETED'];

const AMOUNT_MISMATCH = 'AMOUNT_MISMATCH';

interface KnownTransaction {
  id: string;
  orderId: string;
  status: string;
  amountPaise: number;
  booking: { id: string; reference: string; status: BookingStatus; packageTitle: string; amountPaise: number };
}

interface Verified {
  txnid: string;
  transaction: KnownTransaction;
  paid: Extract<PayuVerifyResult, { outcome: 'found' }>;
}

/**
 * Single entry point for every PayU signal (browser return, webhook, reconcile). Idempotent and
 * safe to call concurrently: every state change is a guarded UPDATE inside one database transaction,
 * so a replay or a racing duplicate matches zero rows and writes nothing.
 * All database access uses Prisma's parameterised API.
 */
@Injectable()
export class PaymentHandlerService {
  private readonly logger = new Logger(PaymentHandlerService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaClient,
    private readonly credentials: PayuCredentialsProvider,
    @Inject(PayuClient) private readonly payu: Pick<PayuClient, 'verifyPayment'>,
  ) {}

  async handle(input: HandleInput): Promise<HandleResult> {
    const payload = isPlainObject(input.payload) ? input.payload : undefined;
    const txnid = payload && typeof payload['txnid'] === 'string' && TXNID_PATTERN.test(payload['txnid']) ? payload['txnid'] : null;

    // Read-only lookup, so the event can reference its transaction. Nothing is written before the event.
    const transaction: KnownTransaction | null = txnid
      ? await this.prisma.transaction.findUnique({
          where: { orderId: txnid },
          select: {
            id: true,
            orderId: true,
            status: true,
            amountPaise: true,
            booking: { select: { id: true, reference: true, status: true, packageTitle: true, amountPaise: true } },
          },
        })
      : null;

    // Pure computation, no I/O.
    const hashCheck = this.checkHash(payload);

    const event = await this.prisma.paymentEvent.create({
      data: {
        transactionId: transaction?.id ?? null,
        source: input.source,
        hashValid: hashCheck.valid,
        // The hash above was checked on the full payload; only the allowlisted fields are kept (see payment-event-payload.ts).
        payload: minimiseEventPayload(input.payload),
        sourceIp: normaliseIp(input.sourceIp),
      },
      select: { id: true },
    });

    const bookingReference = transaction?.booking.reference ?? null;
    const finish = async (
      outcome: HandleOutcome,
      extra: { checks?: Record<string, boolean>; payuVerify?: Prisma.InputJsonValue } = {},
    ): Promise<HandleResult> => {
      await this.prisma.paymentEvent.update({
        where: { id: event.id },
        data: {
          verification: {
            hash: { valid: hashCheck.valid, variant: hashCheck.variant, ...(hashCheck.reason ? { reason: hashCheck.reason } : {}) },
            payuVerify: extra.payuVerify ?? null,
            checks: extra.checks ?? {},
            result: outcome,
            handledAt: new Date().toISOString(),
          },
        },
      });
      return { outcome, bookingReference };
    };

    if (!txnid || !transaction || !payload) {
      return finish('unknown_transaction');
    }
    if (hashCheck.reason === 'not_configured') {
      this.logger.error(`PayU credentials are not configured; cannot verify a payment signal for ${txnid}`);
      return finish('gateway_error');
    }
    if (!hashCheck.valid) {
      this.logger.warn(`Payment signal with an invalid hash for ${txnid} (${input.source})`);
      return finish('hash_invalid');
    }
    if (payload['udf1'] !== transaction.booking.reference) {
      this.logger.warn(`Payment signal for ${txnid} carries a different booking reference than ours (${input.source})`);
      return finish('ignored', { checks: { referenceMatches: false } });
    }

    // From here the hash is valid and the transaction is ours. PayU's own answer, not the payload, decides.
    const answer = await this.askPayu(txnid);
    if (!answer.ok) {
      this.logger.error(`verify_payment failed for ${txnid} (${input.source}): ${answer.error}`);
      return finish('gateway_error', { checks: { referenceMatches: true }, payuVerify: { outcome: 'error', error: answer.error } });
    }
    const paid = answer.result;
    if (paid.outcome === 'not_found') {
      this.logger.warn(`PayU does not know ${txnid} although a validly signed signal arrived (${input.source})`);
      return finish('not_found_at_payu', { checks: { referenceMatches: true }, payuVerify: { outcome: 'not_found' } });
    }

    const payloadPaise = parseAmountToPaise(String(payload['amount']));
    const amountMatches = paid.amountPaise === transaction.amountPaise && payloadPaise === transaction.amountPaise;
    const checks = { referenceMatches: true, amountMatches };
    const payuVerify: Prisma.InputJsonValue = {
      outcome: 'found',
      status: paid.status,
      rawStatus: paid.rawStatus,
      unmappedStatus: paid.unmappedStatus,
      amountPaise: paid.amountPaise,
      mihpayid: paid.mihpayid,
    };

    if (paid.status === 'unknown') {
      this.logger.warn(`PayU reported an unrecognised status "${paid.rawStatus}" for ${txnid}; changing nothing`);
      return finish('not_found_at_payu', { checks, payuVerify });
    }

    const verified: Verified = { txnid, transaction, paid };
    let outcome: HandleOutcome;
    if (paid.status === 'success') {
      outcome = amountMatches ? await this.applySuccess(verified) : await this.applyMismatch(verified);
    } else if (paid.status === 'pending') {
      outcome = await this.applyPending(verified);
    } else {
      outcome = await this.applyFailure(verified);
    }
    return finish(outcome, { checks, payuVerify });
  }

  /** PayU says success and the amount matches: transaction SUCCESS, booking CONFIRMED, alerts queued. */
  private applySuccess({ transaction, paid }: Verified): Promise<HandleOutcome> {
    return this.prisma.$transaction(async (tx) => {
      const now = new Date();
      // Success wins from any state except SUCCESS itself: money moved, PayU's truth is final.
      const moved = await tx.transaction.updateMany({
        where: { id: transaction.id, status: { not: 'SUCCESS' } },
        data: {
          status: 'SUCCESS',
          paymentMode: paid.mode,
          pgTxnId: paid.mihpayid,
          bankRefNum: paid.bankRefNum,
          errorCode: null,
          errorMessage: null,
          completedAt: now,
          updatedAt: now,
        },
      });
      if (moved.count === 0) return 'duplicate';

      const confirmed = await tx.booking.updateMany({
        where: { id: transaction.booking.id, status: { in: CONFIRMABLE } },
        data: { status: 'CONFIRMED', holdExpiresAt: null, updatedAt: now },
      });
      if (confirmed.count === 1) {
        const base = bookingFacts(transaction.booking);
        await tx.outbox.createMany({
          data: [
            { type: 'EXPERT_ALERT', payload: base },
            { type: 'BOOKING_CONFIRMATION', payload: base },
          ],
        });
        return 'applied';
      }

      // Not confirmable: already CONFIRMED / flagged (nothing more to do) or closed (CANCELLED etc.): a human decides.
      const current = await tx.booking.findUniqueOrThrow({ where: { id: transaction.booking.id }, select: { status: true } });
      if (NOT_ESCALATABLE.includes(current.status)) return 'applied';
      const flagged = await tx.booking.updateMany({
        where: { id: transaction.booking.id, status: { notIn: NOT_ESCALATABLE } },
        data: { status: 'NEEDS_ATTENTION', updatedAt: now },
      });
      if (flagged.count === 1) {
        await tx.outbox.createMany({
          data: [
            {
              type: 'ADMIN_ALERT',
              payload: { ...bookingFacts(transaction.booking), reason: 'PAID_ON_CLOSED_BOOKING', bookingStatus: current.status },
            },
          ],
        });
      }
      return 'applied';
    });
  }

  /** PayU says success but for a different amount than we charged: keep the evidence, flag it for a human. */
  private applyMismatch({ transaction, paid }: Verified): Promise<HandleOutcome> {
    return this.prisma.$transaction(async (tx) => {
      const now = new Date();
      await tx.transaction.updateMany({
        where: {
          id: transaction.id,
          status: { not: 'SUCCESS' },
          NOT: { status: 'FAILURE', errorCode: AMOUNT_MISMATCH },
        },
        data: {
          status: 'FAILURE',
          paymentMode: paid.mode,
          pgTxnId: paid.mihpayid, // kept so a refund can be made
          bankRefNum: paid.bankRefNum,
          errorCode: AMOUNT_MISMATCH,
          errorMessage: `PayU reported ${paid.amountPaise} paise, expected ${transaction.amountPaise}`,
          completedAt: now,
          updatedAt: now,
        },
      });
      // The booking guard is what makes a replay a no-op: once flagged it no longer matches.
      const flagged = await tx.booking.updateMany({
        where: { id: transaction.booking.id, status: { notIn: NOT_ESCALATABLE } },
        data: { status: 'NEEDS_ATTENTION', updatedAt: now },
      });
      if (flagged.count === 0) return 'duplicate';
      await tx.outbox.createMany({
        data: [
          {
            type: 'ADMIN_ALERT',
            payload: {
              ...bookingFacts(transaction.booking),
              reason: AMOUNT_MISMATCH,
              expectedPaise: transaction.amountPaise,
              paidPaise: paid.amountPaise,
            },
          },
        ],
      });
      return 'mismatch';
    });
  }

  /** PayU says failure or cancelled: transaction FAILURE / CANCELLED, booking FAILED. Never touches a settled payment. */
  private applyFailure({ transaction, paid }: Verified): Promise<HandleOutcome> {
    return this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const moved = await tx.transaction.updateMany({
        where: { id: transaction.id, status: { in: ['CREATED', 'INITIATED', 'PENDING'] } },
        data: {
          status: paid.status === 'cancelled' ? 'CANCELLED' : 'FAILURE',
          paymentMode: paid.mode,
          pgTxnId: paid.mihpayid,
          bankRefNum: paid.bankRefNum,
          errorCode: paid.errorCode,
          errorMessage: paid.errorMessage,
          completedAt: now,
          updatedAt: now,
        },
      });
      if (moved.count === 0) return 'duplicate';
      await tx.booking.updateMany({
        where: { id: transaction.booking.id, status: 'PENDING_PAYMENT' },
        data: { status: 'FAILED', updatedAt: now },
      });
      return 'failed_payment';
    });
  }

  /** PayU says pending: only the transaction notes it. The booking never changes on pending. */
  private async applyPending({ transaction }: Verified): Promise<HandleOutcome> {
    await this.prisma.transaction.updateMany({
      where: { id: transaction.id, status: { in: ['CREATED', 'INITIATED'] } },
      data: { status: 'PENDING', updatedAt: new Date() },
    });
    return 'pending';
  }

  private async askPayu(txnid: string): Promise<{ ok: true; result: PayuVerifyResult } | { ok: false; error: string }> {
    try {
      return { ok: true, result: await this.payu.verifyPayment(txnid) };
    } catch (error) {
      // Only "PayU could not give a trustworthy answer" is expected here; anything else is a bug and must surface.
      if (error instanceof PayuGatewayError || error instanceof AppException) {
        return { ok: false, error: error.message };
      }
      throw error;
    }
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

/** Ids and display basics only: never contact details and never the patient's notes. The sender loads what it needs. */
function bookingFacts(booking: KnownTransaction['booking']) {
  return {
    bookingId: booking.id,
    reference: booking.reference,
    packageTitle: booking.packageTitle,
    amountPaise: booking.amountPaise,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normaliseIp(ip: string | null): string | null {
  return typeof ip === 'string' && ip.length >= 1 && ip.length <= MAX_IP_CHARS ? ip.replaceAll('\u0000', '') || null : null;
}
