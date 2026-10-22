import { createHash } from 'node:crypto';
import { HttpStatus } from '@nestjs/common';
import { AppException } from '../exceptions/app.exception.js';
import { Prisma } from '../../generated/prisma/client.js';

/** api-flow.md section 3: a uuid v4. Matched case-insensitively and stored lower-case. */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const IDEMPOTENCY_HEADER = 'Idempotency-Key';
/** Added to an answer that is the stored reply to an earlier identical request. */
export const REPLAYED_HEADER = 'Idempotent-Replayed';

/** The header value as a lower-case uuid, or `400 VALIDATION_FAILED` naming the header. */
export function parseIdempotencyKey(header: string | string[] | undefined): string {
  const value = typeof header === 'string' ? header.trim() : '';
  if (!UUID_V4.test(value)) {
    throw new AppException('VALIDATION_FAILED', 'Invalid request', HttpStatus.BAD_REQUEST, {
      fields: { [IDEMPOTENCY_HEADER]: 'Send a unique uuid v4 in the Idempotency-Key header' },
    });
  }
  return value.toLowerCase();
}

/** sha-256 (hex) of a request already normalised into a fixed field order, so equivalent requests hash alike. */
export function hashRequest(normalised: unknown): string {
  return createHash('sha256').update(JSON.stringify(normalised)).digest('hex');
}

export interface IdempotencyScope {
  key: string;
  userId: string;
  endpoint: string;
}

export type ClaimResult = { kind: 'claimed' } | { kind: 'replay'; response: unknown };

/**
 * "The same key from the same user within 24 h returns the original response." Must run inside the transaction that does the protected work. Inserts the key row, or takes over a row older than 24 h.
 * When a live row exists it is either from a finished request (same body: replay its answer; different body: conflict)
 * or from a request still in flight, in which case the insert waits for that transaction to finish first.
 */
export async function claimKey(tx: Prisma.TransactionClient, scope: IdempotencyScope, requestHash: string): Promise<ClaimResult> {
  const claimed = await tx.$queryRaw<{ key: string }[]>`
    INSERT INTO idempotency_keys (key, user_id, endpoint, request_hash)
    VALUES (${scope.key}::uuid, ${scope.userId}::uuid, ${scope.endpoint}, ${requestHash})
    ON CONFLICT (key, user_id, endpoint) DO UPDATE
      SET request_hash = EXCLUDED.request_hash, response = NULL, created_at = now()
      WHERE idempotency_keys.created_at < now() - interval '24 hours'
    RETURNING key`;
  if (claimed.length > 0) return { kind: 'claimed' };

  const existing = await tx.idempotencyKey.findUnique({
    where: { key_userId_endpoint: scope },
    select: { requestHash: true, response: true },
  });
  // The row was committed (we only get here after its writer finished), so it normally has its answer. A row without
  // one cannot be replayed honestly: refuse rather than guess.
  if (!existing || existing.response === null) {
    throw new AppException('IDEMPOTENCY_CONFLICT', 'This Idempotency-Key cannot be reused', HttpStatus.CONFLICT);
  }
  if (existing.requestHash !== requestHash) {
    throw new AppException('IDEMPOTENCY_CONFLICT', 'This Idempotency-Key was already used with a different request', HttpStatus.CONFLICT);
  }
  return { kind: 'replay', response: existing.response };
}

/** Stores the answer on the claimed row; call it as the last step before the transaction commits. */
export async function saveResponse(tx: Prisma.TransactionClient, scope: IdempotencyScope, response: unknown): Promise<void> {
  await tx.idempotencyKey.update({
    where: { key_userId_endpoint: scope },
    data: { response: response as Prisma.InputJsonValue },
  });
}
