import { describe, expect, it } from 'vitest';
import { parseCreateBooking, type CreateBookingInput } from './create-booking.js';

const PACKAGE_ID = '00000000-0000-4000-8000-000000000001';
const valid = (): Record<string, unknown> => ({
  packageId: PACKAGE_ID,
  name: 'Priya Sharma',
  whatsappNumber: '+91 98765 43210',
  email: 'priya@example.com',
  age: 34,
  city: 'Bengaluru',
  gender: 'Female',
  notes: 'Bloating after meals',
  consent: true,
});

const fieldsOf = (body: unknown): Record<string, string> => {
  const result = parseCreateBooking(body);
  if (result.ok) throw new Error('expected a validation failure');
  return result.fields;
};
const valueOf = (body: unknown): CreateBookingInput => {
  const result = parseCreateBooking(body);
  if (!result.ok) throw new Error(`expected success, got ${JSON.stringify(result.fields)}`);
  return result.value;
};
const withField = (field: string, value: unknown) => ({ ...valid(), [field]: value });
const without = (field: string) => {
  const body = valid();
  delete body[field];
  return body;
};

describe('parseCreateBooking: accepted input', () => {
  it('normalises a complete form', () => {
    expect(valueOf({ ...valid(), name: '  Priya Sharma ', email: ' Priya@Example.COM ' })).toEqual({
      packageId: PACKAGE_ID,
      name: 'Priya Sharma',
      whatsappNumber: '+919876543210',
      email: 'priya@example.com',
      age: 34,
      city: 'Bengaluru',
      gender: 'Female',
      notes: 'Bloating after meals',
      consent: true,
    });
  });

  it('lower-cases an upper-case package id', () => {
    expect(valueOf(withField('packageId', PACKAGE_ID.toUpperCase())).packageId).toBe(PACKAGE_ID);
  });

  it.each([
    ['name', 2], ['name', 100], ['city', 2], ['city', 100],
  ])('accepts %s of %i characters', (field, size) => {
    expect(parseCreateBooking(withField(field, 'a'.repeat(size))).ok).toBe(true);
  });

  it.each([1, 119])('accepts age %i', (age) => {
    expect(valueOf(withField('age', age)).age).toBe(age);
  });

  it('accepts an email of exactly 50 characters', () => {
    const email = `${'a'.repeat(38)}@example.com`; // 38 + 12
    expect(email).toHaveLength(50);
    expect(valueOf(withField('email', email)).email).toBe(email);
  });

  it('counts characters, not UTF-16 units (an emoji is one)', () => {
    expect(parseCreateBooking(withField('city', '🙂'.repeat(100))).ok).toBe(true);
    expect(fieldsOf(withField('city', '🙂'.repeat(101)))).toHaveProperty('city');
  });

  it('treats the same text typed with combining marks or precomposed as one value', () => {
    expect(valueOf(withField('name', 'José')).name).toBe('José');
  });

  it.each([
    ['omitted', undefined],
    ['null', null],
    ['empty', ''],
    ['blank', '   '],
  ])('gender %s becomes null', (_label, gender) => {
    const body = valid();
    if (gender === undefined) delete body['gender'];
    else body['gender'] = gender;
    expect(valueOf(body).gender).toBeNull();
  });

  it('accepts gender of 1 and 50 characters, with inner spaces', () => {
    expect(valueOf(withField('gender', 'x')).gender).toBe('x');
    expect(valueOf(withField('gender', `${'a'.repeat(49)}b`)).gender).toHaveLength(50);
    expect(valueOf(withField('gender', 'Non binary')).gender).toBe('Non binary');
  });

  it.each([undefined, null, '', '   '])('notes %j become null', (notes) => {
    const body = valid();
    if (notes === undefined) delete body['notes'];
    else body['notes'] = notes;
    expect(valueOf(body).notes).toBeNull();
  });

  it('keeps line breaks and tabs inside notes, up to 1000 characters', () => {
    expect(valueOf(withField('notes', 'line one\nline two\tend')).notes).toBe('line one\nline two\tend');
    expect(valueOf(withField('notes', 'n'.repeat(1000))).notes).toHaveLength(1000);
  });

  it('allows any language', () => {
    expect(parseCreateBooking({ ...valid(), name: 'प्रिया शर्मा', city: 'बेंगलुरु', notes: 'पेट में सूजन' }).ok).toBe(true);
  });
});

