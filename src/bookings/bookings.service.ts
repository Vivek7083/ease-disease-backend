import { randomUUID } from 'node:crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException } from '../common/exceptions/app.exception.js';
import { claimKey, hashRequest, saveResponse, type IdempotencyScope } from '../common/idempotency/idempotency.js';
import type { VerifiedIdentity } from '../auth/identity-verifier.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { UsersService } from '../users/users.service.js';
import { REFERENCE_ATTEMPTS, generateBookingReference } from './booking-reference.js';
import { parseCreateBooking, type CreateBookingInput } from './create-booking.js';

export const CREATE_BOOKING_ENDPOINT = 'POST /v1/bookings';

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
  canPay: true;
  payment: null;
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
  ) {}

  /**
   * `POST /v1/bookings`. Order: the form is checked first (cheap, no database), then the person is resolved, then ONE
   * transaction does everything else: claim the Idempotency-Key (or replay the original answer), read the package once
   * (its price and title are the snapshot; nothing price-like ever comes from the caller), insert the booking, and store
   * the answer on the key. The booking and its key row commit together or not at all.
   */
  async create(identity: VerifiedIdentity, idempotencyKey: string, body: unknown): Promise<CreateBookingResult> {
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

      const created = await this.insert(tx, user.id, pkg, input);
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
          canPay: true,
          payment: null,
        },
      };
      await saveResponse(tx, scope, response);
      return { response, replayed: false };
    });
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
  ): Promise<{ reference: string; currency: string }> {
    for (let attempt = 1; attempt <= REFERENCE_ATTEMPTS; attempt++) {
      const rows = await tx.$queryRaw<{ reference: string; currency: string }[]>`
        INSERT INTO bookings (
          id, reference, user_id, package_id, package_title, amount_paise,
          consultee_name, consultee_whatsapp_number, consultee_email, consultee_age, consultee_city, consultee_gender,
          notes, consent_at, updated_at
        ) VALUES (
          ${randomUUID()}::uuid, ${generateBookingReference()}, ${userId}::uuid, ${pkg.id}::uuid, ${pkg.title}, ${pkg.pricePaise},
          ${input.name}, ${input.whatsappNumber}, ${input.email}, ${input.age}, ${input.city}, ${input.gender}::text,
          ${input.notes}::text, now(), now()
        )
        ON CONFLICT (reference) DO NOTHING
        RETURNING reference, currency`;
      if (rows[0]) return rows[0];
    }
    throw new Error(`Could not allocate a unique booking reference after ${REFERENCE_ATTEMPTS} attempts`);
  }
}
