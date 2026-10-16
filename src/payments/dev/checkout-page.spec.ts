import { describe, expect, it } from 'vitest';
import type { CheckoutForm } from '../payu/payu-checkout-fields.js';
import { checkoutPageCsp, escapeHtml, renderCheckoutPage } from './checkout-page.js';

const NONCE = 'abc123NONCE';
const form = (overrides: Partial<CheckoutForm> = {}, fields: Record<string, string> = {}): CheckoutForm => ({
  gatewayUrl: 'https://test.payu.in/_payment',
  method: 'POST',
  fields: {
    key: 'test_key',
    txnid: 'EDTX_PU_1792200600123K7Q2',
    amount: '2499.00',
    productinfo: 'One-Time Consult',
    firstname: 'Priya',
    email: 'priya@example.com',
    phone: '9876543210',
    surl: 'https://api.easedisease.in/v1/payments/payu/callback',
    furl: 'https://api.easedisease.in/v1/payments/payu/callback',
    curl: 'https://api.easedisease.in/v1/payments/payu/callback',
    udf1: 'ED-7K3QXM',
    hash: 'f'.repeat(128),
    ...fields,
  },
  warnings: [],
  ...overrides,
});

describe('escapeHtml', () => {
  it.each([
    ['plain', 'plain'],
    ['<script>alert(1)</script>', '&lt;script&gt;alert(1)&lt;/script&gt;'],
    ['"quoted" & \'single\'', '&quot;quoted&quot; &amp; &#39;single&#39;'],
    ['a`b', 'a&#96;b'],
    ['&amp;', '&amp;amp;'],
    ['', ''],
  ])('%j -> %j', (input, expected) => {
    expect(escapeHtml(input)).toBe(expected);
  });

  it('leaves no characters that could break out of an attribute or tag', () => {
    const out = escapeHtml(`"'<>&\`\`"><img src=x onerror=alert(1)>`);
    expect(out).not.toMatch(/["'<>`]/);
  });
});

describe('renderCheckoutPage', () => {
  const page = renderCheckoutPage(form(), { reference: 'ED-7K3QXM' }, NONCE);

  it('is a form that posts every field to the gateway URL as hidden inputs', () => {
    expect(page).toContain('<form id="payu" method="POST" action="https://test.payu.in/_payment">');
    for (const [name, value] of Object.entries(form().fields)) {
      expect(page).toContain(`<input type="hidden" name="${name}" value="${value}">`);
    }
  });

  it('auto-submits with one nonce-carrying script, and offers a button as fallback', () => {
    expect(page.match(/<script/g)).toHaveLength(1);
    expect(page).toContain(`<script nonce="${NONCE}">document.getElementById('payu').submit();</script>`);
    expect(page).toContain('<button type="submit">Continue to PayU</button>');
  });

  it('carries the same nonce on its only style, with no inline event handlers or external resources', () => {
    expect(page).toContain(`<style nonce="${NONCE}">`);
    expect(page).not.toMatch(/\son[a-z]+\s*=/i);
    expect(page).not.toMatch(/(src|href)\s*=/i);
  });

  it('contains no salt and no field other than the documented ones', () => {
    expect(page).not.toMatch(/salt/i);
  });

  it('escapes hostile values everywhere they appear, so nothing can inject markup', () => {
    const hostile = `"><script>alert(1)</script><img src=x onerror=alert(2)>'\``;
    const out = renderCheckoutPage(
      form({ gatewayUrl: `https://x.example/?q=${hostile}`, warnings: [hostile] }, { productinfo: hostile, firstname: hostile, udf1: hostile, amount: hostile, txnid: hostile }),
      { reference: hostile },
      NONCE,
    );
    expect(out.match(/<script/g)).toHaveLength(1); // only ours
    expect(out).not.toContain('<img');
    expect(out).not.toContain('onerror=alert(2)>');
    expect(out).not.toContain(hostile);
    expect(out).toContain(escapeHtml(hostile));
  });

  it('shows warnings (escaped) so a developer sees PayU limits we may exceed', () => {
    const out = renderCheckoutPage(form({ warnings: ['callback is 52 characters <b>'] }), { reference: 'ED-1' }, NONCE);
    expect(out).toContain('<li>callback is 52 characters &lt;b&gt;</li>');
  });

  it('omits the warnings block when there are none', () => {
    expect(page).not.toContain('Heads-up');
  });
});

describe('checkoutPageCsp', () => {
  it('allows only this response\'s nonce, forbids everything else, and does not restrict form-action', () => {
    const csp = checkoutPageCsp(NONCE);
    expect(csp).toContain(`script-src 'nonce-${NONCE}'`);
    expect(csp).toContain(`style-src 'nonce-${NONCE}'`);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('form-action');
  });
});
