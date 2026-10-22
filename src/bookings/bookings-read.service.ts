import { HttpStatus, Injectable } from '@nestjs/common';
import type { VerifiedIdentity } from '../auth/identity-verifier.js';
import { AppException } from '../common/exceptions/app.exception.js';
import type { Prisma } from '../generated/prisma/client.js';
import { canPay } from '../payments/payable.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { UsersService } from '../users/users.service.js';
import { ACTIVE_STATUSES, encodeCursor, parseListQuery } from './bookings-list.js';

/** Our booking references look like `ED-7K3QXM`. Anything else cannot exist, so it never reaches a query. */
const REFERENCE_PATTERN = /^[A-Za-z0-9-]{1,32}$/;

export interface BookingListItem {
  reference: string;
  status: string;
  packageTitle: string;
  amountPaise: number;
  /** The payment record's status, or null before a payment was started. */
  paymentStatus: string | null;
  canPay: boolean;
  createdAt: string;
}

export interface BookingListResponse {
  items: BookingListItem[];
  nextCursor: string | null;
}

export interface BookingDetailResponse {
  booking: {
    reference: string;
    status: string;
    packageTitle: string;
    amountPaise: number;
    currency: string;
    name: string;
    whatsappNumber: string;
    email: string;
    age: number;
    city: string;
    gender: string | null;
    notes: string | null;
    canPay: boolean;
    payment: { orderId: string; status: string; mode: string | null; paidAt: string | null } | null;
    createdAt: string;
  };
}

/**
 * The read side: My Bookings and the booking detail (also what the payment status page polls). Reads never create anything:
 * a person without an account row has no bookings, so the list is empty and the detail is a 404. Only fields meant for the
 * person are selected; the sender address, user-agent, consent time, expert notes and internal ids never leave the database.
 */
@Injectable()
export class BookingsReadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly users: UsersService,
  ) {}

  async list(identity: VerifiedIdentity, query: unknown): Promise<BookingListResponse> {
    const parsed = parseListQuery(query);
    if (!parsed.ok) {
      throw new AppException('VALIDATION_FAILED', 'Some parameters need attention', HttpStatus.BAD_REQUEST, { fields: parsed.fields });
    }
    const { status, limit, after } = parsed.value;
    const userId = await this.users.findUserId(identity.uid);
    if (!userId) return { items: [], nextCursor: null };

    const where: Prisma.BookingWhereInput = { userId };
    if (status === 'active') where.status = { in: [...ACTIVE_STATUSES] };
    if (status === 'past') where.status = { notIn: [...ACTIVE_STATUSES] };
    // Keyset paging: everything strictly after the last row of the previous page in (created_at desc, id desc) order.
    if (after) where.OR = [{ createdAt: { lt: after.createdAt } }, { createdAt: after.createdAt, id: { lt: after.id } }];

    const rows = await this.prisma.booking.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: {
        id: true,
        reference: true,
        status: true,
        packageTitle: true,
        amountPaise: true,
        createdAt: true,
        transaction: { select: { status: true } },
      },
    });

    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => ({
        reference: row.reference,
        status: row.status,
        packageTitle: row.packageTitle,
        amountPaise: row.amountPaise,
        paymentStatus: row.transaction?.status ?? null,
        canPay: canPay(row.status, row.transaction?.status ?? null),
        createdAt: row.createdAt.toISOString(),
      })),
      nextCursor: rows.length > limit && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null,
    };
  }

  async detail(identity: VerifiedIdentity, reference: string): Promise<BookingDetailResponse> {
    const notFound = () => new AppException('BOOKING_NOT_FOUND', 'Booking not found', HttpStatus.NOT_FOUND);
    const userId = await this.users.findUserId(identity.uid);
    if (!userId || !REFERENCE_PATTERN.test(reference)) throw notFound();

    const row = await this.prisma.booking.findUnique({
      where: { reference },
      select: {
        userId: true,
        reference: true,
        status: true,
        packageTitle: true,
        amountPaise: true,
        currency: true,
        consulteeName: true,
        consulteeWhatsappNumber: true,
        consulteeEmail: true,
        consulteeAge: true,
        consulteeCity: true,
        consulteeGender: true,
        notes: true,
        createdAt: true,
        transaction: { select: { orderId: true, status: true, paymentMode: true, completedAt: true } },
      },
    });
    // Not yours and not existing look identical, so references cannot be probed.
    if (!row || row.userId !== userId) throw notFound();

    const payment = row.transaction;
    return {
      booking: {
        reference: row.reference,
        status: row.status,
        packageTitle: row.packageTitle,
        amountPaise: row.amountPaise,
        currency: row.currency,
        name: row.consulteeName,
        whatsappNumber: row.consulteeWhatsappNumber,
        email: row.consulteeEmail,
        age: row.consulteeAge,
        city: row.consulteeCity,
        gender: row.consulteeGender,
        notes: row.notes,
        canPay: canPay(row.status, payment?.status ?? null),
        payment: payment
          ? {
              orderId: payment.orderId,
              status: payment.status,
              mode: payment.paymentMode,
              // Only a payment PayU confirmed has a paid time; an escalated or failed one has a completion time but no payment.
              paidAt: payment.status === 'SUCCESS' && payment.completedAt ? payment.completedAt.toISOString() : null,
            }
          : null,
        createdAt: row.createdAt.toISOString(),
      },
    };
  }
}
