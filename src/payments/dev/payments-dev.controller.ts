import { randomBytes, randomUUID } from 'node:crypto';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBody, ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import { AppException } from '../../common/exceptions/app.exception.js';
import { DevelopmentOnlyGuard } from '../../common/guards/development-only.guard.js';
import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { CheckoutService } from '../checkout.service.js';
import { PayuClient, PayuGatewayError } from '../payu/payu-client.js';
import type { CheckoutForm } from '../payu/payu-checkout-fields.js';
import { checkoutPageCsp, renderCheckoutPage } from './checkout-page.js';

const REFERENCE_PATTERN = /^[A-Za-z0-9-]{1,32}$/;
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const MAX_REFERENCE_ATTEMPTS = 5;

const E164_PATTERN = /^\+[1-9][0-9]{7,14}$/;
const FIXTURE_EMAIL_PATTERN = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
/** Fixed values for the form fields the fixture user does not have. */
const FIXTURE_CONSULTEE_AGE = 34;
const FIXTURE_CONSULTEE_CITY = 'Bengaluru';

const fixtureBody = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    // The booking copies these into its `consultee_*` columns, which the database constrains (E.164 number,
    // lower-case email within PayU's 50-character rule), so the same shapes are required here.
    email: z.string().trim().max(50).regex(FIXTURE_EMAIL_PATTERN, 'Email is not in a form PayU accepts').optional(),
    phone: z.string().trim().regex(E164_PATTERN, 'Phone must be E.164, e.g. +919876543210').optional(),
  })
  .strict();

const notFound = () =>
  new AppException(
    'BOOKING_NOT_FOUND',
    'Booking not found',
    HttpStatus.NOT_FOUND,
  );
const randomChars = (count: number) =>
  Array.from(randomBytes(count), (byte) => ALPHABET[byte % 32]).join('');

/**
 * DEVELOPMENT ONLY (404 everywhere else). Lets a developer try the real PayU test checkout without a login or a
 * booking flow: create a fixture booking, get its checkout form (as JSON or as a page that posts it to PayU), and
 * watch what the callback and webhook did. Not part of the locked API contract.
 */
