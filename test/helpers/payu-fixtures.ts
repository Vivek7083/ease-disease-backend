import { randomUUID } from 'node:crypto';
import type { BookingStatus, PrismaClient, TransactionStatus } from '../../src/generated/prisma/client.js';
import { computeResponseHash } from '../../src/payments/payu/payu-hash.js';

/** Fake credentials: used everywhere in tests, never real ones. */
export const CREDS = { key: 'test_key', salt: 'test_salt', env: 'test' as const };

export const TXNID = 'EDTX01JBTESTTXN000000001';
export const REFERENCE = 'ED-7K3QXM';
export const AMOUNT_PAISE = 249900;
export const AMOUNT = '2499.00';

export interface PayuPayloadFields {
  txnid: string;
  amount: string;
  productinfo: string;
  firstname: string;
  email: string;
  udf1: string;
  status: string;
  additional_charges?: string;
  mihpayid: string;
  mode: string;
  bank_ref_num: string;
  error_Message: string;
}

/** What PayU posts back, with a genuine reverse hash computed over the final field values. */
export function signedPayload(overrides: Partial<PayuPayloadFields> = {}): Record<string, string> {
  const fields: PayuPayloadFields = {
    txnid: TXNID,
    amount: AMOUNT,
    productinfo: 'One-Time Consult',
    firstname: 'Priya',
    email: 'priya@example.com',
    udf1: REFERENCE,
    status: 'success',
    mihpayid: '21564143078',
    mode: 'UPI',
    bank_ref_num: '431998369241',
    error_Message: 'NO ERROR',
    ...overrides,
  };
  const hash = computeResponseHash({
    key: CREDS.key,
    salt: CREDS.salt,
    txnid: fields.txnid,
    amount: fields.amount,
    productinfo: fields.productinfo,
    firstname: fields.firstname,
    email: fields.email,
    status: fields.status,
    udf1: fields.udf1,
    additionalCharges: fields.additional_charges,
  });
  const { additional_charges, ...rest } = fields;
  return { key: CREDS.key, ...rest, ...(additional_charges === undefined ? {} : { additional_charges }), hash };
}

export interface CheckoutFixtureOptions {
  txnid?: string;
  reference?: string;
  amountPaise?: number;
  bookingStatus?: BookingStatus;
  transactionStatus?: TransactionStatus;
  notes?: string;
}

/** A user, the package, one booking and its one INITIATED transaction: the state right after checkout. */
export async function createCheckoutFixture(prisma: PrismaClient, options: CheckoutFixtureOptions = {}) {
  const {
    txnid = TXNID,
    reference = REFERENCE,
    amountPaise = AMOUNT_PAISE,
    bookingStatus = 'PENDING_PAYMENT',
    transactionStatus = 'INITIATED',
    notes = 'Private symptom notes: bloating after meals',
  } = options;

  const user = await prisma.user.create({
    data: { firebaseUid: `fb_${randomUUID()}`, email: 'priya@example.com', name: 'Priya Sharma', authProvider: 'google.com' },
  });
  const pkg = await prisma.package.create({
    data: { title: 'One-Time Consult', description: ['3-week plan.'], pricePaise: amountPaise },
  });
  const booking = await prisma.booking.create({
    data: {
      reference,
      userId: user.id,
      packageId: pkg.id,
      status: bookingStatus,
      packageTitle: 'One-Time Consult',
      amountPaise,
      patientName: 'Priya Sharma',
      notes,
      consentAt: new Date(),
    },
  });
  const transaction = await prisma.transaction.create({
    data: { orderId: txnid, bookingId: booking.id, userId: user.id, amountPaise, status: transactionStatus },
  });
  return { user, pkg, booking, transaction };
}

/** Row counts and key states, to prove a handled signal changed (or did not change) anything. */
export async function snapshot(prisma: PrismaClient) {
  const [users, packages, bookings, transactions, outbox, bookingRows, transactionRows] = await Promise.all([
    prisma.user.count(),
    prisma.package.count(),
    prisma.booking.count(),
    prisma.transaction.count(),
    prisma.outbox.count(),
    prisma.booking.findMany({ orderBy: { reference: 'asc' } }),
    prisma.transaction.findMany({ orderBy: { orderId: 'asc' } }),
  ]);
  return { users, packages, bookings, transactions, outbox, bookingRows, transactionRows };
}
