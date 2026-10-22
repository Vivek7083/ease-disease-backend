/** E.164: `+`, then 8 to 15 digits, the first not 0. The same shape the database CHECK enforces. */
const E164 = /^\+[1-9][0-9]{7,14}$/;
/** Punctuation people type between the parts of a number. */
const SEPARATORS = /[\s\-.()]/g;

/**
 * The WhatsApp number as E.164, or `null` when it is not one. Any country; the country code is required, written after a
 * `+` (a number without it is refused rather than guessed). This is the ONLY place that decides the shape the form
 * accepts: to loosen it later (say, assume +91 for 10 digits), change this function and its tests, nothing else.
 */
export function normaliseWhatsappNumber(raw: string): string | null {
  const compact = raw.replace(SEPARATORS, '');
  return E164.test(compact) ? compact : null;
}
