import type { CheckoutForm } from '../payu/payu-checkout-fields.js';

/** Escapes text for use in HTML element content and in quoted attribute values. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replaceAll('`', '&#96;');
}

/**
 * The Content-Security-Policy for the dev checkout page: nothing loads or runs except the one inline script and
 * style carrying this response's nonce. `form-action` is deliberately NOT restricted: browsers also apply it to the
 * redirects after the submit, and PayU's checkout hops between hosts we cannot list with certainty.
 */
export function checkoutPageCsp(nonce: string): string {
  return `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'`;
}

/**
 * DEV ONLY. A tiny page that posts the checkout form to PayU's hosted checkout, so a developer can try the real
 * test payment page by opening one URL. Every value is HTML-escaped. The script submits the form automatically;
 * the visible button is the fallback. Contains no secret (the hash and merchant key are public by design; the
 * salt is never part of a form).
 */
export function renderCheckoutPage(form: CheckoutForm, context: { reference: string }, nonce: string): string {
  const inputs = Object.entries(form.fields)
    .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
    .join('\n      ');
  const warnings = form.warnings.length
    ? `<h2>Heads-up</h2>\n    <ul>${form.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>Dev checkout</title>
  <style nonce="${nonce}">body{font-family:system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem}code{background:#eee;padding:0 .25rem}button{font-size:1rem;padding:.5rem 1rem}</style>
</head>
<body>
  <main>
    <h1>Dev checkout (development only)</h1>
    <p>Booking <code>${escapeHtml(context.reference)}</code>, ${escapeHtml(form.fields['amount'] ?? '')} INR, transaction <code>${escapeHtml(form.fields['txnid'] ?? '')}</code>.</p>
    <p>Sending you to <code>${escapeHtml(form.gatewayUrl)}</code>. If nothing happens, use the button.</p>
    ${warnings}
    <form id="payu" method="${escapeHtml(form.method)}" action="${escapeHtml(form.gatewayUrl)}">
      ${inputs}
      <button type="submit">Continue to PayU</button>
    </form>
  </main>
  <script nonce="${nonce}">document.getElementById('payu').submit();</script>
</body>
</html>
`;
}
