import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PAYU_ENDPOINTS } from './payu-client.js';
import {
  CheckoutFieldError,
  buildCheckoutFields,
  cleanFirstname,
  cleanPhone,
  cleanProductInfo,
  payuPhone,
  validateEmail,
  type CheckoutInput,
} from './payu-checkout-fields.js';
import { verifyResponseHash } from './payu-hash.js';

const TXNID = 'EDTX_PU_1792200600123K7Q2';
const base: CheckoutInput = {
  creds: { key: 'test_key', salt: 'test_salt', env: 'test' },
  txnid: TXNID,
  amountPaise: 249900,
  productTitle: 'One-Time Consult',
  customerName: 'Priya Sharma',
  email: 'priya@example.com',
  phone: '+91 98765 43210',
  bookingReference: 'ED-7K3QXM',
  apiPublicUrl: 'https://api.easedisease.in',
};
const sha512 = (text: string) => createHash('sha512').update(text, 'utf8').digest('hex');
const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return (error as CheckoutFieldError).code ?? (error as Error).name;
  }
  return 'no error';
};

describe('buildCheckoutFields', () => {
  it('matches the golden vector, computed independently with sha512sum over a hand-written string', () => {
    // test_key|EDTX_PU_1792200600123K7Q2|2499.00|One-Time Consult|Priya|priya@example.com|ED-7K3QXM||||||||||test_salt
    const { fields } = buildCheckoutFields(base);
    expect(fields.hash).toBe(
      '3965794f751023e158f15820b121cbfa9850461954e7331d4aa878f10098e1133aa79f0d9088e0c19c9699a46a21910d3e01694e678deb226444e0142360cbd2',
    );
  });

  it('uses the documented fallbacks (golden vector 2: no name, no title)', () => {
    // test_key|EDTX_PU_1792200600123K7Q2|2499.00|Consultation|Customer|priya@example.com|ED-7K3QXM||||||||||test_salt
    const { fields } = buildCheckoutFields({ ...base, productTitle: '', customerName: null });
    expect(fields).toMatchObject({ productinfo: 'Consultation', firstname: 'Customer' });
    expect(fields.hash).toBe(
      '86a2b5b3222c786e1d97d826eef2275c4d23996c9e84cbd1688e9e084f878b2b9d4218573a0ee320a9294fec64a2b0fd081a9eab6b69e9728c25bdf8fd6b2306',
    );
  });

  it('sends exactly the documented fields, in a stable order, and nothing else', () => {
    const { fields, method } = buildCheckoutFields(base);
    expect(method).toBe('POST');
    expect(Object.keys(fields)).toEqual(['key', 'txnid', 'amount', 'productinfo', 'firstname', 'email', 'phone', 'surl', 'furl', 'curl', 'udf1', 'hash']);
    for (const forbidden of ['pg', 'bankcode', 'service_provider', 'api_version', 'salt']) {
      expect(fields).not.toHaveProperty(forbidden);
    }
  });

  it('fills every field from the right place', () => {
    const { fields } = buildCheckoutFields(base);
    expect(fields).toMatchObject({
      key: 'test_key',
      txnid: TXNID,
      amount: '2499.00',
      productinfo: 'One-Time Consult',
      firstname: 'Priya',
      email: 'priya@example.com',
      phone: '9876543210',
      udf1: 'ED-7K3QXM',
    });
  });

  it('points surl, furl and curl at our callback, all the same', () => {
    const { fields } = buildCheckoutFields(base);
    expect(fields.surl).toBe('https://api.easedisease.in/v1/payments/payu/callback');
    expect(fields.furl).toBe(fields.surl);
    expect(fields.curl).toBe(fields.surl);
  });

  it('chooses the gateway URL from the environment', () => {
    expect(buildCheckoutFields(base).gatewayUrl).toBe(PAYU_ENDPOINTS.test.checkoutUrl);
    expect(buildCheckoutFields({ ...base, creds: { ...base.creds, env: 'live' } }).gatewayUrl).toBe(PAYU_ENDPOINTS.live.checkoutUrl);
  });

  it('never leaks the salt, anywhere in the output', () => {
    const out = JSON.stringify(buildCheckoutFields({ ...base, creds: { ...base.creds, salt: 'SUPER_SECRET_SALT_VALUE' } }));
    expect(out).not.toContain('SUPER_SECRET_SALT_VALUE');
  });

  it('the hash is the standard request hash over exactly the strings that are sent', () => {
    const { fields } = buildCheckoutFields({ ...base, customerName: "Åsa O'Brien-Smith", productTitle: 'Consult | Plan <b>' });
    // The cleaned values (accents folded, pipes and markup removed) are what is hashed, so the hash must verify over them.
    expect(fields).toMatchObject({ firstname: 'Asa', productinfo: 'Consult Plan b' });
    // udf1 is followed by udf2..udf5 and udf6..udf10, all empty: nine empty fields before the salt (ten pipes in a row).
    const text = `test_key|${fields.txnid}|${fields.amount}|${fields.productinfo}|${fields.firstname}|${fields.email}|${fields.udf1}||||||||||test_salt`;
    expect(fields.hash).toBe(sha512(text));
  });

  it('is deterministic: the same input gives the same form (needed for repeated checkouts)', () => {
    expect(buildCheckoutFields(base)).toEqual(buildCheckoutFields(base));
  });

  it('what we send can be turned into a callback PayU would sign, and our verifier accepts it (round trip)', () => {
    // PayU's reverse hash uses the same fields; sign a response the way PayU documents it, with the independent sha512.
    const { fields } = buildCheckoutFields(base);
    const reverse = ['test_salt', 'success', '', '', '', '', '', '', '', '', '', fields.udf1, fields.email, fields.firstname, fields.productinfo, fields.amount, fields.txnid, fields.key].join('|');
    // reverse layout: SALT|status||||||udf5|udf4|udf3|udf2|udf1|email|firstname|productinfo|amount|txnid|key
    const payload = { ...fields, status: 'success', hash: sha512(reverse) };
    expect(verifyResponseHash(payload, { key: 'test_key', salt: 'test_salt' })).toBe(true);
  });

  describe('warnings about PayU limits we cannot yet confirm', () => {
    it('warns that production callback URLs exceed the documented 50 characters', () => {
      const { warnings } = buildCheckoutFields(base); // 52 characters
      expect(warnings).toEqual([expect.stringContaining('52 characters')]);
    });

    it('has no warning for a short https URL', () => {
      expect(buildCheckoutFields({ ...base, apiPublicUrl: 'https://a.io' }).warnings).toEqual([]);
    });

    it('warns about http (PayU documents a public https URL)', () => {
      const { warnings } = buildCheckoutFields({ ...base, apiPublicUrl: 'http://localhost:3000' });
      expect(warnings).toEqual([expect.stringContaining('https')]);
    });
  });

  describe('refuses data it cannot send safely', () => {
    it.each([
      ['an amount under ₹1', { amountPaise: 99 }, 'AMOUNT_INVALID'],
      ['a zero amount', { amountPaise: 0 }, 'AMOUNT_INVALID'],
      ['a negative amount', { amountPaise: -5 }, 'AMOUNT_INVALID'],
      ['a fractional amount', { amountPaise: 100.5 }, 'AMOUNT_INVALID'],
      ['a NaN amount', { amountPaise: Number.NaN }, 'AMOUNT_INVALID'],
      ['an over-long email', { email: `${'a'.repeat(45)}@example.com` }, 'EMAIL_TOO_LONG'],
      ['an email with a pipe', { email: 'a|b@example.com' }, 'EMAIL_INVALID'],
      ['an email with markup', { email: 'a<b>@example.com' }, 'EMAIL_INVALID'],
      ['an email with a space', { email: 'a b@example.com' }, 'EMAIL_INVALID'],
      ['an email without a domain', { email: 'priya@' }, 'EMAIL_INVALID'],
      ['a non-Indian phone', { phone: '+1 415 555 0100' }, 'PHONE_INVALID'],
      ['a short phone', { phone: '98765' }, 'PHONE_INVALID'],
      ['an empty phone', { phone: '' }, 'PHONE_INVALID'],
      ['a booking reference with a pipe', { bookingReference: 'ED|1' }, 'REFERENCE_INVALID'],
      ['an empty booking reference', { bookingReference: '' }, 'REFERENCE_INVALID'],
      ['an over-long booking reference', { bookingReference: 'E'.repeat(33) }, 'REFERENCE_INVALID'],
    ])('%s', (_name, change, code) => {
      expect(codeOf(() => buildCheckoutFields({ ...base, ...change }))).toBe(code);
    });

    it.each([
      ['a txnid not in our format', { txnid: 'abc' }],
      ['a txnid with a pipe', { txnid: 'EDTX_PU_1792200600123K7|2' }],
      ['an API URL with a path', { apiPublicUrl: 'https://api.easedisease.in/v1' }],
      ['an API URL with a trailing slash', { apiPublicUrl: 'https://api.easedisease.in/' }],
    ])('%s', (_name, change) => {
      expect(() => buildCheckoutFields({ ...base, ...change })).toThrow(RangeError);
    });
  });
});

