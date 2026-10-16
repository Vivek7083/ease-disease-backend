import { describe, expect, it } from 'vitest';
import {
  computeRequestHash,
  computeResponseHash,
  computeVerifyPaymentHash,
  formatAmountPaise,
  verifyResponseHash,
} from './payu-hash.js';

/**
 * Golden vectors were computed independently with `sha512sum` over hand-written literal strings
 * (not with this module), so they check the pipe layout and not just self-consistency.
 * All credentials here are fake.
 */
const creds = { key: 'test_key', salt: 'test_salt' };
const base = {
  txnid: 'EDTX01JBTESTTXN000000001',
  amount: '1500.00',
  productinfo: 'One-Time Consult',
  firstname: 'Priya',
  email: 'priya@example.com',
  udf1: 'ED-7K3QXM',
};

// test_key|EDTX01JBTESTTXN000000001|1500.00|One-Time Consult|Priya|priya@example.com|ED-7K3QXM||||||||||test_salt
const REQUEST_HASH =
  '42adbb25b7582f0a5134af8b4325953691d62eedbca0e2f1951d06dc41080a1044b5ac13422fa65eea9062bb5dfd81d5b104e4229862755118e7a7c0f4be204c';
// test_salt|success||||||||||ED-7K3QXM|priya@example.com|Priya|One-Time Consult|1500.00|EDTX01JBTESTTXN000000001|test_key
const RESPONSE_HASH =
  '7c76c6760b08ce0ce691835fe28f7dfc1788c1402c6bdc29dfb275d43551dbca444ab49daed91d537f1acf2f460b95e3cd0882d37ecae20bd3ea2817d9a0003b';
// 0.00|test_salt|success||||||||||ED-7K3QXM|...|test_key
const RESPONSE_HASH_ADDITIONAL_CHARGES =
  'e1cde284dd875aa98754dcbefe07f394fff047801534df30b250915612555333598692a73e3ce044b05b615d87b27a5f5147e8904e6c0a0e52b9d2f190fda776';
// test_key|verify_payment|EDTX01JBTESTTXN000000001|test_salt
const VERIFY_HASH =
  'f8d25548107f97d8accc7bc738ef0c08fa318ad5a9c8da39347ea75a47adcbe9bbe0979e4bcc7069d6447b5238da26db0039f6044ccdfdd5432c33a75607e236';

describe('formatAmountPaise', () => {
  it.each([
    [150000, '1500.00'],
    [0, '0.00'],
    [5, '0.05'],
    [99, '0.99'],
    [100, '1.00'],
    [123456, '1234.56'],
  ])('formats %i paise as %s', (paise, expected) => {
    expect(formatAmountPaise(paise)).toBe(expected);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects %s',
    (paise) => {
      expect(() => formatAmountPaise(paise)).toThrow(RangeError);
    },
  );
});

describe('computeRequestHash', () => {
  it('matches the golden vector', () => {
    expect(computeRequestHash({ ...creds, ...base })).toBe(REQUEST_HASH);
  });

  it('changes when any hashed field changes', () => {
    for (const change of [
      { txnid: 'EDTX01JBTESTTXN000000002' },
      { amount: '1500.01' },
      { productinfo: 'Other' },
      { firstname: 'Asha' },
      { email: 'a@example.com' },
      { udf1: 'ED-OTHER' },
      { udf5: 'x' },
    ]) {
      expect(computeRequestHash({ ...creds, ...base, ...change })).not.toBe(REQUEST_HASH);
    }
  });

  it('treats omitted udfs as empty strings', () => {
    const explicit = computeRequestHash({ ...creds, ...base, udf2: '', udf3: '', udf4: '', udf5: '' });
    expect(explicit).toBe(REQUEST_HASH);
  });
});

describe('computeResponseHash', () => {
  const input = { ...creds, ...base, status: 'success' };

  it('matches the golden vector', () => {
    expect(computeResponseHash(input)).toBe(RESPONSE_HASH);
  });

  it('matches the golden vector for the additional_charges variant', () => {
    expect(computeResponseHash({ ...input, additionalCharges: '0.00' })).toBe(RESPONSE_HASH_ADDITIONAL_CHARGES);
  });

  it('ignores an empty additional_charges value', () => {
    expect(computeResponseHash({ ...input, additionalCharges: '' })).toBe(RESPONSE_HASH);
  });
});

describe('computeVerifyPaymentHash', () => {
  it('matches the golden vector', () => {
    expect(computeVerifyPaymentHash({ ...creds, command: 'verify_payment', var1: base.txnid })).toBe(VERIFY_HASH);
  });
});

describe('verifyResponseHash', () => {
  const payload = {
    key: 'test_key',
    txnid: base.txnid,
    amount: base.amount,
    productinfo: base.productinfo,
    firstname: base.firstname,
    email: base.email,
    udf1: base.udf1,
    status: 'success',
    hash: RESPONSE_HASH,
  };

  it('accepts a valid payload', () => {
    expect(verifyResponseHash(payload, creds)).toBe(true);
  });

  it('accepts an uppercase hash', () => {
    expect(verifyResponseHash({ ...payload, hash: RESPONSE_HASH.toUpperCase() }, creds)).toBe(true);
  });

  it('accepts a valid additional_charges payload and rejects it when the field is stripped', () => {
    const withCharges = { ...payload, additional_charges: '0.00', hash: RESPONSE_HASH_ADDITIONAL_CHARGES };
    expect(verifyResponseHash(withCharges, creds)).toBe(true);
    const { additional_charges: _removed, ...stripped } = withCharges;
    expect(verifyResponseHash(stripped, creds)).toBe(false);
  });

  it.each([
    ['amount', '1.00'],
    ['status', 'failure'],
    ['txnid', 'EDTX01JBTESTTXN000000002'],
    ['email', 'evil@example.com'],
    ['udf1', 'ED-OTHER'],
    ['productinfo', 'Other'],
    ['firstname', 'Asha'],
  ])('rejects a tampered %s without throwing', (field, value) => {
    expect(verifyResponseHash({ ...payload, [field]: value }, creds)).toBe(false);
  });

  it('rejects a wrong salt and a wrong key', () => {
    expect(verifyResponseHash(payload, { ...creds, salt: 'other_salt' })).toBe(false);
    expect(verifyResponseHash(payload, { ...creds, key: 'other_key' })).toBe(false);
  });

  it('uses our configured key, not the key in the payload', () => {
    expect(verifyResponseHash({ ...payload, key: 'attacker_key' }, creds)).toBe(true);
  });

  it.each(['txnid', 'amount', 'productinfo', 'firstname', 'email', 'status', 'hash'])(
    'rejects a payload missing %s without throwing',
    (field) => {
      const { [field]: _removed, ...rest } = payload as Record<string, string>;
      expect(verifyResponseHash(rest, creds)).toBe(false);
    },
  );

  it('rejects non-string field values (arrays, objects, numbers) without throwing', () => {
    expect(verifyResponseHash({ ...payload, amount: ['1500.00'] }, creds)).toBe(false);
    expect(verifyResponseHash({ ...payload, status: { $ne: 'x' } }, creds)).toBe(false);
    expect(verifyResponseHash({ ...payload, hash: 123 }, creds)).toBe(false);
    expect(verifyResponseHash({ ...payload, udf1: ['a'] }, creds)).toBe(false);
  });

  it('rejects empty and wrong-length hashes', () => {
    expect(verifyResponseHash({ ...payload, hash: '' }, creds)).toBe(false);
    expect(verifyResponseHash({ ...payload, hash: RESPONSE_HASH.slice(0, 64) }, creds)).toBe(false);
  });
});
