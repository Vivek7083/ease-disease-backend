import { describe, expect, it, vi } from 'vitest';
import { PAYU_ENDPOINTS, PayuClient, PayuGatewayError, type HttpPost, type PayuConfig } from './payu-client.js';
import { computeVerifyPaymentHash } from './payu-hash.js';

const config: PayuConfig = { key: 'test_key', salt: 'test_salt', env: 'test' };
const TXNID = 'EDTX01JBTESTTXN000000001';

const reply = (body: unknown, status = 200): HttpPost =>
  vi.fn().mockResolvedValue({ status, text: typeof body === 'string' ? body : JSON.stringify(body) });

const found = (overrides: Record<string, unknown> = {}, txnid = TXNID) => ({
  status: 1,
  msg: '1 out of 1 Transactions Fetched Successfully',
  transaction_details: {
    [txnid]: {
      mihpayid: '21564143078',
      bank_ref_num: '431998369241',
      amt: '1500.00',
      txnid,
      mode: 'UPI',
      status: 'success',
      unmappedstatus: 'captured',
      error_code: 'E000',
      error_Message: 'NO ERROR',
      ...overrides,
    },
  },
});

const clientWith = (http: HttpPost) => new PayuClient(() => config, http, 50);

describe('PayuClient.verifyPayment', () => {
  it('posts the signed verify_payment form to the test endpoint', async () => {
    const http = reply(found());
    await clientWith(http).verifyPayment(TXNID);

    const [url, body, options] = (http as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe(PAYU_ENDPOINTS.test.verifyUrl);
    expect(options).toEqual({ timeoutMs: 50 });
    const form = new URLSearchParams(body as string);
    expect(form.get('key')).toBe('test_key');
    expect(form.get('command')).toBe('verify_payment');
    expect(form.get('var1')).toBe(TXNID);
    expect(form.get('hash')).toBe(
      computeVerifyPaymentHash({ key: 'test_key', salt: 'test_salt', command: 'verify_payment', var1: TXNID }),
    );
    expect(body).not.toContain('test_salt');
  });

  it('uses the live endpoint when configured for live', async () => {
    const http = reply(found());
    await new PayuClient(() => ({ ...config, env: 'live' }), http).verifyPayment(TXNID);
    expect((http as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBe(PAYU_ENDPOINTS.live.verifyUrl);
  });

  it('returns a normalised success result with the amount in paise', async () => {
    const result = await clientWith(reply(found())).verifyPayment(TXNID);
    expect(result).toEqual({
      outcome: 'found',
      txnid: TXNID,
      status: 'success',
      rawStatus: 'success',
      amountPaise: 150000,
      mihpayid: '21564143078',
      mode: 'UPI',
      bankRefNum: '431998369241',
      errorCode: 'E000',
      errorMessage: 'NO ERROR',
    });
  });

  it.each([
    [{ status: 'failure', unmappedstatus: 'failed', bank_ref_num: null }, 'failure'],
    [{ status: 'failure', unmappedstatus: 'userCancelled' }, 'cancelled'],
    [{ status: 'pending', unmappedstatus: 'pending' }, 'pending'],
    [{ status: 'SUCCESS' }, 'success'],
    [{ status: 'somethingNew' }, 'unknown'],
  ])('maps %j to %s', async (overrides, expected) => {
    const result = await clientWith(reply(found(overrides))).verifyPayment(TXNID);
    expect(result).toMatchObject({ outcome: 'found', status: expected });
  });

  it('accepts numeric mihpayid and a null bank reference', async () => {
    const result = await clientWith(reply(found({ mihpayid: 21564143078, bank_ref_num: null }))).verifyPayment(TXNID);
    expect(result).toMatchObject({ mihpayid: '21564143078', bankRefNum: null });
  });

  it('returns not_found for an unknown txnid', async () => {
    const body = {
      status: 0,
      msg: '0 out of 1 Transactions Fetched Successfully',
      transaction_details: { [TXNID]: { mihpayid: 'Not Found', status: 'Not Found' } },
    };
    expect(await clientWith(reply(body)).verifyPayment(TXNID)).toEqual({ outcome: 'not_found' });
  });

  describe('fails closed with PayuGatewayError', () => {
    const cases: [string, HttpPost][] = [
      ['network error', vi.fn().mockRejectedValue(new Error('ECONNRESET'))],
      ['timeout', vi.fn().mockRejectedValue(new DOMException('timed out', 'TimeoutError'))],
      ['HTTP 500', reply('oops', 500)],
      ['HTTP 302', reply('', 302)],
      ['non-JSON body', reply('<html>maintenance</html>')],
      ['empty body', reply('')],
      ['JSON that is not an object', reply('null')],
      ['missing transaction_details', reply({ status: 1 })],
      ['txnid absent from transaction_details', reply(found({}, 'EDTX01JBOTHERTXN00000001'))],
      ['entry txnid differs from the request', reply(found({ txnid: 'EDTX01JBOTHERTXN00000001' }))],
      ['entry without a status', reply(found({ status: undefined }))],
      ['missing amount', reply(found({ amt: undefined }))],
      ['malformed amount', reply(found({ amt: '15,00.00' }))],
      ['negative amount', reply(found({ amt: '-1.00' }))],
    ];

    it.each(cases)('on %s', async (_name, http) => {
      await expect(clientWith(http).verifyPayment(TXNID)).rejects.toBeInstanceOf(PayuGatewayError);
    });
  });

  it('does not leak the salt or response body into error messages', async () => {
    const error = await clientWith(reply('secret-body test_salt', 500))
      .verifyPayment(TXNID)
      .catch((e: unknown) => e as Error);
    expect(error.message).not.toContain('test_salt');
    expect(error.message).not.toContain('secret-body');
  });

  it.each(['', 'a|b', 'EDTX01JB TXN', 'x'.repeat(26), "x'; DROP", 'tx\nid'])(
    'rejects an invalid txnid %j before any network call',
    async (txnid) => {
      const http = reply(found());
      await expect(clientWith(http).verifyPayment(txnid)).rejects.toThrow(RangeError);
      expect(http).not.toHaveBeenCalled();
    },
  );
});
