import { randomUUID } from 'node:crypto';
import { HttpStatus, Inject, Injectable, Optional } from '@nestjs/common';
import { AppException } from '../common/exceptions/app.exception.js';
import type { RequestOrigin } from '../common/http/request-origin.js';
import { claimKey, hashRequest, saveResponse, type IdempotencyScope } from '../common/idempotency/idempotency.js';
import type { VerifiedIdentity } from '../auth/identity-verifier.js';
import type { Prisma } from '../generated/prisma/client.js';
import { canPay } from '../payments/payable.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { UsersService } from '../users/users.service.js';
import { istDayStart, istNextDayStart } from './booking-day.js';
import { REFERENCE_ATTEMPTS, generateBookingReference } from './booking-reference.js';
import { parseCreateBooking, type CreateBookingInput } from './create-booking.js';

export const CREATE_BOOKING_ENDPOINT = 'POST /v1/bookings';
/** Injection token for the clock, so tests can say what time it is. */
export const BOOKING_CLOCK = Symbol('BOOKING_CLOCK');
/** api-flow.md section 4: at most 5 unpaid bookings, and at most 5 bookings confirmed per India calendar day, per person. */
export const PENDING_BOOKING_LIMIT = 5;
export const DAILY_CONFIRMED_LIMIT = 5;

/** What the API returns about a booking right after it is created (api-flow.md section 4). */
export interface BookingView {
  reference: string;
  status: 'PENDING_PAYMENT';
  packageTitle: string;
  amountPaise: number;
  currency: string;
  name: string;
  whatsappNumber: string;
  email: string;
  age: number;
  city: string;
  gender: string | null;
  canPay: boolean;
  payment: null;
  createdAt: string;
}

export interface CreateBookingResponse {
  booking: BookingView;
}

export interface CreateBookingResult {
  response: CreateBookingResponse;
  /** True when this is the stored answer to an earlier identical request, not a new booking. */
  replayed: boolean;
}

