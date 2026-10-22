import { Controller, Get, Header, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOkResponse, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AppCheckGuard } from '../auth/app-check.guard.js';
import { CurrentIdentity } from '../auth/current-identity.decorator.js';
import { FirebaseAuthGuard } from '../auth/firebase-auth.guard.js';
import type { VerifiedIdentity } from '../auth/identity-verifier.js';
import { IpRateLimitGuard, UserRateLimitGuard } from '../common/rate-limit/rate-limit.guards.js';
import { ErrorEnvelopeDto, ProfileResponseDto } from './users.dto.js';
import { UsersService, type ProfileResponse } from './users.service.js';

/** Personal data: browsers and proxies must not keep a copy. */
const NO_STORE = 'no-store';

const RATE_LIMITED =
  'Too many requests: over 120 requests / minute from this address, or over 30 / minute for this person (sync and /me share that budget). `details.retryAfterSeconds` and the `Retry-After` header say when to retry.';
const UNAUTHENTICATED = '`UNAUTHENTICATED`: missing, malformed, expired or otherwise unacceptable login token (always the same answer).';

@ApiTags('auth')
@Controller('v1')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  /**
   * Guards run in order: per-address limit, App Check, login token, per-person limit. Each refuses before the next
   * spends any effort, and a refused call never reaches the handler.
   */
  @Post('auth/sync')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', NO_STORE)
  @UseGuards(IpRateLimitGuard, AppCheckGuard, FirebaseAuthGuard, UserRateLimitGuard)
  @ApiOperation({
    summary: 'Create or refresh the signed-in person profile',
    description:
      'Call right after every sign-in. Creates the user row on first sign-in, otherwise refreshes it in one atomic step: ' +
      'email follows the verified token (lower-cased); the name is taken from the token only while the stored name is empty; ' +
      '`authProvider` (first sign-up method) is never rewritten; `lastAuthProvider` and the last-login time are updated. ' +
      'Only Google and email-link sign-in are supported.',
  })
  @ApiBearerAuth('firebase-id-token')
  @ApiHeader({ name: 'X-Firebase-AppCheck', required: true, description: 'Firebase App Check token proving the call comes from the real web app.' })
  @ApiOkResponse({ type: ProfileResponseDto, description: 'The profile after the sync.' })
  @ApiResponse({ status: 400, type: ErrorEnvelopeDto, description: '`INVALID_EMAIL`: the verified email is not plain ASCII or not 3-254 characters.' })
  @ApiResponse({ status: 401, type: ErrorEnvelopeDto, description: UNAUTHENTICATED })
  @ApiResponse({
    status: 403,
    type: ErrorEnvelopeDto,
    description:
      '`APP_CHECK_FAILED` (missing or invalid App Check token), `EMAIL_NOT_VERIFIED` (token proven, email missing or unverified) or `UNSUPPORTED_SIGN_IN_PROVIDER` (a method other than Google or email link; nothing is created).',
  })
  @ApiResponse({ status: 429, type: ErrorEnvelopeDto, description: `\`RATE_LIMITED\`. ${RATE_LIMITED}` })
  @ApiResponse({
    status: 503,
    type: ErrorEnvelopeDto,
    description: '`AUTH_UNAVAILABLE` or `APP_CHECK_UNAVAILABLE`: Google could not be reached. Says nothing about the token; retry, do not sign the user out.',
  })
  sync(@CurrentIdentity() identity: VerifiedIdentity): Promise<ProfileResponse> {
    return this.users.syncFromIdentity(identity);
  }

  /** Called on every page load to restore the session. Login token only (no App Check, per the contract). */
  @Get('me')
  @Header('Cache-Control', NO_STORE)
  @UseGuards(IpRateLimitGuard, FirebaseAuthGuard, UserRateLimitGuard)
  @ApiOperation({
    summary: 'Get the signed-in person profile',
    description:
      'Read-only for an existing user: changes nothing, not even the last-login time. If the token is valid but the user row is missing it is created as `/auth/sync` would create it, with the same refusals. No App Check token needed.',
  })
  @ApiBearerAuth('firebase-id-token')
  @ApiOkResponse({ type: ProfileResponseDto, description: 'The stored profile.' })
  @ApiResponse({ status: 400, type: ErrorEnvelopeDto, description: '`INVALID_EMAIL` (only when the row had to be created).' })
  @ApiResponse({ status: 401, type: ErrorEnvelopeDto, description: UNAUTHENTICATED })
  @ApiResponse({
    status: 403,
    type: ErrorEnvelopeDto,
    description: '`EMAIL_NOT_VERIFIED` (token proven, email missing or unverified) or `UNSUPPORTED_SIGN_IN_PROVIDER` (only when the row had to be created).',
  })
  @ApiResponse({ status: 429, type: ErrorEnvelopeDto, description: `\`RATE_LIMITED\`. ${RATE_LIMITED}` })
  @ApiResponse({ status: 503, type: ErrorEnvelopeDto, description: '`AUTH_UNAVAILABLE`: Google could not be reached. Says nothing about the token; retry, do not sign the user out.' })
  me(@CurrentIdentity() identity: VerifiedIdentity): Promise<ProfileResponse> {
    return this.users.findOrCreateFromIdentity(identity);
  }
}