describe('parseCreateBooking: refused input', () => {
  it.each([[null], [undefined], ['text'], [42], [[]], [[valid()]]])('refuses a body that is %j', (body) => {
    expect(fieldsOf(body)).toEqual({ body: 'Send a JSON object' });
  });

  it.each(['packageId', 'name', 'whatsappNumber', 'email', 'age', 'city', 'consent'])('refuses a missing %s', (field) => {
    expect(fieldsOf(without(field))).toHaveProperty(field);
  });

  it.each(['packageId', 'name', 'whatsappNumber', 'email', 'age', 'city', 'consent'])('refuses %s set to null', (field) => {
    expect(fieldsOf(withField(field, null))).toHaveProperty(field);
  });

  it('reports every problem at once', () => {
    expect(Object.keys(fieldsOf({ packageId: 'x', name: '', whatsappNumber: '1', email: 'x', age: 0, city: '', consent: false })).sort()).toEqual(
      ['age', 'city', 'consent', 'email', 'name', 'packageId', 'whatsappNumber'],
    );
  });

  it.each([['x'], [''], ['not-a-uuid'], [42], ['00000000-0000-4000-8000-00000000000g']])('refuses packageId %j', (packageId) => {
    expect(fieldsOf(withField('packageId', packageId))).toHaveProperty('packageId');
  });

  it.each([[''], [' '], ['a'], ['a'.repeat(101)], [7], [true], [['Priya']]])('refuses name %j', (name) => {
    expect(fieldsOf(withField('name', name))).toHaveProperty('name');
  });

  it.each([[''], ['a'], ['a'.repeat(101)], [7]])('refuses city %j', (city) => {
    expect(fieldsOf(withField('city', city))).toHaveProperty('city');
  });

  it.each([[0], [-1], [120], [34.5], ['34'], [true], [null], [Number.NaN], [1e9]])('refuses age %j', (age) => {
    expect(fieldsOf(withField('age', age))).toHaveProperty('age');
  });

  it.each([
    ['9876543210'], ['+1234567'], ['+1234567890123456'], ['+0123456789'], ['abc'], [''], [9876543210],
  ])('refuses whatsappNumber %j', (number) => {
    expect(fieldsOf(withField('whatsappNumber', number))).toHaveProperty('whatsappNumber');
  });

  it.each([
    ['no-at-sign'], ['a@b'], ['a b@example.com'], ['a|b@example.com'], ['<x>@example.com'], [`${'a'.repeat(39)}@example.com`], [''], [5],
  ])('refuses email %j', (email) => {
    expect(fieldsOf(withField('email', email))).toHaveProperty('email');
  });

  it.each([[51], [5], [true], [['x']]])('refuses gender %j', (gender) => {
    const length = typeof gender === 'number' && gender === 51 ? 'g'.repeat(51) : gender;
    expect(fieldsOf(withField('gender', length))).toHaveProperty('gender');
  });

  it('refuses notes over 1000 characters or not text', () => {
    expect(fieldsOf(withField('notes', 'n'.repeat(1001)))).toHaveProperty('notes');
    expect(fieldsOf(withField('notes', 5))).toHaveProperty('notes');
  });

  it.each([[false], ['true'], [1], ['yes'], [[true]]])('refuses consent %j', (consent) => {
    expect(fieldsOf(withField('consent', consent))).toHaveProperty('consent');
  });

  it.each(['name', 'city', 'gender', 'notes'])('refuses a NUL character in %s', (field) => {
    expect(fieldsOf(withField(field, 'ab\u0000cd'))).toHaveProperty(field);
  });

  it.each(['name', 'city', 'gender'])('refuses a line break or tab inside %s (single-line field)', (field) => {
    expect(fieldsOf(withField(field, 'ab\ncd'))).toHaveProperty(field);
    expect(fieldsOf(withField(field, 'ab\tcd'))).toHaveProperty(field);
  });

  it('refuses other control characters in notes (but not line breaks)', () => {
    expect(fieldsOf(withField('notes', 'ab\u001bcd'))).toHaveProperty('notes');
    expect(fieldsOf(withField('notes', 'ab\u007fcd'))).toHaveProperty('notes');
  });

  it('refuses unknown fields, naming each', () => {
    const fields = fieldsOf({ ...valid(), amountPaise: 1, status: 'CONFIRMED' });
    expect(fields).toEqual({ amountPaise: 'Unknown field', status: 'Unknown field' });
  });

  it('cannot be tricked by a __proto__ key', () => {
    const body = JSON.parse(`{"__proto__": {"consent": true}, "packageId": "${PACKAGE_ID}"}`) as unknown;
    const fields = fieldsOf(body);
    expect(fields['consent']).toBeDefined();
    expect(fields['__proto__']).toBe('Unknown field');
    // ...and on an otherwise perfect form it is still refused, not silently ignored.
    const perfect = JSON.parse(JSON.stringify(valid()).replace('{', '{"__proto__": {"x": 1}, ')) as unknown;
    expect(fieldsOf(perfect)).toEqual({ ['__proto__']: 'Unknown field' });
    expect(({} as Record<string, unknown>)['x']).toBeUndefined();
  });

  it('truncates a huge unknown field name in the answer', () => {
    const fields = fieldsOf({ ...valid(), ['k'.repeat(500)]: 1 });
    expect(Object.keys(fields)).toEqual(['k'.repeat(64)]);
  });
});
