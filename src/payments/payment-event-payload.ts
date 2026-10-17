import type { Prisma } from '../generated/prisma/client.js';
import { cleanJsonbString } from './json-sanitize.js';

/**
 * The only PayU fields whose values are kept in `payment_events`. The table is immutable (database trigger),
 * so anything stored there can never be erased: contact details, address and card fields are therefore never
 * stored. Matching is exact and case-sensitive, so an unexpected spelling of a personal field is dropped too.
 * `hash` is kept (a salted digest, useful to compare a bad signature); the salt is never in a payload.
 */
export const EVENT_PAYLOAD_ALLOWLIST: readonly string[] = [
  'txnid',
  'mihpayid',
  'status',
  'unmappedstatus',
  'amount',
  'net_amount_debit',
  'additional_charges',
  'mode',
  'bank_ref_num',
  'bankcode',
  'PG_TYPE',
  'error',
  'error_Message',
  'udf1',
  'addedon',
  'hash',
];

const MAX_VALUE_CHARS = 500;
const MAX_FIELD_NAMES = 100;
const MAX_FIELD_NAME_CHARS = 100;

/**
 * What to store for a received signal: allowlisted scalar values, plus the NAMES of every field that arrived
 * (never their values), so a rejected or odd signal can still be investigated. Never throws, never mutates `raw`.
 * Run the hash check on the full payload BEFORE calling this: trimming would break the signature.
 */
export function minimiseEventPayload(raw: unknown): Prisma.InputJsonObject {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { _nonObject: raw === null ? 'null' : Array.isArray(raw) ? 'array' : typeof raw, _receivedFields: [] };
  }

  const kept: Record<string, string | number | boolean> = {};
  for (const field of EVENT_PAYLOAD_ALLOWLIST) {
    if (!Object.hasOwn(raw, field)) continue;
    const value: unknown = (raw as Record<string, unknown>)[field];
    if (typeof value === 'string') kept[field] = cleanJsonbString(value).slice(0, MAX_VALUE_CHARS);
    else if (typeof value === 'boolean') kept[field] = value;
    else if (typeof value === 'number') kept[field] = Number.isFinite(value) ? value : String(value);
    // objects, arrays and anything else are dropped: PayU sends flat form fields
  }

  const names = Object.keys(raw);
  return {
    ...kept,
    _receivedFields: names.slice(0, MAX_FIELD_NAMES).map((name) => cleanJsonbString(name).slice(0, MAX_FIELD_NAME_CHARS)),
    ...(names.length > MAX_FIELD_NAMES ? { _receivedFieldCount: names.length } : {}),
  };
}
