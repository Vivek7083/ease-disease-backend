import { Body, Controller, Get, Header, Headers, HttpCode, HttpStatus, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiHeader, ApiOkResponse, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { AppCheckGuard } from '../auth/app-check.guard.js';
import { CurrentIdentity } from '../auth/current-identity.decorator.js';
import { FirebaseAuthGuard } from '../auth/firebase-auth.guard.js';
import type { VerifiedIdentity } from '../auth/identity-verifier.js';
import { requestOrigin } from '../common/http/request-origin.js';
import { IDEMPOTENCY_HEADER, REPLAYED_HEADER, parseIdempotencyKey } from '../common/idempotency/idempotency.js';
import { BookingCreateRateLimitGuard, IpRateLimitGuard, ReadIpRateLimitGuard, ReadRateLimitGuard } from '../common/rate-limit/rate-limit.guards.js';
import { ErrorEnvelopeDto } from '../users/users.dto.js';
import { BookingDetailResponseDto, BookingListResponseDto, CreateBookingRequestDto, CreateBookingResponseDto } from './bookings.dto.js';
import { BookingsReadService, type BookingDetailResponse, type BookingListResponse } from './bookings-read.service.js';
import { BookingsService, type CreateBookingResponse } from './bookings.service.js';

/** Personal data: browsers and proxies must not keep a copy. */
const NO_STORE = 'no-store';

@ApiTags('bookings')
@Controller('v1')
export class BookingsController {
  constructor(
    private readonly bookings: BookingsService,
    private readonly reads: BookingsReadService,
  ) {}

  /** Guards run in order: per-address limit, App Check, login token, per-person hourly limit. */
  @Post('bookings')
  @HttpCode(HttpStatus.CREATED)
  @Header('Cache-Control', NO_STORE)
  @UseGuards(IpRateLimitGuard, AppCheckGuard, FirebaseAuthGuard, BookingCreateRateLimitGuard)
  @ApiOperation({
    summary: 'Create a booking from the assessment form',
    description:
      'Creates a `PENDING_PAYMENT` booking for the package, with the form details stored on the booking (they describe the person the consultation is for and may differ from the account; nothing is written back to the account). ' +
      'Send a fresh uuid v4 in `Idempotency-Key`: repeating the SAME request with the same key within 24 hours returns the original answer (header `Idempotent-Replayed: true`) and creates nothing; the same key with a different body is `409 IDEMPOTENCY_CONFLICT`. ' +
      'Only a successful answer is remembered, so after a failure you may fix the form and retry with the same key.',
  })
  @ApiBearerAuth('firebase-id-token')
  @ApiHeader({ name: 'X-Firebase-AppCheck', required: true, description: 'Firebase App Check token proving the call comes from the real web app.' })
  @ApiHeader({ name: IDEMPOTENCY_HEADER, required: true, description: 'A unique uuid v4 per attempt to create a booking.' })
  @ApiBody({ type: CreateBookingRequestDto })
  @ApiCreatedResponse({ type: CreateBookingResponseDto, description: 'The new booking (or, with `Idempotent-Replayed: true`, the answer to the identical earlier request).' })
  @ApiResponse({ status: 400, type: ErrorEnvelopeDto, description: '`VALIDATION_FAILED`: `details.fields` maps each bad field (or the `Idempotency-Key` header) to a message.' })
  @ApiResponse({ status: 401, type: ErrorEnvelopeDto, description: '`UNAUTHENTICATED`: missing, malformed, expired or otherwise unacceptable login token (always the same answer).' })
  @ApiResponse({
    status: 403,
    type: ErrorEnvelopeDto,
    description: '`APP_CHECK_FAILED` (missing or invalid App Check token) or `EMAIL_NOT_VERIFIED` (token proven, email missing or unverified).',
  })
  @ApiResponse({ status: 404, type: ErrorEnvelopeDto, description: '`PACKAGE_NOT_FOUND`: no such package.' })
  @ApiResponse({
    status: 409,
    type: ErrorEnvelopeDto,
    description: '`PACKAGE_NOT_ACTIVE` (the package exists but is not on sale) or `IDEMPOTENCY_CONFLICT` (this key was used with a different request).',
  })
  @ApiResponse({ status: 429, type: ErrorEnvelopeDto, description: '`RATE_LIMITED`: over 10 booking requests / hour for this person (repeats count), or over 120 / minute from this address. See `Retry-After`.' })
  @ApiResponse({ status: 503, type: ErrorEnvelopeDto, description: '`AUTH_UNAVAILABLE` or `APP_CHECK_UNAVAILABLE`: Google could not be reached. Says nothing about the token; retry.' })
  async create(
    @CurrentIdentity() identity: VerifiedIdentity,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CreateBookingResponse> {
    const key = parseIdempotencyKey(idempotencyKey);
    const { response, replayed } = await this.bookings.create(identity, key, body, requestOrigin(req));
    if (replayed) res.setHeader(REPLAYED_HEADER, 'true');
    return response;
  }
  /**
   * My Bookings. Login only (no App Check on reads). Reads have their own, larger limits because the payment status page
   * polls every 2 seconds: per address, login, per person.
   */
  @Get('bookings')
  @Header('Cache-Control', NO_STORE)
  @UseGuards(ReadIpRateLimitGuard, FirebaseAuthGuard, ReadRateLimitGuard)
  @ApiOperation({
    summary: 'List my bookings (My Bookings)',
    description:
      'The caller\'s own bookings, newest first. `active` = waiting for payment, confirmed or held for a human; `past` = every other status; `all` = everything. ' +
      'Page with `nextCursor`: pass it back as `cursor` until it is null. `canPay` says whether a payment form can be requested now.',
  })
  @ApiBearerAuth('firebase-id-token')
  @ApiQuery({ name: 'status', required: false, enum: ['active', 'past', 'all'], description: 'Default `active`.' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Whole number 1 to 50. Default 20.' })
  @ApiQuery({ name: 'cursor', required: false, type: String, description: 'The `nextCursor` of the previous page.' })
  @ApiOkResponse({ type: BookingListResponseDto, description: 'One page of bookings. An empty list when there are none.' })
  @ApiResponse({ status: 400, type: ErrorEnvelopeDto, description: '`VALIDATION_FAILED`: `details.fields` names each bad parameter.' })
  @ApiResponse({ status: 401, type: ErrorEnvelopeDto, description: '`UNAUTHENTICATED`: missing, malformed, expired or otherwise unacceptable login token (always the same answer).' })
  @ApiResponse({ status: 403, type: ErrorEnvelopeDto, description: '`EMAIL_NOT_VERIFIED`: token proven, email missing or unverified.' })
  @ApiResponse({ status: 429, type: ErrorEnvelopeDto, description: '`RATE_LIMITED`: over 120 reads / minute for this person or 600 / minute from this address. See `Retry-After`.' })
  @ApiResponse({ status: 503, type: ErrorEnvelopeDto, description: '`AUTH_UNAVAILABLE`: Google could not be reached. Says nothing about the token; retry.' })
  list(@CurrentIdentity() identity: VerifiedIdentity, @Query() query: unknown): Promise<BookingListResponse> {
    return this.reads.list(identity, query);
  }

  /** One booking, also polled by the payment status page. A booking that is not the caller's is a 404, never a 403. */
  @Get('bookings/:reference')
  @Header('Cache-Control', NO_STORE)
  @UseGuards(ReadIpRateLimitGuard, FirebaseAuthGuard, ReadRateLimitGuard)
  @ApiOperation({
    summary: 'Get one of my bookings',
    description:
      'The booking with the details typed on the form, `canPay`, and the payment (`null` before one was started; `paidAt` only for a payment PayU confirmed). ' +
      'The payment status page polls this every 2 seconds, up to 60 seconds, until the status is final.',
  })
  @ApiBearerAuth('firebase-id-token')
  @ApiParam({ name: 'reference', example: 'ED-7K3QXM', description: 'The booking reference.' })
  @ApiOkResponse({ type: BookingDetailResponseDto, description: 'The booking.' })
  @ApiResponse({ status: 401, type: ErrorEnvelopeDto, description: '`UNAUTHENTICATED`: missing, malformed, expired or otherwise unacceptable login token (always the same answer).' })
  @ApiResponse({ status: 403, type: ErrorEnvelopeDto, description: '`EMAIL_NOT_VERIFIED`: token proven, email missing or unverified.' })
  @ApiResponse({ status: 404, type: ErrorEnvelopeDto, description: '`BOOKING_NOT_FOUND`: no such booking, or it belongs to someone else (the same answer, so references cannot be probed).' })
  @ApiResponse({ status: 429, type: ErrorEnvelopeDto, description: '`RATE_LIMITED`: over 120 reads / minute for this person or 600 / minute from this address. See `Retry-After`.' })
  @ApiResponse({ status: 503, type: ErrorEnvelopeDto, description: '`AUTH_UNAVAILABLE`: Google could not be reached. Says nothing about the token; retry.' })
  detail(@CurrentIdentity() identity: VerifiedIdentity, @Param('reference') reference: string): Promise<BookingDetailResponse> {
    return this.reads.detail(identity, reference);
  }
}
