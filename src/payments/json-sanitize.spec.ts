import { describe, expect, it } from 'vitest';
import { sanitizeForJsonb } from './json-sanitize.js';

describe('sanitizeForJsonb', () => {
  it('keeps ordinary JSON exactly as received', () => {
    const value = { a: 'x', b: 1.5, c: [1, 'two', null, { d: true }], e: null, f: '' };
    expect(sanitizeForJsonb(value)).toEqual(value);
  });

  it('turns NUL characters into visible text, in strings and keys, at any depth', () => {
    const out = sanitizeForJsonb({ 'k\u0000ey': ['a\u0000b', { n: 'c\u0000' }] });
    expect(out).toEqual({ 'k\\u0000ey': ['a\\u0000b', { n: 'c\\u0000' }] });
  });

  it('wraps a top-level null so it can be stored in a NOT NULL jsonb column', () => {
    expect(sanitizeForJsonb(null)).toEqual({ _null: true });
  });

  it('handles top-level primitives and undefined', () => {
    expect(sanitizeForJsonb('s')).toBe('s');
    expect(sanitizeForJsonb(5)).toBe(5);
    expect(sanitizeForJsonb(false)).toBe(false);
    expect(sanitizeForJsonb(undefined)).toEqual({ _unsupported: 'undefined' });
    expect(sanitizeForJsonb(() => 1)).toEqual({ _unsupported: 'function' });
  });

  it('converts values JSON cannot hold instead of throwing', () => {
    expect(sanitizeForJsonb({ n: Number.NaN, i: Number.POSITIVE_INFINITY, b: 10n })).toEqual({
      n: 'NaN',
      i: 'Infinity',
      b: '10',
    });
  });

  it('drops undefined / function / symbol properties and nulls array holes', () => {
    expect(sanitizeForJsonb({ keep: 1, u: undefined, f: () => 1, s: Symbol('x') })).toEqual({ keep: 1 });
    expect(sanitizeForJsonb([1, undefined, () => 1])).toEqual([1, null, null]);
  });

  it('cuts nesting beyond 20 levels instead of recursing forever', () => {
    let deep: unknown = 'bottom';
    for (let i = 0; i < 100; i++) deep = { next: deep };
    let node = sanitizeForJsonb(deep) as Record<string, unknown>;
    let levels = 0;
    while (typeof node === 'object' && node !== null) {
      node = node['next'] as Record<string, unknown>;
      levels++;
    }
    expect(levels).toBeLessThanOrEqual(21);
    expect(node).toBe('[depth limit]');
  });

  it('does not mutate its input', () => {
    const input = { a: 'x\u0000y', list: [1] };
    sanitizeForJsonb(input);
    expect(input).toEqual({ a: 'x\u0000y', list: [1] });
  });

  it('keeps hostile-looking text as plain strings', () => {
    expect(sanitizeForJsonb({ a: "'; DROP TABLE users;--" })).toEqual({ a: "'; DROP TABLE users;--" });
  });
});