describe('cleanFirstname', () => {
  it.each([
    ['Priya Sharma', 'Priya'],
    ['  priya  ', 'priya'],
    ["O'Brien Smith", "O'Brien"],
    ['Anne-Marie Jones', 'Anne-Marie'],
    ['José García', 'Jose'],
    ['Åsa', 'Asa'],
    ['Priya|Sharma', 'Priya'],
    ['<script>alert(1)</script>', 'script'],
    ['A'.repeat(50), 'A'.repeat(20)],
    ['प्रिया शर्मा', 'Customer'],
    ['😀😀', 'Customer'],
    ['', 'Customer'],
    ['   ', 'Customer'],
    [null, 'Customer'],
    [undefined, 'Customer'],
  ])('%j -> %j', (input, expected) => {
    expect(cleanFirstname(input)).toBe(expected);
  });
});

describe('cleanProductInfo', () => {
  it.each([
    ['One-Time Consult', 'One-Time Consult'],
    ['Consult | Plan <b>x</b>', 'Consult Plan b x b'],
    ['  many    spaces  ', 'many spaces'],
    ['Crème brûlée', 'Creme brulee'],
    ['', 'Consultation'],
    [null, 'Consultation'],
    ['★★★', 'Consultation'],
  ])('%j -> %j', (input, expected) => {
    expect(cleanProductInfo(input)).toBe(expected);
  });

  it('caps at 100 characters without leaving a trailing space', () => {
    const out = cleanProductInfo(`${'word '.repeat(40)}`);
    expect(out.length).toBeLessThanOrEqual(100);
    expect(out).toBe(out.trim());
  });
});

