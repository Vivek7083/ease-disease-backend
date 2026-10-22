import { CheckoutFieldError, validateEmail } from '../payments/payu/payu-checkout-fields.js';
import { normaliseWhatsappNumber } from './whatsapp-number.js';

export const NAME_MIN = 2;
export const NAME_MAX = 100;
export const CITY_MIN = 2;
export const CITY_MAX = 100;
export const GENDER_MAX = 50;
export const NOTES_MAX = 1000;
export const AGE_MIN = 1;
export const AGE_MAX = 119;

const ALLOWED_KEYS = ['packageId', 'name', 'whatsappNumber', 'email', 'age', 'city', 'gender', 'notes', 'consent'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Control characters (this includes NUL, which Postgres refuses outright). */
const CONTROL = /\p{Cc}/u;
/** Notes may span lines: tab, line feed and carriage return are fine there. */
const CONTROL_EXCEPT_LINE_BREAKS = /(?![\t\n\r])\p{Cc}/u;

/** The validated, normalised form. Field order here is the order that gets hashed for idempotency. */
export interface CreateBookingInput {
  packageId: string;
  name: string;
  whatsappNumber: string;
  email: string;
  age: number;
  city: string;
  gender: string | null;
  notes: string | null;
  consent: true;
}

export type CreateBookingParse = { ok: true; value: CreateBookingInput } | { ok: false; fields: Record<string, string> };

/** Characters (code points), the way Postgres `char_length` counts them. */
const length = (text: string): number => Array.from(text).length;
/** Trimmed and Unicode-normalised, so the same text typed two ways is one value. */
const clean = (text: string): string => text.normalize('NFC').trim();

/**
 * Checks the whole request body and reports EVERY problem at once as `field -> message` (the UI shows them together).
 * Pure: no database. Unknown fields are refused; every text field is trimmed; limits match api-flow.md section 4
 * and the database CHECKs (which are only the backstop).
 */
export function parseCreateBooking(body: unknown): CreateBookingParse {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, fields: { body: 'Send a JSON object' } };
  }
  const input = body as Record<string, unknown>;
  // No prototype: a caller-chosen key such as `__proto__` must become an ordinary entry, never reach Object.prototype.
  const fields: Record<string, string> = Object.create(null);

  for (const key of Object.keys(input)) {
    if (!(ALLOWED_KEYS as readonly string[]).includes(key)) fields[key.slice(0, 64)] = 'Unknown field';
  }

  const text = (field: string, label: string, min: number, max: number, lineBreaks = false): string => {
    const raw = input[field];
    if (typeof raw !== 'string') {
      fields[field] = `${label} is required`;
      return '';
    }
    const value = clean(raw);
    if ((lineBreaks ? CONTROL_EXCEPT_LINE_BREAKS : CONTROL).test(value)) fields[field] = `${label} contains characters that are not allowed`;
    else if (length(value) < min || length(value) > max) fields[field] = `${label} must be ${min} to ${max} characters`;
    return value;
  };

  const packageId = typeof input['packageId'] === 'string' ? input['packageId'].trim().toLowerCase() : '';
  if (!UUID.test(packageId)) fields['packageId'] = 'Choose a package';

  const name = text('name', 'Name', NAME_MIN, NAME_MAX);
  const city = text('city', 'City', CITY_MIN, CITY_MAX);

  let whatsappNumber = '';
  if (typeof input['whatsappNumber'] !== 'string') fields['whatsappNumber'] = 'WhatsApp number is required';
  else {
    const normalised = normaliseWhatsappNumber(input['whatsappNumber']);
    if (normalised === null) fields['whatsappNumber'] = 'Enter the WhatsApp number with its country code, for example +91 98765 43210';
    else whatsappNumber = normalised;
  }

  let email = '';
  if (typeof input['email'] !== 'string') fields['email'] = 'Email is required';
  else {
    try {
      // Lower-case first: the database stores it lower-case and PayU hashes exactly what we send.
      email = validateEmail(input['email'].normalize('NFC').trim().toLowerCase());
    } catch (error) {
      if (!(error instanceof CheckoutFieldError)) throw error;
      fields['email'] = error.message;
    }
  }

  const age = input['age'];
  if (typeof age !== 'number' || !Number.isInteger(age)) fields['age'] = 'Age must be a whole number';
  else if (age < AGE_MIN || age > AGE_MAX) fields['age'] = `Age must be ${AGE_MIN} to ${AGE_MAX}`;

  let gender: string | null = null;
  const rawGender = input['gender'];
  if (rawGender !== undefined && rawGender !== null) {
    if (typeof rawGender !== 'string') fields['gender'] = 'Gender must be text';
    else {
      const value = clean(rawGender);
      if (CONTROL.test(value)) fields['gender'] = 'Gender contains characters that are not allowed';
      else if (length(value) > GENDER_MAX) fields['gender'] = `Gender must be at most ${GENDER_MAX} characters`;
      else gender = value === '' ? null : value;
    }
  }

  let notes: string | null = null;
  const rawNotes = input['notes'];
  if (rawNotes !== undefined && rawNotes !== null) {
    if (typeof rawNotes !== 'string') fields['notes'] = 'Notes must be text';
    else {
      const value = text('notes', 'Notes', 0, NOTES_MAX, true);
      notes = value === '' ? null : value;
    }
  }

  if (input['consent'] !== true) fields['consent'] = 'You must agree to continue';

  if (Object.keys(fields).length > 0) return { ok: false, fields };
  return {
    ok: true,
    value: { packageId, name, whatsappNumber, email, age: age as number, city, gender, notes, consent: true },
  };
}
