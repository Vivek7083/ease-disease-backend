import { Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { IDEMPOTENCY_KEY_LIFETIME_MS } from './idempotency.js';

export interface IdempotencyCleanupSummary {
  /** Key rows removed because they were older than the 24 hour window. */
  idempotencyKeysDeleted: number;
}

/**
 * The "cleanup" step of the scheduled tick: removes idempotency keys older than 24 hours. Purely housekeeping: an old key
 * is already treated as free by the next request that uses it (same cut-off, strictly older than 24 hours), so correctness
 * never depends on this running. Safe to run repeatedly and concurrently.
 */
@Injectable()
export class IdempotencyCleanupService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaClient) {}

  /** `now` is injectable so tests need no sleeping. */
  async run(options: { now?: Date } = {}): Promise<IdempotencyCleanupSummary> {
    const now = options.now ?? new Date();
    const { count } = await this.prisma.idempotencyKey.deleteMany({
      where: { createdAt: { lt: new Date(now.getTime() - IDEMPOTENCY_KEY_LIFETIME_MS) } },
    });
    return { idempotencyKeysDeleted: count };
  }
}
