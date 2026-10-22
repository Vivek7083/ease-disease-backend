const MAX_NAME_CHARS = 100;
const MIN_EMAIL_CHARS = 3;
const MAX_EMAIL_CHARS = 254;

/**
 * A display name taken from a sign-in token: control and invisible-format characters removed, runs of whitespace
 * collapsed, trimmed, cut to 100 characters. Empty means "no name" (`undefined`). Unlike a name typed by the user it
 * has no minimum length: whatever Google holds is accepted.
 */
export function cleanTokenName(name: string | undefined): string | undefined {
  if (typeof name !== 'string') return undefined;
  const cleaned = name.replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, ' ').replace(/\s+/gu, ' ').trim();
  if (cleaned === '') return undefined;
  return Array.from(cleaned).slice(0, MAX_NAME_CHARS).join('').trim();
}

/**
 * The email as stored: trimmed and lower-cased. Only plain printable ASCII of a sane length is accepted, because the
 * database CHECK lower-cases with its own rules and PayU accepts nothing else; anything else returns `undefined`.
 */
export function normaliseTokenEmail(email: string | undefined): string | undefined {
  if (typeof email !== 'string') return undefined;
  const normalised = email.trim().toLowerCase();
  if (normalised.length < MIN_EMAIL_CHARS || normalised.length > MAX_EMAIL_CHARS) return undefined;
  if (!/^[\x21-\x7E]+$/.test(normalised)) return undefined;
  return normalised;
}
