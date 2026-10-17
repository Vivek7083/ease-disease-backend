import { Inject, Injectable, Logger } from '@nestjs/common';
import type { PrismaClient } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PaymentHandlerService, type HandleOutcome } from './payment-handler.service.js';

/** A payment is only chased once the customer has had time to finish (or abandon) it. */
export const RECONCILE_MIN_AGE_MS = 20 * 60_000;
/** ...and only for a day. After that the row is left alone: a late webhook can still settle it, nothing is guessed or expired. */
export const RECONCILE_MAX_AGE_MS = 24 * 60 * 60_000;
export const RECONCILE_DEFAULT_BATCH_SIZE = 50;
export const RECONCILE_MAX_BATCH_SIZE = 500;

export interface ReconcileSummary {
  /** Transactions for which PayU gave an answer that was processed. */
  checked: number;
  applied: number;
  failed: number;
  pending: number;
  mismatch: number;
  /** PayU answered but the row had already been settled by another signal. */
  duplicate: number;
  /** PayU does not know the transaction, or answered with a status we do not recognise: nothing changed. */
  notFound: number;
  /** A transaction failed unexpectedly (bug or database error); the others still ran. */
  errors: number;
  /** PayU could not give a trustworthy answer, so the rest of the batch was left for the next run. */
  stoppedOnGatewayError: boolean;
}

/**
 * Chases payments that never reported back (closed tab, lost webhook). Policy (owner decision, 2026-10-17):
 *  - only transactions still INITIATED or PENDING, created 20 minutes to 24 hours ago, are asked about;
 *  - PayU's answer alone changes anything (through `PaymentHandlerService.reconcile`): failed -> transaction and
 *    booking FAILED, success -> confirmed;
 *  - nothing is ever expired or failed from our side, and a row older than 24 hours is simply not asked about again.
 * Safe to run concurrently and repeatedly: every change is a guarded update inside the handler.
 */
@Injectable()
export class ReconcileService {
  private readonly logger = new Logger(ReconcileService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaClient,
    private readonly handler: PaymentHandlerService,
  ) {}

  /** `now` is injectable so tests need no sleeping. */
  async run(options: { now?: Date; batchSize?: number } = {}): Promise<ReconcileSummary> {
    const now = options.now ?? new Date();
    const batchSize = options.batchSize ?? RECONCILE_DEFAULT_BATCH_SIZE;
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > RECONCILE_MAX_BATCH_SIZE) {
      throw new RangeError(`batchSize must be an integer from 1 to ${RECONCILE_MAX_BATCH_SIZE}`);
    }

    // Least recently checked first, so a long-lived PENDING row cannot starve the others (each check touches updated_at).
    const candidates = await this.prisma.transaction.findMany({
      where: {
        status: { in: ['INITIATED', 'PENDING'] },
        createdAt: { lte: new Date(now.getTime() - RECONCILE_MIN_AGE_MS), gt: new Date(now.getTime() - RECONCILE_MAX_AGE_MS) },
      },
      orderBy: [{ updatedAt: 'asc' }, { createdAt: 'asc' }],
      take: batchSize,
      select: { id: true, orderId: true },
    });

    const summary: ReconcileSummary = {
      checked: 0,
      applied: 0,
      failed: 0,
      pending: 0,
      mismatch: 0,
      duplicate: 0,
      notFound: 0,
      errors: 0,
      stoppedOnGatewayError: false,
    };

    for (const candidate of candidates) {
      let outcome: HandleOutcome;
      try {
        outcome = (await this.handler.reconcile(candidate.orderId)).outcome;
      } catch (error) {
        summary.errors++;
        this.logger.error(`Reconcile failed unexpectedly for ${candidate.orderId}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }

      if (outcome === 'gateway_error') {
        // PayU is unreachable, rate limiting us, or credentials are missing: stop hammering it, retry next run.
        summary.stoppedOnGatewayError = true;
        break;
      }

      summary.checked++;
      if (outcome === 'applied') summary.applied++;
      else if (outcome === 'failed_payment') summary.failed++;
      else if (outcome === 'pending') summary.pending++;
      else if (outcome === 'mismatch') summary.mismatch++;
      else if (outcome === 'duplicate') summary.duplicate++;
      else summary.notFound++;

      await this.touch(candidate.id);
    }

    if (summary.checked > 0 || summary.errors > 0 || summary.stoppedOnGatewayError) {
      this.logger.log(`Reconcile run: ${JSON.stringify(summary)}`);
    }
    return summary;
  }

  /** Marks the row as just checked (moves it to the back of the queue). Only rows still open are touched. */
  private async touch(transactionId: string): Promise<void> {
    await this.prisma.transaction.updateMany({
      where: { id: transactionId, status: { in: ['INITIATED', 'PENDING'] } },
      data: { updatedAt: new Date() },
    });
  }
}
