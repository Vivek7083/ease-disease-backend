import { AppException } from '../src/common/exceptions/app.exception.js';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { PaymentHandlerService } from '../src/payments/payment-handler.service.js';
import type { PayuCredentialsProvider } from '../src/payments/payu/payu-credentials.provider.js';
import { CREDS, REFERENCE, TXNID, createCheckoutFixture, signedPayload, snapshot } from './helpers/payu-fixtures.js';
import { createTestPrisma, truncateAll } from './helpers/test-db.js';

/**
 * P4b: the handler's front half: shape check, hash check, transaction lookup, storing the event and
 * its verification, and the paths that must stop without changing anything. Real `_test` Postgres.
 */
describe('PaymentHandlerService: stop paths and event logging (real Postgres)', () => {
  let prisma: PrismaClient;
  let handler: PaymentHandlerService;
  let credentials: { get: () => unknown };

  beforeAll(() => {
    prisma = createTestPrisma();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await truncateAll(prisma);
    credentials = { get: () => CREDS };
    handler = new PaymentHandlerService(prisma, credentials as PayuCredentialsProvider);
  });

  const handle = (payload: unknown, source: 'RETURN' | 'WEBHOOK' | 'RECONCILE' = 'RETURN', sourceIp: string | null = '203.0.113.7') =>
    handler.handle({ source, payload, sourceIp });
  const events = () => prisma.paymentEvent.findMany({ orderBy: { receivedAt: 'asc' } });

  /** Every event must end up with its verification written exactly once. */
  const expectAllEventsVerified = async () => {
    for (const event of await events()) {
      expect(event.verification, `event ${event.id} has no verification`).not.toBeNull();
    }
  };

  describe('valid hash and a matching booking', () => {
    it('is verified, stores the event with its IP and source, and changes nothing else', async () => {
      await createCheckoutFixture(prisma);
      const before = await snapshot(prisma);

      const result = await handle(signedPayload(), 'WEBHOOK', '203.0.113.7');

      expect(result).toEqual({ outcome: 'verified', bookingReference: REFERENCE });
      expect(await snapshot(prisma)).toEqual(before);
      const [event] = await events();
      expect(event).toMatchObject({ source: 'WEBHOOK', hashValid: true, sourceIp: '203.0.113.7' });
      expect(event!.transactionId).not.toBeNull();
      expect(event!.payload).toMatchObject({ txnid: TXNID, status: 'success', amount: '2499.00' });
      expect(event!.verification).toMatchObject({
        hash: { valid: true, variant: 'standard' },
        checks: { referenceMatches: true },
        result: 'verified',
        handledAt: expect.any(String),
      });
    });

    it('verifies the additional_charges variant', async () => {
      await createCheckoutFixture(prisma);
      const result = await handle(signedPayload({ additional_charges: '0.00' }));
      expect(result.outcome).toBe('verified');
      expect((await events())[0]!.verification).toMatchObject({ hash: { valid: true, variant: 'additional_charges' } });
    });

    it.each(['RETURN', 'WEBHOOK', 'RECONCILE'] as const)('records the %s source', async (source) => {
      await createCheckoutFixture(prisma);
      await handle(signedPayload(), source, source === 'RECONCILE' ? null : '203.0.113.7');
      const [event] = await events();
      expect(event!.source).toBe(source);
      expect(event!.sourceIp).toBe(source === 'RECONCILE' ? null : '203.0.113.7');
    });

    it('logs every signal: the same payload handled three times leaves three events', async () => {
      await createCheckoutFixture(prisma);
      for (let i = 0; i < 3; i++) expect((await handle(signedPayload())).outcome).toBe('verified');
      expect(await prisma.paymentEvent.count()).toBe(3);
      await expectAllEventsVerified();
    });
  });

  describe('unknown transaction', () => {
    it('stores the event with no transaction, changes nothing, and gives no booking reference', async () => {
      await createCheckoutFixture(prisma);
      const before = await snapshot(prisma);

      const result = await handle(signedPayload({ txnid: 'EDTX01JBUNKNOWNTXN00001' }));

      expect(result).toEqual({ outcome: 'unknown_transaction', bookingReference: null });
      expect(await snapshot(prisma)).toEqual(before);
      const [event] = await events();
      expect(event!.transactionId).toBeNull();
      expect(event!.verification).toMatchObject({ result: 'unknown_transaction' });
    });

    it.each([
      ['null', null],
      ['undefined', undefined],
      ['a string', 'txnid=EDTX01JBTESTTXN000000001'],
      ['a number', 123],
      ['an array', [{ txnid: TXNID }]],
      ['an empty object', {}],
      ['a numeric txnid', { txnid: 5 }],
      ['an array txnid', { txnid: [TXNID] }],
      ['an empty txnid', { txnid: '' }],
      ['an over-long txnid', { txnid: 'E'.repeat(26) }],
      ['a txnid with a pipe', { txnid: 'EDTX01|EDTX02' }],
      ['a txnid with a space', { txnid: 'EDTX 01' }],
    ])('copes with %s: no throw, nothing changes, the event is still logged', async (_name, payload) => {
      await createCheckoutFixture(prisma);
      const before = await snapshot(prisma);

      const result = await handle(payload);

      expect(result).toEqual({ outcome: 'unknown_transaction', bookingReference: null });
      expect(await snapshot(prisma)).toEqual(before);
      expect(await prisma.paymentEvent.count()).toBe(1);
      expect((await events())[0]!.hashValid).toBe(false);
      await expectAllEventsVerified();
    });
  });

  describe('invalid hash', () => {
    it.each([
      ['amount', { amount: '1.00' }],
      ['status', { status: 'failure' }],
      ['email', { email: 'evil@example.com' }],
      ['firstname', { firstname: 'Mallory' }],
      ['productinfo', { productinfo: 'Free stuff' }],
      ['udf1', { udf1: 'ED-OTHER1' }],
      ['hash itself', { hash: 'a'.repeat(128) }],
      ['hash removed', { hash: '' }],
    ])('rejects a tampered %s: stored as hash_valid=false, nothing changes', async (_name, tamper) => {
      await createCheckoutFixture(prisma);
      const before = await snapshot(prisma);

      const result = await handle({ ...signedPayload(), ...tamper });

      expect(result).toEqual({ outcome: 'hash_invalid', bookingReference: REFERENCE });
      expect(await snapshot(prisma)).toEqual(before);
      const [event] = await events();
      expect(event).toMatchObject({ hashValid: false });
      expect(event!.transactionId).not.toBeNull();
      expect(event!.verification).toMatchObject({ hash: { valid: false }, result: 'hash_invalid' });
    });

    it('rejects a payload signed with the wrong salt', async () => {
      await createCheckoutFixture(prisma);
      credentials.get = () => ({ ...CREDS, salt: 'a_different_salt' });
      expect((await handle(signedPayload())).outcome).toBe('hash_invalid');
    });

    it('rejects a payload that is missing a hashed field', async () => {
      await createCheckoutFixture(prisma);
      const { email: _email, ...withoutEmail } = signedPayload();
      expect((await handle(withoutEmail)).outcome).toBe('hash_invalid');
    });

    it('rejects a payload where a field is an array instead of a string', async () => {
      await createCheckoutFixture(prisma);
      expect((await handle({ ...signedPayload(), amount: ['2499.00'] })).outcome).toBe('hash_invalid');
    });

    it('keeps the unknown-transaction outcome when both the txnid and the hash are wrong', async () => {
      await createCheckoutFixture(prisma);
      const result = await handle({ ...signedPayload({ txnid: 'EDTX01JBUNKNOWNTXN00001' }), hash: 'bad' });
      expect(result.outcome).toBe('unknown_transaction');
    });
  });

  describe('booking reference cross-check', () => {
    it('ignores a correctly signed signal whose udf1 is a different booking, and changes nothing', async () => {
      await createCheckoutFixture(prisma);
      const before = await snapshot(prisma);

      const result = await handle(signedPayload({ udf1: 'ED-OTHER1' }));

      expect(result).toEqual({ outcome: 'ignored', bookingReference: REFERENCE });
      expect(await snapshot(prisma)).toEqual(before);
      expect((await events())[0]!.verification).toMatchObject({ checks: { referenceMatches: false }, result: 'ignored' });
    });

    it('takes the booking reference from our database, whatever the payload says', async () => {
      await createCheckoutFixture(prisma);
      const result = await handle({ ...signedPayload(), udf1: "x'); DROP TABLE bookings;--" });
      expect(result.bookingReference).toBe(REFERENCE);
    });
  });

  describe('payment credentials not configured', () => {
    it('stores the event, reports gateway_error and changes nothing', async () => {
      await createCheckoutFixture(prisma);
      const before = await snapshot(prisma);
      credentials.get = () => {
        throw new AppException('PAYMENT_GATEWAY_UNAVAILABLE', 'not configured', 503);
      };

      const result = await handle(signedPayload());

      expect(result).toEqual({ outcome: 'gateway_error', bookingReference: REFERENCE });
      expect(await snapshot(prisma)).toEqual(before);
      const [event] = await events();
      expect(event).toMatchObject({ hashValid: false });
      expect(event!.verification).toMatchObject({ hash: { valid: false, reason: 'not_configured' }, result: 'gateway_error' });
    });
  });

  describe('hostile input (SQL injection, odd bytes, huge bodies)', () => {
    const sql = "'; DROP TABLE transactions; --";
    const hostile = {
      txnid: sql,
      status: "' OR '1'='1",
      amount: '1; DELETE FROM bookings',
      udf1: '"; TRUNCATE users; --',
      email: "a'b@example.com",
      firstname: '${jndi:ldap://x}',
      hash: "x' UNION SELECT * FROM users --",
      [sql]: sql,
      nested: { [sql]: [sql, { deeper: sql }] },
    };

    it('stores everything as plain data, and every table and row is untouched', async () => {
      await createCheckoutFixture(prisma);
      const before = await snapshot(prisma);

      const result = await handle(hostile, 'WEBHOOK', "1.2.3.4'; DROP TABLE users;--".slice(0, 20));

      expect(result.outcome).toBe('unknown_transaction');
      expect(await snapshot(prisma)).toEqual(before);
      const [event] = await events();
      expect(event!.payload).toEqual(hostile);
      expect(await prisma.$queryRaw`SELECT to_regclass('public.transactions')::text AS t`).toEqual([{ t: 'transactions' }]);
    });

    it('hostile text in a hash-signed field of a KNOWN transaction is stored as data too', async () => {
      await createCheckoutFixture(prisma);
      const result = await handle(signedPayload({ firstname: sql, email: `${sql}@x.com`, productinfo: sql }));
      expect(result.outcome).toBe('verified');
      expect((await events())[0]!.payload).toMatchObject({ firstname: sql, productinfo: sql });
      expect(await prisma.transaction.count()).toBe(1);
    });

    it('survives NUL characters (which jsonb cannot hold) by keeping them as visible text', async () => {
      await createCheckoutFixture(prisma);
      const result = await handle({ txnid: 'EDTX01\u0000X', 'k\u0000ey': 'v\u0000alue' });
      expect(result.outcome).toBe('unknown_transaction');
      expect((await events())[0]!.payload).toEqual({ txnid: 'EDTX01\\u0000X', 'k\\u0000ey': 'v\\u0000alue' });
    });

    it('stores a non-object body wrapped, so nothing is lost', async () => {
      await handle('plain text body');
      expect((await events())[0]!.payload).toEqual({ _raw: 'plain text body' });
    });

    it('keeps only a preview of an oversized payload', async () => {
      await handle({ txnid: TXNID, blob: 'x'.repeat(200_000) });
      const payload = (await events())[0]!.payload as Record<string, unknown>;
      expect(payload['_truncated']).toBe(true);
      expect(payload['_length']).toBeGreaterThan(200_000);
      expect(String(payload['_preview']).length).toBe(2000);
    });

    it('survives absurdly deep nesting', async () => {
      let deep: unknown = 'bottom';
      for (let i = 0; i < 5000; i++) deep = { n: deep };
      await expect(handle(deep)).resolves.toMatchObject({ outcome: 'unknown_transaction' });
      expect(await prisma.paymentEvent.count()).toBe(1);
    });

    it.each([
      ['an over-long IP', 'x'.repeat(100)],
      ['an empty IP', ''],
      ['a hostile IP', "'; DROP TABLE users;--" + 'x'.repeat(30)],
    ])('stores %s as null instead of failing', async (_name, ip) => {
      await expect(handle(signedPayload(), 'WEBHOOK', ip)).resolves.toBeDefined();
      expect((await events())[0]!.sourceIp).toBeNull();
    });

    it('stores a valid IPv6 address exactly', async () => {
      await handle(signedPayload(), 'WEBHOOK', '2001:db8::8a2e:370:7334');
      expect((await events())[0]!.sourceIp).toBe('2001:db8::8a2e:370:7334');
    });
  });
});
