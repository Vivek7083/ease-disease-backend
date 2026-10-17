import { describe, expect, it } from 'vitest';
import { EVENT_PAYLOAD_ALLOWLIST, minimiseEventPayload } from './payment-event-payload.js';

/** Shaped like the real PayU test-mode callback captured on 2026-10-17 (values invented). */
const REAL_SHAPE: Record<string, string> = {
  addedon: '2026-10-17 11:02:03',
  address1: '12 Hidden Street',
  address2: 'Flat 4B',
  amount: '1.00',
  bankcode: 'CC',
  bank_ref_num: '431998369241',
  cardCategory: 'domestic',
  cardnum: '401200XXXXXX1112',
  city: 'Mumbai',
  country: 'India',
  discount: '0.00',
  email: 'priya.private@example.com',
  error: 'E000',
  error_Message: 'No Error',
  field1: 'f1',
  field9: 'Transaction Completed Successfully',
  firstname: 'Priya',
  hash: 'a'.repeat(128),
  key: 'public_merchant_key',
  lastname: 'Sharma',
  mihpayid: '20000059756',
  mode: 'CC',
  name_on_card: 'PRIYA SHARMA',
  net_amount_debit: '1',
  payment_source: 'payu',
  PG_TYPE: 'CC-PG',
  phone: '9876543210',
  productinfo: 'One-Time Consult',
  state: 'Maharashtra',
  status: 'success',
  txnid: 'EDTX01JBTESTTXN000000001',
  udf1: 'ED-7K3QXM',
  udf2: 'free text that could hold anything',
  udf10: 'x',
  unmappedstatus: 'captured',
  zipcode: '400001',
};

const PERSONAL_VALUES = [
  '12 Hidden Street',
  'Flat 4B',
  '401200XXXXXX1112',
  'Mumbai',
  'priya.private@example.com',
  'Priya',
  'Sharma',
  'PRIYA SHARMA',
  '9876543210',
  'Maharashtra',
  '400001',
  'India',
  'domestic',
  'free text that could hold anything',
];

