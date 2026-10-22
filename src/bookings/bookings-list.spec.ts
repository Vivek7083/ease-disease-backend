import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMIT, MAX_LIMIT, decodeCursor, encodeCursor, parseListQuery } from './bookings-list.js';

const ID = '0b9f8c1e-3d2a-4b6c-9e5f-7a1d2c3b4e5f';
const WHEN = new Date('2026-10-22T10:00:00.123Z');
const fieldsOf = (query: unknown) => {
  const result = parseListQuery(query);
  if (result.ok) throw new Error('expected a failure');
  return result.fields;
};

describe('cursor', () => {
  it('round trips exactly, to the millisecond', () => {
    expect(decodeCursor(encodeCursor({ createdAt: WHEN, id: ID }))).toEqual({ createdAt: WHEN, id: ID });
  });

  it('is URL-safe text', () => {
    expect(encodeCursor({ createdAt: WHEN, id: ID })).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it.each([
    ['empty', ''],
    ['not base64', '!!!'],
    ['base64 of text that is not JSON', Buffer.from('hello').toString('base64url')],
    ['JSON array', Buffer.from('[]').toString('base64url')],
    ['JSON null', Buffer.from('null').toString('base64url')],
    ['missing id', Buffer.from(JSON.stringify({ t: WHEN.toISOString() })).toString('base64url')],
    ['bad id', Buffer.from(JSON.stringify({ t: WHEN.toISOString(), i: 'x' })).toString('base64url')],
    ['bad time', Buffer.from(JSON.stringify({ t: 'yesterday', i: ID })).toString('base64url')],
    ['time not in canonical form', Buffer.from(JSON.stringify({ t: '2026-10-22T10:00:00Z', i: ID })).toString('base64url')],
    ['extra field (not canonical)', Buffer.from(JSON.stringify({ t: WHEN.toISOString(), i: ID, x: 1 })).toString('base64url')],
    ['wrong key order (not canonical)', Buffer.from(JSON.stringify({ i: ID, t: WHEN.toISOString() })).toString('base64url')],
    ['too long', 'a'.repeat(201)],
    ['upper-case id (not canonical)', Buffer.from(JSON.stringify({ t: WHEN.toISOString(), i: ID.toUpperCase() })).toString('base64url')],
  ])('refuses a cursor that is %s', (_label, raw) => {
    expect(decodeCursor(raw)).toBeNull();
  });

  it('refuses a valid cursor with something appended', () => {
    expect(decodeCursor(`${encodeCursor({ createdAt: WHEN, id: ID })}A`)).toBeNull();
  });
});

describe('parseListQuery', () => {
  it('uses the defaults: active, 20, first page', () => {
    expect(parseListQuery({})).toEqual({ ok: true, value: { status: 'active', limit: DEFAULT_LIMIT, after: null } });
    expect(parseListQuery(undefined)).toEqual({ ok: true, value: { status: 'active', limit: 20, after: null } });
  });

  it.each(['active', 'past', 'all'] as const)('accepts status %s', (status) => {
    expect(parseListQuery({ status })).toMatchObject({ ok: true, value: { status } });
  });

  it.each([['ACTIVE'], [''], ['archived'], [['active']], [['active', 'past']], [{ a: 1 }], [1]])('refuses status %j', (status) => {
    expect(fieldsOf({ status })).toHaveProperty('status');
  });

  it.each([['1', 1], ['20', 20], ['50', 50], ['07', 7]])('accepts limit %j as %i', (limit, expected) => {
    expect(parseListQuery({ limit })).toMatchObject({ ok: true, value: { limit: expected } });
  });

  it.each([['0'], ['51'], ['-1'], ['1.5'], ['1e1'], ['abc'], [''], [' 5'], ['5 '], ['0x10'], ['1000'], [['5']], [5], [null]])('refuses limit %j', (limit) => {
    expect(fieldsOf({ limit })).toHaveProperty('limit');
  });

  it('has a maximum of 50', () => {
    expect(MAX_LIMIT).toBe(50);
  });

  it('accepts a good cursor and refuses a bad one', () => {
    const cursor = encodeCursor({ createdAt: WHEN, id: ID });
    expect(parseListQuery({ cursor })).toMatchObject({ ok: true, value: { after: { createdAt: WHEN, id: ID } } });
    expect(fieldsOf({ cursor: 'nonsense' })).toHaveProperty('cursor');
    expect(fieldsOf({ cursor: '' })).toHaveProperty('cursor');
    expect(fieldsOf({ cursor: [cursor] })).toHaveProperty('cursor');
  });

  it('reports every bad parameter at once and ignores unknown ones', () => {
    expect(Object.keys(fieldsOf({ status: 'x', limit: '0', cursor: 'y', _: '1' })).sort()).toEqual(['cursor', 'limit', 'status']);
    expect(parseListQuery({ _: '123', foo: 'bar' }).ok).toBe(true);
  });
});
