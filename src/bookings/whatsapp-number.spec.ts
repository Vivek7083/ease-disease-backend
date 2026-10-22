import { describe, expect, it } from 'vitest';
import { normaliseWhatsappNumber } from './whatsapp-number.js';

describe('normaliseWhatsappNumber', () => {
  it.each([
    ['+91 98765 43210', '+919876543210'],
    ['+919876543210', '+919876543210'],
    ['+1 (415) 555-2671', '+14155552671'],
    ['+44 7911.123.456', '+447911123456'],
    ['  +91-98765-43210  ', '+919876543210'],
    ['+12345678', '+12345678'], // 8 digits, the shortest
    ['+123456789012345', '+123456789012345'], // 15 digits, the longest
  ])('accepts %j as %j', (raw, expected) => {
    expect(normaliseWhatsappNumber(raw)).toBe(expected);
  });

  it.each([
    ['9876543210', 'no + and country code'],
    ['919876543210', 'no +'],
    ['00919876543210', '00 prefix instead of +'],
    ['+', 'plus alone'],
    ['', 'empty'],
    ['+0123456789', 'country code starts with 0'],
    ['+1234567', '7 digits'],
    ['+1234567890123456', '16 digits'],
    ['+91 98765 4321a', 'letter'],
    ['+91 98765 43210 ext 5', 'extension'],
    ['++919876543210', 'two pluses'],
    ['+91+9876543210', 'plus in the middle'],
  ])('refuses %j (%s)', (raw) => {
    expect(normaliseWhatsappNumber(raw)).toBeNull();
  });
});
