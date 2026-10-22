import { Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { DevelopmentOnlyGuard } from '../common/guards/development-only.guard.js';
import { IdempotencyCleanupService, type IdempotencyCleanupSummary } from '../common/idempotency/idempotency-cleanup.service.js';
import { ReconcileService, type ReconcileSummary } from '../payments/reconcile.service.js';
import { TickAuthGuard } from './tick-auth.guard.js';

export interface TickResponse {
  reconcile: ReconcileSummary;
  cleanup: IdempotencyCleanupSummary;
}

/** The housekeeping steps in order. Reconcile first: it is the one that matters if a later step fails. */
async function runTick(reconcile: ReconcileService, cleanup: IdempotencyCleanupService): Promise<TickResponse> {
  return { reconcile: await reconcile.run(), cleanup: await cleanup.run() };
}

/**
 * Called by Cloud Scheduler every 5 minutes. Authenticated by a Google-signed OIDC token for the scheduler's service
 * account only (TickAuthGuard), never by a user token. Today it reconciles payments PayU never reported on and
 * deletes idempotency keys older than 24 hours; the outbox sender (S5) joins it when its slice exists.
 * A run that could not reach PayU still answers 200 (the tick itself worked; the next one retries); an unexpected
 * failure is a 500, which the scheduler will report.
 */
@ApiTags('internal')
@Controller('v1/internal')
export class TickController {
  constructor(
    private readonly reconcile: ReconcileService,
    private readonly cleanup: IdempotencyCleanupService,
  ) {}

  @Post('tick')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TickAuthGuard)
  @ApiOperation({
    summary: 'Scheduled housekeeping (Cloud Scheduler only)',
    description: 'Requires a Google-signed OIDC ID token for the scheduler service account. Responds 401 to everyone else.',
  })
  async tick(): Promise<TickResponse> {
    return runTick(this.reconcile, this.cleanup);
  }
}

/**
 * Development-only: runs the same housekeeping by hand (no token), so the reconcile sweep can be tried against PayU's
 * test mode. 404 outside NODE_ENV=development. Needs PayU test credentials loaded, otherwise the summary says it stopped.
 */
@ApiTags('dev (development only)')
@Controller('dev')
@UseGuards(DevelopmentOnlyGuard)
export class TickDevController {
  constructor(
    private readonly reconcile: ReconcileService,
    private readonly cleanup: IdempotencyCleanupService,
  ) {}

  @Post('tick')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Run the scheduled housekeeping once, now (no token needed in development)' })
  async tick(): Promise<TickResponse> {
    return runTick(this.reconcile, this.cleanup);
  }
}
