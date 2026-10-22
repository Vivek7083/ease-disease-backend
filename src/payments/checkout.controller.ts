import { Controller, Header, Headers, HttpCode, HttpStatus, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOkResponse, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { AppCheckGuard } from '../auth/app-check.guard.js';
import { CurrentIdentity } from '../auth/current-identity.decorator.js';
import { FirebaseAuthGuard, RequireFreshIdentity } from '../auth/firebase-auth.guard.js';
import type { VerifiedIdentity } from '../auth/identity-verifier.js';
import { AppException } from '../common/exceptions/app.exception.js';
import { requestOrigin } from '../common/http/request-origin.js';
import { IDEMPOTENCY_HEADER, REPLAYED_HEADER, parseIdempotencyKey } from '../common/idempotency/idempotency.js';
import { CheckoutRateLimitGuard, IpRateLimitGuard } from '../common/rate-limit/rate-limit.guards.js';
import { ErrorEnvelopeDto } from '../users/users.dto.js';
import { UsersService } from '../users/users.service.js';
import { CheckoutResponseDto } from './checkout.dto.js';
import { CheckoutService, type PublicCheckoutForm } from './checkout.service.js';

/** The form carries a payment hash and personal details: browsers and proxies must not keep a copy. */
const NO_STORE = 'no-store';

@ApiTags('payments')
@Controller('v1')
export class CheckoutController {
  constructor(
    private readonly checkout: CheckoutService,
    private readonly users: UsersService,
  ) {}

  /**
   * Guards run in order: per-address limit, App Check, login (this is the money route, so a revoked or disabled account is
   * refused even with an unexpired token), per-person hourly limit.
   */
  @Post('bookings/:reference/checkout')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', NO_STORE)
  @RequireFreshIdentity()
  @UseGuards(IpRateLimitGuard, AppCheckGuard, FirebaseAuthGuard, CheckoutRateLimitGuard)
  @ApiOperation({
    summary: 'Get the PayU payment form for a booking',
    description:
      'Returns the form the browser must post to PayU for one of the caller\'s own `PENDING_PAYMENT` bookings. PayU is sent the details typed on the booking (name, email and WhatsApp number), never the account\'s; a booking whose WhatsApp number is not an Indian mobile is paid with the business fallback phone. ' +
      'The booking\'s single payment record is created on the first call and reused afterwards. Send a fresh uuid v4 in `Idempotency-Key`: a repeat with the same key returns the same form (header `Idempotent-Replayed: true`) while the booking is still payable, and `409 BOOKING_NOT_PAYABLE` once it is not. ' +
      'The caller\'s address and user-agent are stored on the payment record as evidence and never returned.',
  })
  @ApiBearerAuth('firebase-id-token')
  @ApiHeader({ name: 'X-Firebase-AppCheck', required: true, description: 'Firebase App Check token proving the call comes from the real web app.' })
  @ApiHeader({ name: IDEMPOTENCY_HEADER, required: true, description: 'A unique uuid v4 per attempt to start a payment.' })
  @ApiParam({ name: 'reference', example: 'ED-7K3QXM', description: 'The booking reference.' })
  @ApiOkResponse({ type: CheckoutResponseDto, description: 'The form to post to PayU.' })
  @ApiResponse({ status: 400, type: ErrorEnvelopeDto, description: '`VALIDATION_FAILED`: missing or malformed `Idempotency-Key` header.' })
  @ApiResponse({ status: 401, type: ErrorEnvelopeDto, description: '`UNAUTHENTICATED`: missing, malformed, expired, revoked or otherwise unacceptable login token (always the same answer).' })
  @ApiResponse({
    status: 403,
    type: ErrorEnvelopeDto,
    description: '`APP_CHECK_FAILED` (missing or invalid App Check token) or `EMAIL_NOT_VERIFIED` (token proven, email missing or unverified).',
  })
  @ApiResponse({ status: 404, type: ErrorEnvelopeDto, description: '`BOOKING_NOT_FOUND`: no such booking, or it belongs to someone else (the same answer, so references cannot be probed).' })
  @ApiResponse({
    status: 409,
    type: ErrorEnvelopeDto,
    description:
      '`BOOKING_NOT_PAYABLE` (not `PENDING_PAYMENT`, or a payment was already started and decided), `PAYMENT_PHONE_UNSUPPORTED` (the WhatsApp number is not an Indian mobile and no fallback phone is configured) or `IDEMPOTENCY_CONFLICT` (this key was used for a different request).',
  })
  @ApiResponse({ status: 429, type: ErrorEnvelopeDto, description: '`RATE_LIMITED`: over 10 payment requests / hour for this person (repeats count), or over 120 / minute from this address. See `Retry-After`.' })
  @ApiResponse({ status: 503, type: ErrorEnvelopeDto, description: '`PAYMENT_GATEWAY_UNAVAILABLE` (payments not configured), `AUTH_UNAVAILABLE` or `APP_CHECK_UNAVAILABLE` (Google could not be reached). Retry.' })
  async create(
    @CurrentIdentity() identity: VerifiedIdentity,
    @Param('reference') reference: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PublicCheckoutForm> {
    const key = parseIdempotencyKey(idempotencyKey);
    // A person without an account row cannot own a booking: the same 404 as any booking that is not theirs.
    const userId = await this.users.findUserId(identity.uid);
    if (!userId) throw new AppException('BOOKING_NOT_FOUND', 'Booking not found', HttpStatus.NOT_FOUND);

    const { form, replayed } = await this.checkout.createCheckoutOnce({
      userId,
      bookingReference: reference,
      idempotencyKey: key,
      origin: requestOrigin(req),
    });
    if (replayed) res.setHeader(REPLAYED_HEADER, 'true');
    return form;
  }
}
