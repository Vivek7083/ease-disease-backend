import type { Prisma } from '../generated/prisma/client.js';

const MAX_DEPTH = 20;
const NUL = '\u0000';
/** Postgres `jsonb` rejects the NUL character in strings and keys. We keep it visible as literal text instead. */
const NUL_TEXT = '\\u0000';

const cleanString = (value: string): string => (value.includes(NUL) ? value.replaceAll(NUL, NUL_TEXT) : value);

/**
 * Makes an arbitrary received value safe to store in a `jsonb` column, without throwing.
 * Payloads come from the internet, so this never trusts their shape:
 *  - NUL characters (invalid in jsonb) become the literal text `\u0000`, in both strings and keys;
 *  - non-finite numbers become strings, functions / symbols / undefined are dropped, bigint becomes a string;
 *  - nesting deeper than 20 levels is replaced by a marker.
 * Everything else is kept exactly as received. This is about storing evidence faithfully, not about
 * SQL safety: values are always sent to the database as bound parameters.
 */
export function sanitizeForJsonb(value: unknown, depth = 0): Prisma.InputJsonValue {
  if (value === null) return { _null: true };
  return sanitizeInner(value, depth) ?? { _unsupported: typeof value };
}

function sanitizeInner(value: unknown, depth: number): Prisma.InputJsonValue | null | undefined {
  if (value === null) return null;
  switch (typeof value) {
    case 'string':
      return cleanString(value);
    case 'boolean':
      return value;
    case 'number':
      return Number.isFinite(value) ? value : String(value);
    case 'bigint':
      return value.toString();
    case 'object': {
      if (depth >= MAX_DEPTH) return '[depth limit]';
      if (Array.isArray(value)) {
        return value.map((item) => sanitizeInner(item, depth + 1) ?? null);
      }
      const result: Record<string, Prisma.InputJsonValue | null> = {};
      for (const [key, item] of Object.entries(value)) {
        const cleaned = sanitizeInner(item, depth + 1);
        if (cleaned !== undefined) result[cleanString(key)] = cleaned;
      }
      return result;
    }
    default:
      return undefined; // undefined, function, symbol
  }
}