describe('minimiseEventPayload', () => {
  it('keeps exactly the allowlisted values of a realistic PayU payload', () => {
    const stored = minimiseEventPayload(REAL_SHAPE);
    const { _receivedFields, ...values } = stored as Record<string, unknown>;
    expect(values).toEqual({
      addedon: '2026-10-17 11:02:03',
      amount: '1.00',
      bankcode: 'CC',
      bank_ref_num: '431998369241',
      error: 'E000',
      error_Message: 'No Error',
      hash: 'a'.repeat(128),
      mihpayid: '20000059756',
      mode: 'CC',
      net_amount_debit: '1',
      PG_TYPE: 'CC-PG',
      status: 'success',
      txnid: 'EDTX01JBTESTTXN000000001',
      udf1: 'ED-7K3QXM',
      unmappedstatus: 'captured',
    });
    expect(_receivedFields).toEqual(Object.keys(REAL_SHAPE));
  });

  it('never stores contact, address or card values anywhere in the result', () => {
    const text = JSON.stringify(minimiseEventPayload(REAL_SHAPE));
    for (const value of PERSONAL_VALUES) expect(text, value).not.toContain(value);
  });

  it('allowlist contains no personal field', () => {
    const personal = ['email', 'phone', 'firstname', 'lastname', 'address1', 'address2', 'city', 'state', 'country', 'zipcode', 'cardnum', 'name_on_card'];
    for (const field of personal) expect(EVENT_PAYLOAD_ALLOWLIST).not.toContain(field);
    expect(EVENT_PAYLOAD_ALLOWLIST).not.toContain('salt');
  });

  it('matches field names exactly: other spellings of allowlisted fields are dropped', () => {
    const stored = minimiseEventPayload({ TXNID: 'x', Status: 'y', pg_type: 'z', Error_message: 'q', Email: 'a@b.c', EMAIL: 'a@b.c' }) as Record<string, unknown>;
    expect(Object.keys(stored)).toEqual(['_receivedFields']);
    expect(stored['_receivedFields']).toEqual(['TXNID', 'Status', 'pg_type', 'Error_message', 'Email', 'EMAIL']);
  });

  it('drops allowlisted fields whose value is not a flat value, but still lists the name', () => {
    const stored = minimiseEventPayload({ txnid: { $ne: 'x' }, status: ['success'], amount: null, mode: undefined, udf1: 'ED-1' }) as Record<string, unknown>;
    expect(stored).toEqual({ udf1: 'ED-1', _receivedFields: ['txnid', 'status', 'amount', 'mode', 'udf1'] });
  });

  it('keeps numbers and booleans, turns non-finite numbers into text', () => {
    expect(minimiseEventPayload({ amount: 5, error: true, status: Infinity })).toEqual({
      amount: 5,
      error: true,
      status: 'Infinity',
      _receivedFields: ['amount', 'error', 'status'],
    });
  });

  it('caps a value at 500 characters and the field-name list at 100 names of 100 characters', () => {
    const many: Record<string, string> = { txnid: 'T'.repeat(5000) };
    for (let i = 0; i < 300; i++) many[`f${i}_${'n'.repeat(200)}`] = 'v';
    const stored = minimiseEventPayload(many) as Record<string, unknown>;
    expect((stored['txnid'] as string).length).toBe(500);
    const names = stored['_receivedFields'] as string[];
    expect(names).toHaveLength(100);
    expect(names.every((n) => n.length <= 100)).toBe(true);
    expect(stored['_receivedFieldCount']).toBe(301);
    expect(JSON.stringify(stored).length).toBeLessThan(15_000);
  });

  it('keeps NUL characters as visible text in values and names (jsonb cannot hold them)', () => {
    const stored = minimiseEventPayload({ txnid: 'A\u0000B', 'k\u0000ey': 'v' }) as Record<string, unknown>;
    expect(stored['txnid']).toBe('A\\u0000B');
    expect(stored['_receivedFields']).toEqual(['txnid', 'k\\u0000ey']);
    expect(JSON.stringify(stored)).not.toContain('\u0000');
  });

  it('stores hostile values as plain text only for allowlisted fields', () => {
    const sql = "'; DROP TABLE transactions; --";
    const stored = minimiseEventPayload({ txnid: sql, [sql]: sql, nested: { [sql]: [sql] } }) as Record<string, unknown>;
    expect(stored).toEqual({ txnid: sql, _receivedFields: ['txnid', sql, 'nested'] });
  });

  it('is not fooled by __proto__, constructor or inherited properties', () => {
    const parsed = JSON.parse('{"__proto__": {"status": "success"}, "constructor": "x", "txnid": "T1"}');
    const stored = minimiseEventPayload(parsed) as Record<string, unknown>;
    expect(stored['status']).toBeUndefined();
    expect(stored['txnid']).toBe('T1');
    expect(stored['_receivedFields']).toEqual(['__proto__', 'constructor', 'txnid']);
    expect(({} as Record<string, unknown>)['status']).toBeUndefined();

    class Inheriting {
      // eslint-disable-next-line no-unused-vars
      declare status: string;
    }
    Inheriting.prototype.status = 'success';
    expect(minimiseEventPayload(new Inheriting())).toEqual({ _receivedFields: [] });
  });

  it.each([
    ['a string holding personal data', 'name=Priya&email=priya.private@example.com', 'string'],
    ['null', null, 'null'],
    ['undefined', undefined, 'undefined'],
    ['a number', 12345, 'number'],
    ['an array', [{ email: 'priya.private@example.com' }], 'array'],
  ])('stores nothing but the kind of body for %s', (_name, body, kind) => {
    const stored = minimiseEventPayload(body);
    expect(stored).toEqual({ _nonObject: kind, _receivedFields: [] });
    expect(JSON.stringify(stored)).not.toContain('priya');
  });

  it('does not change its input', () => {
    const input = { ...REAL_SHAPE };
    minimiseEventPayload(input);
    expect(input).toEqual(REAL_SHAPE);
  });

  it('survives absurdly deep nesting and huge bodies without throwing', () => {
    let deep: unknown = 'bottom';
    for (let i = 0; i < 5000; i++) deep = { n: deep };
    expect(minimiseEventPayload(deep)).toEqual({ _receivedFields: ['n'] });
    expect(JSON.stringify(minimiseEventPayload({ txnid: 'T', blob: 'x'.repeat(1_000_000) })).length).toBeLessThan(200);
  });
});
