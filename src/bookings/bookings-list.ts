/** `active` = still in play (payable, confirmed, or held for a human); `past` = every other status. */
export const ACTIVE_STATUSES = ['PENDING_PAYMENT', 'CONFIRMED', 'NEEDS_ATTENTION'] as const;
export type StatusFilter = 'active' | 'past' | 'all';
const STATUS_FILTERS: readonly StatusFilter[] = ['active', 'past', 'all'];

export const DEFAULT_STATUS_FILTER: StatusFilter = 'active';
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 50;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CURSOR_CHARS = /^[A-Za-z0-9_-]{1,200}$/;
const DIGITS = /^[0-9]{1,3}$/;

/** Where the previous page ended: the last row's creation time and id (the list is newest first, ties broken by id). */
export interface Cursor {
  createdAt: Date;
  id: string;
}

export interface ListQuery {
  status: StatusFilter;
  limit: number;
  after: Cursor | null;
}

export type ListQueryParse = { ok: true; value: ListQuery } | { ok: false; fields: Record<string, string> };

/** Opaque to the caller: base64url of the creation time (ISO, millisecond precision) and the id. */
export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify({ t: cursor.createdAt.toISOString(), i: cursor.id }), 'utf8').toString('base64url');
}

/** Strict: only what `encodeCursor` produces is accepted, so a hand-edited or padded cursor is refused, never guessed at. */
export function decodeCursor(raw: string): Cursor | null {
  if (!CURSOR_CHARS.test(raw)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const { t, i } = parsed as Record<string, unknown>;
  if (typeof t !== 'string' || typeof i !== 'string' || !UUID.test(i)) return null;
  const createdAt = new Date(t);
  if (Number.isNaN(createdAt.getTime()) || createdAt.toISOString() !== t) return null;
  const cursor = { createdAt, id: i };
  return encodeCursor(cursor) === raw ? cursor : null;
}

/**
 * The query string of `GET /v1/bookings`. Reports every bad parameter at once; unknown parameters are ignored (a GET may
 * carry cache-busters). Express gives a repeated parameter as an array, which is refused like any other wrong shape.
 */
export function parseListQuery(query: unknown): ListQueryParse {
  const input = (typeof query === 'object' && query !== null ? query : {}) as Record<string, unknown>;
  const fields: Record<string, string> = {};

  let status = DEFAULT_STATUS_FILTER;
  if (input['status'] !== undefined) {
    if (typeof input['status'] === 'string' && (STATUS_FILTERS as readonly string[]).includes(input['status'])) status = input['status'] as StatusFilter;
    else fields['status'] = 'status must be active, past or all';
  }

  let limit = DEFAULT_LIMIT;
  if (input['limit'] !== undefined) {
    const raw = input['limit'];
    const value = typeof raw === 'string' && DIGITS.test(raw) ? Number(raw) : Number.NaN;
    if (Number.isInteger(value) && value >= 1 && value <= MAX_LIMIT) limit = value;
    else fields['limit'] = `limit must be a whole number from 1 to ${MAX_LIMIT}`;
  }

  let after: Cursor | null = null;
  if (input['cursor'] !== undefined) {
    after = typeof input['cursor'] === 'string' ? decodeCursor(input['cursor']) : null;
    if (after === null) fields['cursor'] = 'cursor is not valid; use the nextCursor of a previous answer';
  }

  if (Object.keys(fields).length > 0) return { ok: false, fields };
  return { ok: true, value: { status, limit, after } };
}
