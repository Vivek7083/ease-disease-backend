import { randomUUID } from 'node:crypto';
import {
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppException } from '../common/exceptions/app.exception.js';
import type { RequestOrigin } from '../common/http/request-origin.js';
import {
  claimKey,
  hashRequest,
  saveResponse,
  type IdempotencyScope,
} from '../common/idempotency/idempotency.js';
import type { Env } from '../config/env.schema.js';
import type { Prisma, PrismaClient, TransactionStatus } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  CheckoutFieldError,
  buildCheckoutFields,
  payuPhone,
  validateEmail,
  type CheckoutForm,
} from './payu/payu-checkout-fields.js';
import { PayuCredentialsProvider } from './payu/payu-credentials.provider.js';
import { generateTxnid } from './payu/payu-txnid.js';

export const TXNID_GENERATOR = Symbol('TXNID_GENERATOR');
export const DEFAULT_API_PUBLIC_URL = 'http://localhost:3000';
export const CHECKOUT_ENDPOINT = 'POST /v1/bookings/{reference}/checkout';

const MAX_TXNID_ATTEMPTS = 5;
/** Our booking references look like `ED-7K3QXM`. Anything else cannot exist, so it never reaches a query. */
const REFERENCE_PATTERN = /^[A-Za-z0-9-]{1,32}$/;

/** The only transaction states in which a checkout may be (re)issued: nothing has been decided at PayU yet. */
const REUSABLE_TRANSACTION_STATUSES = ['CREATED', 'INITIATED'];

const NO_ORIGIN: RequestOrigin = { ip: null, userAgent: null };

export interface CreateCheckoutInput {
  /** The authenticated user. Ownership is enforced here so no endpoint can forget it. */
  userId: string;
  bookingReference: string;
  /** Who is asking; stored on the transaction when it is created (chargeback evidence). */
  origin?: RequestOrigin;
  /** Run every read and write on this transaction (the idempotent route does); default is the plain client. */
  db?: Prisma.TransactionClient;
}

export interface CreateCheckoutOnceInput {
  userId: string;
  bookingReference: string;
  /** The validated `Idempotency-Key` header. */
  idempotencyKey: string;
  origin: RequestOrigin;
}

/** What the API returns: the form without our internal `warnings`. */
export type PublicCheckoutForm = Omit<CheckoutForm, 'warnings'>;

interface TransactionRow {
  id: string;
  orderId: string;
  status: TransactionStatus;
  amountPaise: number;
}

/**
 * Turns a booking into the form the browser posts to PayU, creating the booking's single transaction the
 * first time and reusing it afterwards. Idempotent: a repeat, a double-click or two simultaneous first
 * clicks all end with the same transaction and the same txnid. Every value that is hashed and sent comes
 * from the database (the booking's own price snapshot and contact details), never from the caller.
 */
@Injectable()
export class CheckoutService {
  private readonly logger = new Logger(CheckoutService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaClient,
    private readonly credentials: PayuCredentialsProvider,
    private readonly config: ConfigService<Env, true>,
    @Optional()
    @Inject(TXNID_GENERATOR)
    private readonly newTxnid: () => string = () => generateTxnid(),
  ) {}

  /**
   * `POST /v1/bookings/{reference}/checkout`: claims the `Idempotency-Key`, builds the form and stores the answer on the
   * key, all in ONE database transaction (the form needs no network call, so the transaction stays short). A repeat with
   * the same key returns the stored form, but only while the booking is still payable: once it is paid, failed or closed
   * the repeat gets `409 BOOKING_NOT_PAYABLE` instead, so the app never shows a dead payment form.
   */
  async createCheckoutOnce({
    userId,
    bookingReference,
    idempotencyKey,
    origin,
  }: CreateCheckoutOnceInput): Promise<{ form: PublicCheckoutForm; replayed: boolean }> {
    const scope: IdempotencyScope = {
      key: idempotencyKey,
      userId,
      endpoint: CHECKOUT_ENDPOINT,
    };
    const requestHash = hashRequest({ reference: bookingReference });

    return this.prisma.$transaction(async (tx) => {
      const claim = await claimKey(tx, scope, requestHash);
      if (claim.kind === 'replay') {
        await this.loadPayableBooking(tx, userId, bookingReference);
        return { form: claim.response as PublicCheckoutForm, replayed: true };
      }
      const { warnings: _warnings, ...form } = await this.createCheckout({
        userId,
        bookingReference,
        origin,
        db: tx,
      });
      await saveResponse(tx, scope, form);
      return { form, replayed: false };
    });
  }

