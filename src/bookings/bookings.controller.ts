import { Body, Controller, Header, Headers, HttpCode, HttpStatus, Post, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { AppCheckGuard } from '../auth/app-check.guard.js';
import { CurrentIdentity } from '../auth/current-identity.decorator.js';
import { FirebaseAuthGuard } from '../auth/firebase-auth.guard.js';
import type { VerifiedIdentity } from '../auth/identity-verifier.js';
import { IDEMPOTENCY_HEADER, parseIdempotencyKey } from '../common/idempotency/idempotency.js';
import { BookingCreateRateLimitGuard, IpRateLimitGuard } from '../common/rate-limit/rate-limit.guards.js';
import { ErrorEnvelopeDto } from '../users/users.dto.js';
import { CreateBookingRequestDto, CreateBookingResponseDto } from './bookings.dto.js';
import { BookingsService, type CreateBookingResponse } from './bookings.service.js';

/** Personal data: browsers and proxies must not keep a copy. */
const NO_STORE = 'no-store';
export const REPLAYED_HEADER = 'Idempotent-Replayed';

@ApiTags('bookings')
@Controller('v1')
export class BookingsController {
  constructor(private readonly bookings: BookingsService) {}

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
    @Res({ passthrough: true }) res: Response,
  ): Promise<CreateBookingResponse> {
    const key = parseIdempotencyKey(idempotencyKey);
    const { response, replayed } = await this.bookings.create(identity, key, body);
    if (replayed) res.setHeader(REPLAYED_HEADER, 'true');
    return response;
  }
}