@ApiTags('dev (development only)')
@Controller('dev/payu')
@UseGuards(DevelopmentOnlyGuard)
export class PaymentsDevController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaClient,
    private readonly checkout: CheckoutService,
    @Inject(PayuClient)
    private readonly payu: Pick<PayuClient, 'verifyPayment'>,
  ) {}

  @Post('fixture-booking')
  @ApiOperation({
    summary:
      'Create a fixture user and an unpaid booking for the launch package',
    description:
      'Priced from the seeded package (run `npm run seed` first). Returns the reference to use in the other dev endpoints.',
  })
  @ApiBody({
    required: false,
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string', example: 'Dev Tester' },
        email: { type: 'string', example: 'dev.tester@example.com' },
        phone: { type: 'string', example: '+919876543210' },
      },
    },
  })
  async createFixtureBooking(@Body() body: unknown) {
    const parsed = fixtureBody.safeParse(body ?? {});
    if (!parsed.success) {
      const fields = Object.fromEntries(
        parsed.error.issues.map((issue) => [
          issue.path.join('.') || '_',
          issue.message,
        ]),
      );
      throw new AppException(
        'VALIDATION_FAILED',
        'Invalid fixture details',
        HttpStatus.BAD_REQUEST,
        { fields },
      );
    }
    const pkg = await this.prisma.package.findFirst({
      where: { isActive: true },
      orderBy: { createdAt: 'asc' },
    });
    if (!pkg) {
      throw new AppException(
        'NO_PACKAGE',
        'No active package exists. Run `npm run seed` first.',
        HttpStatus.CONFLICT,
      );
    }

    const {
      name = 'Dev Tester',
      email = `dev-${randomChars(6).toLowerCase()}@example.com`,
      phone = '+919876543210',
    } = parsed.data;
    const user = await this.prisma.user.create({
      data: {
        firebaseUid: `dev_fixture_${randomUUID()}`,
        email,
        name,
        phone,
        authProvider: 'google.com',
        lastAuthProvider: 'google.com',
      },
    });

    for (let attempt = 1; attempt <= MAX_REFERENCE_ATTEMPTS; attempt++) {
      const reference = `ED-${randomChars(6)}`;
      try {
        const booking = await this.prisma.booking.create({
          data: {
            reference,
            userId: user.id,
            packageId: pkg.id,
            packageTitle: pkg.title,
            amountPaise: pkg.pricePaise,
            consulteeName: name,
            consulteeWhatsappNumber: phone,
            consulteeEmail: email.toLowerCase(),
            consulteeAge: FIXTURE_CONSULTEE_AGE,
            consulteeCity: FIXTURE_CONSULTEE_CITY,
            consentAt: new Date(),
          },
          select: {
            reference: true,
            status: true,
            amountPaise: true,
            packageTitle: true,
          },
        });
        return {
          ...booking,
          userId: user.id,
          next: [
            `POST /dev/payu/checkout-fields/${reference}`,
            `GET /dev/payu/checkout-page/${reference}`,
          ],
        };
      } catch (error) {
        const taken =
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002';
        if (!taken || attempt === MAX_REFERENCE_ATTEMPTS) throw error;
      }
    }
    throw new Error('unreachable');
  }

  @Post('checkout-fields/:reference')
  @ApiOperation({
    summary:
      'The PayU checkout form for a booking, as JSON (creates or reuses its transaction)',
  })
  checkoutFields(@Param('reference') reference: string): Promise<CheckoutForm> {
    return this.createForm(reference);
  }

  @Get('checkout-page/:reference')
  @ApiOperation({
    summary:
      "Open in a browser: posts the checkout form to PayU's test payment page",
    description: 'Needs test credentials loaded via PUT /dev/payu/credentials.',
  })
  @ApiProduces('text/html')
  async checkoutPage(
    @Param('reference') reference: string,
    @Res() res: Response,
  ): Promise<void> {
    const form = await this.createForm(reference);
    const nonce = randomBytes(16).toString('base64url');
    res
      .status(HttpStatus.OK)
      .type('text/html; charset=utf-8')
      .setHeader('Content-Security-Policy', checkoutPageCsp(nonce))
      .setHeader('Cache-Control', 'no-store')
      .setHeader('Referrer-Policy', 'no-referrer')
      .setHeader('X-Content-Type-Options', 'nosniff')
      .send(renderCheckoutPage(form, { reference }, nonce));
  }

  @Get('bookings/:reference')
  @ApiOperation({
    summary:
      'What happened: booking, transaction, payment events and queued alerts',
  })
  async status(@Param('reference') reference: string) {
    if (!REFERENCE_PATTERN.test(reference)) throw notFound();
    const booking = await this.prisma.booking.findUnique({
      where: { reference },
      include: {
        transaction: {
          include: { events: { orderBy: { receivedAt: 'asc' }, take: 50 } },
        },
      },
    });
    if (!booking) throw notFound();
    const outbox = await this.prisma.outbox.findMany({
      where: { payload: { path: ['bookingId'], equals: booking.id } },
      orderBy: { createdAt: 'asc' },
    });
    const { transaction, ...bookingFields } = booking;
    return { booking: bookingFields, transaction, outbox };
  }

  @Post('verify/:reference')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Ask PayU what it knows about this booking's transaction right now (read-only, changes nothing)",
    description:
      'Calls PayU verify_payment with the loaded test credentials. Use it to see a payment that is still pending at PayU, or one whose browser return never reached us. It does NOT update our booking or transaction.',
  })
  async verify(@Param('reference') reference: string) {
    if (!REFERENCE_PATTERN.test(reference)) throw notFound();
    const booking = await this.prisma.booking.findUnique({
      where: { reference },
      select: {
        status: true,
        transaction: { select: { orderId: true, status: true } },
      },
    });
    if (!booking) throw notFound();
    if (!booking.transaction) {
      throw new AppException(
        'NO_TRANSACTION',
        'This booking has no transaction yet: open its checkout page first',
        HttpStatus.CONFLICT,
      );
    }
    try {
      const payu = await this.payu.verifyPayment(booking.transaction.orderId);
      return {
        reference,
        orderId: booking.transaction.orderId,
        ourTransactionStatus: booking.transaction.status,
        ourBookingStatus: booking.status,
        payu,
      };
    } catch (error) {
      if (error instanceof PayuGatewayError) {
        throw new AppException(
          'PAYMENT_GATEWAY_UNAVAILABLE',
          error.message,
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }
      throw error;
    }
  }

  private async createForm(reference: string): Promise<CheckoutForm> {
    if (!REFERENCE_PATTERN.test(reference)) throw notFound();
    const booking = await this.prisma.booking.findUnique({
      where: { reference },
      select: { userId: true },
    });
    if (!booking) throw notFound();
    // The dev tooling acts as the booking's own user; the real endpoint will use the authenticated user.
    return this.checkout.createCheckout({
      userId: booking.userId,
      bookingReference: reference,
    });
  }
}
