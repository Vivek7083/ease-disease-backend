import {
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppException } from '../common/exceptions/app.exception.js';
import type { Env } from '../config/env.schema.js';
import { Prisma, type PrismaClient } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  CheckoutFieldError,
  buildCheckoutFields,
  cleanPhone,
  validateEmail,
  type CheckoutForm,
} from './payu/payu-checkout-fields.js';
import { PayuCredentialsProvider } from './payu/payu-credentials.provider.js';
import { generateTxnid } from './payu/payu-txnid.js';

export const TXNID_GENERATOR = Symbol('TXNID_GENERATOR');
export const DEFAULT_API_PUBLIC_URL = 'http://localhost:3000';

const MAX_TXNID_ATTEMPTS = 5;
/** Our booking references look like `ED-7K3QXM`. Anything else cannot exist, so it never reaches a query. */
const REFERENCE_PATTERN = /^[A-Za-z0-9-]{1,32}$/;

/** The only transaction states in which a checkout may be (re)issued: nothing has been decided at PayU yet. */
const REUSABLE_TRANSACTION_STATUSES = ['CREATED', 'INITIATED'];

export interface CreateCheckoutInput {
  /** The authenticated user. Ownership is enforced here so no endpoint can forget it. */
  userId: string;
  bookingReference: string;
}

/**
 * Turns a booking into the form the browser posts to PayU, creating the booking's single transaction the
 * first time and reusing it afterwards. Idempotent: a repeat, a double-click or two simultaneous first
 * clicks all end with the same transaction and the same txnid. Every value that is hashed and sent comes
 * from the database (the booking's own price snapshot), never from the caller.
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

  async createCheckout({
    userId,
    bookingReference,
  }: CreateCheckoutInput): Promise<CheckoutForm> {
    // A malformed reference (including NUL bytes, which Postgres rejects) is simply a booking that does not exist.
    const booking = REFERENCE_PATTERN.test(bookingReference)
      ? await this.prisma.booking.findUnique({
          where: { reference: bookingReference },
          select: {
            id: true,
            reference: true,
            userId: true,
            status: true,
            packageTitle: true,
            /** The booking's own price snapshot: the only source of the amount. */
            amountPaise: true,
            user: { select: { name: true, email: true, phone: true } },
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

    // Not yours and not existing look identical, so references cannot be probed.
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

    // Everything that can be wrong with the customer's data is checked BEFORE anything is written.
    if (!booking.user.phone) {
      throw new AppException(
        'PROFILE_INCOMPLETE',
        'Add a phone number to your profile before paying',
        HttpStatus.CONFLICT,
      );
    }
    this.validateCustomer(booking.user.email, booking.user.phone);
    const creds = this.credentials.get(); // 503 when payments are not configured, before any write

    const { transaction, created } = booking.transaction
      ? { transaction: booking.transaction, created: false }
      : await this.createOrAdopt(booking.id, userId, booking.amountPaise);

    const form = buildCheckoutFields({
      creds,
      txnid: transaction.orderId,
      amountPaise: transaction.amountPaise,
      productTitle: booking.packageTitle,
      customerName: booking.user.name,
      email: booking.user.email,
      phone: booking.user.phone,
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
    return form;
  }

  private validateCustomer(email: string, phone: string): void {
    const fields: Record<string, string> = {};
    for (const [field, check] of [
      ['email', () => validateEmail(email)],
      ['phone', () => cleanPhone(phone)],
    ] as const) {
      try {
        check();
      } catch (error) {
        if (!(error instanceof CheckoutFieldError)) throw error;
        fields[field] = error.message;
      }
    }
    if (Object.keys(fields).length > 0) {
      throw new AppException(
        'VALIDATION_FAILED',
        'Your profile details cannot be sent to the payment gateway',
        HttpStatus.BAD_REQUEST,
        { fields },
      );
    }
  }

  /**
   * Creates the booking's transaction, or adopts the one a simultaneous request created first. A unique
   * violation has two possible causes, told apart by looking again: the booking already has a transaction
   * (we lost a race: use it), or the random txnid collided with another booking's (try a new one).
   */
  private async createOrAdopt(
    bookingId: string,
    userId: string,
    amountPaise: number,
  ) {
    for (let attempt = 1; attempt <= MAX_TXNID_ATTEMPTS; attempt++) {
      try {
        const transaction = await this.prisma.transaction.create({
          data: {
            orderId: this.newTxnid(),
            bookingId,
            userId,
            amountPaise,
            status: 'INITIATED',
          },
          select: { id: true, orderId: true, status: true, amountPaise: true },
        });
        return { transaction, created: true };
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        const existing = await this.prisma.transaction.findUnique({
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
    }
    throw new Error(
      `Could not allocate a unique txnid after ${MAX_TXNID_ATTEMPTS} attempts`,
    );
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}