  async createCheckout({
    userId,
    bookingReference,
    origin = NO_ORIGIN,
    db = this.prisma,
  }: CreateCheckoutInput): Promise<CheckoutForm> {
    const booking = await this.loadPayableBooking(db, userId, bookingReference);

    // Everything that can be wrong with the customer's data is checked BEFORE anything is written.
    const { phone, usedFallback } = this.customerPhone(
      booking.consulteeEmail,
      booking.consulteeWhatsappNumber,
    );
    const creds = this.credentials.get(); // 503 when payments are not configured, before any write

    const { transaction, created } = booking.transaction
      ? { transaction: booking.transaction, created: false }
      : await this.createOrAdopt(
          db,
          booking.id,
          userId,
          booking.amountPaise,
          origin,
        );

    const form = buildCheckoutFields({
      creds,
      txnid: transaction.orderId,
      amountPaise: transaction.amountPaise,
      productTitle: booking.packageTitle,
      customerName: booking.consulteeName,
      email: booking.consulteeEmail,
      phone,
      bookingReference: booking.reference,
      apiPublicUrl:
        this.config.get('API_PUBLIC_URL', { infer: true }) ??
        DEFAULT_API_PUBLIC_URL,
    });
    if (created && form.warnings.length > 0) {
      this.logger.warn(
        `Checkout for ${booking.reference}: ${form.warnings.join('; ')}`,
      );
    }
    if (created && usedFallback) {
      this.logger.log(
        `Checkout for ${booking.reference}: the WhatsApp number is not Indian, so the business fallback phone was sent to PayU`,
      );
    }
    return form;
  }

  /**
   * The booking, if it belongs to this user and can still be paid for. Not yours and not existing look identical (404), so
   * references cannot be probed.
   */
  private async loadPayableBooking(
    db: Prisma.TransactionClient,
    userId: string,
    bookingReference: string,
  ) {
    // A malformed reference (including NUL bytes, which Postgres rejects) is simply a booking that does not exist.
    const booking = REFERENCE_PATTERN.test(bookingReference)
      ? await db.booking.findUnique({
          where: { reference: bookingReference },
          select: {
            id: true,
            reference: true,
            userId: true,
            status: true,
            packageTitle: true,
            /** The booking's own price snapshot: the only source of the amount. */
            amountPaise: true,
            /** Who the consultation is for, as typed on the booking form: what PayU is sent. The account's own details play no part. */
            consulteeName: true,
            consulteeEmail: true,
            consulteeWhatsappNumber: true,
            transaction: {
              select: {
                id: true,
                orderId: true,
                status: true,
                amountPaise: true,
              },
            },
          },
        })
      : null;

    if (!booking || booking.userId !== userId) {
      throw new AppException(
        'BOOKING_NOT_FOUND',
        'Booking not found',
        HttpStatus.NOT_FOUND,
      );
    }
    if (booking.status !== 'PENDING_PAYMENT') {
      throw new AppException(
        'BOOKING_NOT_PAYABLE',
        'This booking cannot be paid for',
        HttpStatus.CONFLICT,
        {
          reason: 'BOOKING_STATUS',
          status: booking.status,
        },
      );
    }
    if (
      booking.transaction &&
      !REUSABLE_TRANSACTION_STATUSES.includes(booking.transaction.status)
    ) {
      throw new AppException(
        'BOOKING_NOT_PAYABLE',
        'A payment for this booking has already been started',
        HttpStatus.CONFLICT,
        {
          reason: 'PAYMENT_ALREADY_STARTED',
          status: booking.transaction.status,
        },
      );
    }
    return booking;
  }