describe('cleanPhone', () => {
  it.each([
    ['9876543210', '9876543210'],
    ['+91 98765 43210', '9876543210'],
    ['+919876543210', '9876543210'],
    ['919876543210', '9876543210'],
    ['09876543210', '9876543210'],
    ['(98765) 43210', '9876543210'],
    ['98765-43210', '9876543210'],
    ['6000000000', '6000000000'],
  ])('%j -> %j', (input, expected) => {
    expect(cleanPhone(input)).toBe(expected);
  });

  it.each(['5876543210', '1234567890', '98765432101', '987654321', '+1 415 555 0100', 'abc', '', '+91'])('rejects %j', (input) => {
    expect(() => cleanPhone(input)).toThrow(CheckoutFieldError);
  });
});

describe('validateEmail', () => {
  it.each(['priya@example.com', 'p.s+tag@mail.example.co.in', 'A_B-c@x-y.io', `${'a'.repeat(38)}@example.com`])('accepts %s', (email) => {
    expect(validateEmail(email)).toBe(email);
  });

  it('trims surrounding whitespace', () => {
    expect(validateEmail('  priya@example.com ')).toBe('priya@example.com');
  });

  it.each(['', 'nope', '@example.com', 'a@b', 'a@b.c', 'a b@example.com', 'a|b@example.com', 'a@exa mple.com', 'a@@example.com', 'ä@example.com'])(
    'rejects %j',
    (email) => {
      expect(() => validateEmail(email)).toThrow(CheckoutFieldError);
    },
  );

  it('accepts exactly 50 characters and rejects 51', () => {
    const fifty = `${'a'.repeat(38)}@example.com`; // 38 + 12 = 50
    expect(fifty).toHaveLength(50);
    expect(validateEmail(fifty)).toBe(fifty);
    expect(codeOf(() => validateEmail(`b${fifty}`))).toBe('EMAIL_TOO_LONG');
  });
});

