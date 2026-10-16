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

export interface BookingFixtureOptions {
  reference?: string;
  amountPaise?: number;
  bookingStatus?: BookingStatus;
  notes?: string;
  userName?: string | null;
  userEmail?: string;
  /** Stored as given (the profile step normalises to E.164 in real life). `null` = no phone yet. */
  userPhone?: string | null;
  packageTitle?: string;
}

export interface CheckoutFixtureOptions extends BookingFixtureOptions {
  txnid?: string;
  transactionStatus?: TransactionStatus;
}

/** A user, a package and a booking, with NO transaction yet: the state before checkout. */
export async function createBookingFixture(prisma: PrismaClient, options: BookingFixtureOptions = {}) {
  const {
    reference = REFERENCE,
    amountPaise = AMOUNT_PAISE,
    bookingStatus = 'PENDING_PAYMENT',
    notes = 'Private symptom notes: bloating after meals',
    userName = 'Priya Sharma',
    userEmail = 'priya@example.com',
    userPhone = '+919876543210',
    packageTitle = 'One-Time Consult',
  } = options;

  const user = await prisma.user.create({
    data: { firebaseUid: `fb_${randomUUID()}`, email: userEmail, name: userName, phone: userPhone, authProvider: 'google.com' },
  });
  const pkg = await prisma.package.create({
    data: { title: packageTitle, description: ['3-week plan.'], pricePaise: amountPaise },
  });
  const booking = await prisma.booking.create({
    data: {
      reference,
      userId: user.id,
      packageId: pkg.id,
      status: bookingStatus,
      packageTitle,
      amountPaise,
      patientName: 'Priya Sharma',
      notes,
      consentAt: new Date(),
    },
  });
  return { user, pkg, booking };
}

/** A user, the package, one booking and its one transaction: the state right after checkout. */
export async function createCheckoutFixture(prisma: PrismaClient, options: CheckoutFixtureOptions = {}) {
  const { txnid = TXNID, transactionStatus = 'INITIATED', ...bookingOptions } = options;
  const base = await createBookingFixture(prisma, bookingOptions);
  const transaction = await prisma.transaction.create({
    data: {
      orderId: txnid,
      bookingId: base.booking.id,
      userId: base.user.id,
      amountPaise: base.booking.amountPaise,
      status: transactionStatus,
    },
  });
  return { ...base, transaction };
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
