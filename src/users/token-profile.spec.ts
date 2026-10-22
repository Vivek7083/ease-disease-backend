import { describe, expect, it } from 'vitest';
import { cleanTokenName, normaliseTokenEmail } from './token-profile.js';

describe('cleanTokenName', () => {
  it.each([
    ['a normal name', 'Priya Sharma', 'Priya Sharma'],
    ['surrounding spaces', '  Priya Sharma  ', 'Priya Sharma'],
    ['runs of whitespace', 'Priya   \t Sharma', 'Priya Sharma'],
    ['a newline inside', 'Priya\nSharma', 'Priya Sharma'],
    ['control characters', 'Pri\u0000ya\u0007', 'Pri ya'],
    ['a zero-width space', 'Priya​Sharma', 'Priya Sharma'],
    ['a one-character name (no minimum for token names)', 'P', 'P'],
    ['non-latin letters', 'प्रिया शर्मा', 'प्रिया शर्मा'],
    ['an emoji', 'Priya 🌸', 'Priya 🌸'],
  ])('keeps %s', (_label, input, expected) => {
    expect(cleanTokenName(input)).toBe(expected);
  });

  it.each([['undefined', undefined], ['an empty string', ''], ['only spaces', '   '], ['only control characters', '\u0000\u0001​']])(
    'returns undefined for %s',
    (_label, input) => {
      expect(cleanTokenName(input)).toBeUndefined();
    },
  );

  it('keeps exactly 100 characters and cuts the 101st', () => {
    expect(cleanTokenName('a'.repeat(100))).toBe('a'.repeat(100));
    expect(cleanTokenName('a'.repeat(101))).toBe('a'.repeat(100));
  });

  it('counts an emoji as one character and never splits it', () => {
    const cut = cleanTokenName('🌸'.repeat(150));
    expect(Array.from(cut ?? '')).toHaveLength(100);
    expect(cut).toBe('🌸'.repeat(100));
  });

  it('does not end on a space after cutting', () => {
    expect(cleanTokenName(`${'a'.repeat(99)} b`)).toBe('a'.repeat(99));
  });

  it('is not a string at all: undefined', () => {
    expect(cleanTokenName(42 as never)).toBeUndefined();
  });
});

describe('normaliseTokenEmail', () => {
  it.each([
    ['already normal', 'priya@example.com', 'priya@example.com'],
    ['capitals', 'Priya.Sharma@Example.COM', 'priya.sharma@example.com'],
    ['surrounding spaces', '  priya@example.com ', 'priya@example.com'],
    ['a plus tag', 'Priya+Diet@example.com', 'priya+diet@example.com'],
    ['the shortest accepted length', 'a@b', 'a@b'],
  ])('accepts %s', (_label, input, expected) => {
    expect(normaliseTokenEmail(input)).toBe(expected);
  });

  it('accepts exactly 254 characters and refuses 255', () => {
    const of = (n: number) => `${'a'.repeat(n - '@example.com'.length)}@example.com`;
    expect(normaliseTokenEmail(of(254))).toHaveLength(254);
    expect(normaliseTokenEmail(of(255))).toBeUndefined();
  });

  it.each([
    ['undefined', undefined],
    ['empty', ''],
    ['only spaces', '   '],
    ['two characters', 'a@'],
    ['a space inside', 'pri ya@example.com'],
    ['a newline inside', 'priya@example.com\nbcc:x@y.z'],
    ['non-ASCII letters', 'priyä@example.com'],
    ['a Turkish dotted capital I (JS and Postgres lower-case it differently)', 'İpriya@example.com'],
    ['a zero-width space', 'priya​@example.com'],
  ])('refuses %s', (_label, input) => {
    expect(normaliseTokenEmail(input)).toBeUndefined();
  });

  it('is not a string at all: undefined', () => {
    expect(normaliseTokenEmail(42 as never)).toBeUndefined();
  });
});