  /**
   * The phone PayU is sent, after checking the booking's email. The email was already validated when the booking was
   * created (and the database enforces it), so a failure here means a hand-edited row: refused with `VALIDATION_FAILED`
   * before anything is written. A number that is not Indian and has no fallback is a valid booking whose payment step
   * cannot proceed yet: `409 PAYMENT_PHONE_UNSUPPORTED`.
   */
  private customerPhone(email: string, whatsappNumber: string) {
    try {
      validateEmail(email);
    } catch (error) {
      if (!(error instanceof CheckoutFieldError)) throw error;
      throw new AppException(
        'VALIDATION_FAILED',
        'The booking details cannot be sent to the payment gateway',
        HttpStatus.BAD_REQUEST,
        { fields: { email: error.message } },
      );
    }
    try {
      return payuPhone(
        whatsappNumber,
        this.config.get('PAYU_FALLBACK_PHONE', { infer: true }),
      );
    } catch (error) {
      if (!(error instanceof CheckoutFieldError)) throw error;
      throw new AppException(
        'PAYMENT_PHONE_UNSUPPORTED',
        error.message,
        HttpStatus.CONFLICT,
      );
    }
  }

  /**
   * Creates the booking's transaction, or adopts the one a simultaneous request created first. `INSERT ... ON CONFLICT DO
   * NOTHING` instead of catching a unique violation, because a violation would abort the surrounding database transaction
   * (and the idempotency key with it). Nothing returned means one of two unique rules was hit, told apart by looking again:
   * the booking already has a transaction (we lost a race: use it), or the random txnid collided with another booking's
   * (try a new one). The sender's address and user-agent are stored only on creation, so a reused transaction keeps its own.
   */
  private async createOrAdopt(
    db: Prisma.TransactionClient,
    bookingId: string,
    userId: string,
    amountPaise: number,
    origin: RequestOrigin,
  ): Promise<{ transaction: TransactionRow; created: boolean }> {
    for (let attempt = 1; attempt <= MAX_TXNID_ATTEMPTS; attempt++) {
      const inserted = await db.$queryRaw<
        {
          id: string;
          order_id: string;
          status: TransactionStatus;
          amount_paise: number;
        }[]
      >`
        INSERT INTO transactions (id, order_id, booking_id, user_id, amount_paise, status, created_ip, created_user_agent, updated_at)
        VALUES (${randomUUID()}::uuid, ${this.newTxnid()}, ${bookingId}::uuid, ${userId}::uuid, ${amountPaise}, 'INITIATED'::transaction_status,
                ${origin.ip}::text, ${origin.userAgent}::text, now())
        ON CONFLICT DO NOTHING
        RETURNING id, order_id, status, amount_paise`;
      const row = inserted[0];
      if (row) {
        return {
          transaction: {
            id: row.id,
            orderId: row.order_id,
            status: row.status,
            amountPaise: row.amount_paise,
          },
          created: true,
        };
      }

      const existing = await db.transaction.findUnique({
        where: { bookingId },
        select: { id: true, orderId: true, status: true, amountPaise: true },
      });
      if (existing) {
        if (!REUSABLE_TRANSACTION_STATUSES.includes(existing.status)) {
          throw new AppException(
            'BOOKING_NOT_PAYABLE',
            'A payment for this booking has already been started',
            HttpStatus.CONFLICT,
            {
              reason: 'PAYMENT_ALREADY_STARTED',
              status: existing.status,
            },
          );
        }
        return { transaction: existing, created: false };
      }
      this.logger.warn(
        `txnid collision on attempt ${attempt}; retrying with a new id`,
      );
    }
    throw new Error(
      `Could not allocate a unique txnid after ${MAX_TXNID_ATTEMPTS} attempts`,
    );
  }
}
