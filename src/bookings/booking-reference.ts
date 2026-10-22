import { randomBytes } from 'node:crypto';

/** Crockford-style: no I, L, O or U, so a reference read aloud or copied by hand is hard to get wrong. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export const REFERENCE_ATTEMPTS = 5;

export const randomChars = (count: number): string => Array.from(randomBytes(count), (byte) => ALPHABET[byte % 32]).join('');

/** `ED-` plus 6 characters (about a billion values); the caller retries on the rare collision. */
export const generateBookingReference = (): string => `ED-${randomChars(6)}`;