@Injectable()
export class BookingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly users: UsersService,
    @Optional()
    @Inject(BOOKING_CLOCK)
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * `POST /v1/bookings`. Order: the form is checked first (cheap, no database), then the person is resolved, then ONE
   * transaction does everything else: claim the Idempotency-Key (or replay the original answer), read the package once
   * (its price and title are the snapshot; nothing price-like ever comes from the caller), insert the booking, and store
   * the answer on the key. The booking and its key row commit together or not at all. The sender's address and user-agent are
   * stored on the booking as chargeback evidence (not part of the idempotency hash, never returned).
   */
  async create(identity: VerifiedIdentity, idempotencyKey: string, body: unknown, origin: RequestOrigin): Promise<CreateBookingResult> {
    const parsed = parseCreateBooking(body);
    if (!parsed.ok) {
      throw new AppException('VALIDATION_FAILED', 'Some fields need attention', HttpStatus.BAD_REQUEST, { fields: parsed.fields });
    }
    const input = parsed.value;
    // The account row is found (or created, as GET /v1/me would) before the transaction, so it stays short.
    const { user } = await this.users.findOrCreateFromIdentity(identity);
    const scope: IdempotencyScope = { key: idempotencyKey, userId: user.id, endpoint: CREATE_BOOKING_ENDPOINT };
    const requestHash = hashRequest(input);

    return this.prisma.$transaction(async (tx) => {
      const claim = await claimKey(tx, scope, requestHash);
      if (claim.kind === 'replay') return { response: claim.response as CreateBookingResponse, replayed: true };

      const pkg = await tx.package.findUnique({
        where: { id: input.packageId },
        select: { id: true, title: true, pricePaise: true, isActive: true },
      });
      if (!pkg) throw new AppException('PACKAGE_NOT_FOUND', 'Package not found', HttpStatus.NOT_FOUND);
      if (!pkg.isActive) throw new AppException('PACKAGE_NOT_ACTIVE', 'This package is not available for booking', HttpStatus.CONFLICT);

      await this.enforceCaps(tx, user.id);

      const created = await this.insert(tx, user.id, pkg, input, origin);
      const response: CreateBookingResponse = {
        booking: {
          reference: created.reference,
          status: 'PENDING_PAYMENT',
          packageTitle: pkg.title,
          amountPaise: pkg.pricePaise,
          currency: created.currency,
          name: input.name,
          whatsappNumber: input.whatsappNumber,
          email: input.email,
          age: input.age,
          city: input.city,
          gender: input.gender,
          // A new booking has no payment record yet.
          canPay: canPay('PENDING_PAYMENT', null),
          payment: null,
          createdAt: created.createdAt.toISOString(),
        },
      };
      await saveResponse(tx, scope, response);
      return { response, replayed: false };
    });
  }

  /**
   * The two caps, checked under a per-person lock. The lock is what makes them hold when many requests arrive at once: no
   * unique index can say "at most 5 rows", so without it ten simultaneous requests at 4 pending would all count 4 and all
   * insert. It is released when the transaction ends; people never wait for each other. Pending is checked first.
   * `NEEDS_ATTENTION` bookings count toward neither cap, and a booking that later became COMPLETED / CANCELLED / NO_SHOW
   * still counts for the day it was confirmed (`confirmed_at` is never cleared).
   */
  private async enforceCaps(tx: Prisma.TransactionClient, userId: string): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 0))`;

    const pending = await tx.booking.count({ where: { userId, status: 'PENDING_PAYMENT' } });
    if (pending >= PENDING_BOOKING_LIMIT) {
      throw new AppException('TOO_MANY_PENDING_BOOKINGS', 'You already have the maximum number of unpaid bookings', HttpStatus.CONFLICT, {
        limit: PENDING_BOOKING_LIMIT,
      });
    }

    const now = this.now();
    const confirmedToday = await tx.booking.count({
      where: { userId, confirmedAt: { gte: istDayStart(now), lt: istNextDayStart(now) } },
    });
    if (confirmedToday >= DAILY_CONFIRMED_LIMIT) {
      throw new AppException('DAILY_BOOKING_LIMIT', 'You have reached the daily booking limit', HttpStatus.CONFLICT, {
        limit: DAILY_CONFIRMED_LIMIT,
      });
    }
  }

  /**
   * Inserts the row with a fresh reference. `ON CONFLICT DO NOTHING` instead of catching a unique violation, because a
   * violation would abort the whole transaction (the idempotency row with it).
   */
  private async insert(
    tx: Prisma.TransactionClient,
    userId: string,
    pkg: { id: string; title: string; pricePaise: number },
    input: CreateBookingInput,
    origin: RequestOrigin,
  ): Promise<{ reference: string; currency: string; createdAt: Date }> {
    for (let attempt = 1; attempt <= REFERENCE_ATTEMPTS; attempt++) {
      const rows = await tx.$queryRaw<{ reference: string; currency: string; created_at: Date }[]>`
        INSERT INTO bookings (
          id, reference, user_id, package_id, package_title, amount_paise,
          consultee_name, consultee_whatsapp_number, consultee_email, consultee_age, consultee_city, consultee_gender,
          notes, consent_at, created_ip, created_user_agent, updated_at
        ) VALUES (
          ${randomUUID()}::uuid, ${generateBookingReference()}, ${userId}::uuid, ${pkg.id}::uuid, ${pkg.title}, ${pkg.pricePaise},
          ${input.name}, ${input.whatsappNumber}, ${input.email}, ${input.age}, ${input.city}, ${input.gender}::text,
          ${input.notes}::text, now(), ${origin.ip}::text, ${origin.userAgent}::text, now()
        )
        ON CONFLICT (reference) DO NOTHING
        RETURNING reference, currency, created_at`;
      const row = rows[0];
      if (row) return { reference: row.reference, currency: row.currency, createdAt: row.created_at };
    }
    throw new Error(`Could not allocate a unique booking reference after ${REFERENCE_ATTEMPTS} attempts`);
  }
}