describe('cleaners on hostile and random input', () => {
  const SAFE = /^[A-Za-z0-9 .'-]*$/;
  const samples: string[] = [];
  for (let i = 0; i < 3000; i++) {
    // Deterministic spread over control characters, ASCII, accents, Indic scripts, emoji and combining marks.
    const length = (i % 40) + 1;
    let s = '';
    for (let j = 0; j < length; j++) s += String.fromCodePoint(((i * 7919 + j * 104729) % 0x1f700) + 1);
    samples.push(s);
  }
  samples.push('|', '||||', 'a|b', '\r\n', '\u0000', 'x\u0000y', '<img src=x onerror=alert(1)>', '"; DROP TABLE x; --');

  it('firstname and productinfo only ever contain safe characters, stay within their caps, and never contain the hash separator', () => {
    for (const s of samples) {
      const first = cleanFirstname(s);
      const product = cleanProductInfo(s);
      expect(first).toMatch(SAFE);
      expect(product).toMatch(SAFE);
      expect(first.length).toBeGreaterThan(0);
      expect(first.length).toBeLessThanOrEqual(20);
      expect(product.length).toBeGreaterThan(0);
      expect(product.length).toBeLessThanOrEqual(100);
      expect(first + product).not.toContain('|');
      expect(first).toBe(first.trim());
      expect(product).toBe(product.trim());
    }
  });
});

describe('payuPhone', () => {
  it.each([
    ['+919876543210', '9876543210'],
    ['+916000000000', '6000000000'],
    ['+919999999999', '9999999999'],
  ])('sends an Indian mobile %s as its own ten digits', (number, phone) => {
    expect(payuPhone(number, undefined)).toEqual({ phone, usedFallback: false });
    expect(payuPhone(number, '9000011111')).toEqual({ phone, usedFallback: false });
  });

  it.each(['+14155552671', '+447911123456', '+9876543210', '+911234567890', '+9198765432', '+9198765432100', '+971501234567'])(
    'sends the fallback for %s, and refuses without one',
    (number) => {
      expect(payuPhone(number, '9000011111')).toEqual({ phone: '9000011111', usedFallback: true });
      expect(() => payuPhone(number, undefined)).toThrow(CheckoutFieldError);
      expect(() => payuPhone(number, undefined)).toThrow(expect.objectContaining({ code: 'PHONE_UNSUPPORTED' }));
    },
  );

  it('treats an empty fallback as none', () => {
    expect(() => payuPhone('+14155552671', '')).toThrow(CheckoutFieldError);
  });

  it('does not accept a number without the plus as Indian', () => {
    expect(() => payuPhone('919876543210', undefined)).toThrow(CheckoutFieldError);
    expect(() => payuPhone('9876543210', undefined)).toThrow(CheckoutFieldError);
  });
});
